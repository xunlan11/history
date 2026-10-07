# history deployment

Deployment assets for the `history` data site and its remote OCR/LLM machine.
The data host stores SQLite data and uploaded files; the remote host runs the
OCR and LLM models. See the runtime layout below for hosts and ports.

## Runtime layout

| Component | Host | Port | Asset |
| --- | --- | ---: | --- |
| History data API | data host | 8665 | `data/history-data.service` |
| History OCR orchestration | data host | 8765 | `data/history-ocr.service` |
| History LLM API | data host | 8865 | `data/history-llm.service` |
| Literature data API | data host | 18665 | `data/literature.service` |
| Literature OCR orchestration | data host | 18765 | `data/literature-ocr.service` |
| PaddleX OCR | remote host | 8080 | `service/history-ocr.service` |
| Ollama / Qwen3-8B | remote host | 11434 | `service/history-llm.service` |
| SSH reverse tunnel | remote host | 18080, 11435 on data host | `service/history-tunnel.service` |

The data host reaches the model host through the tunnel:

- `127.0.0.1:18080` -> remote `127.0.0.1:8080`
- `127.0.0.1:11435` -> remote `127.0.0.1:11434`

## Data host

### Installation

From the repository root:

```bash
cd history
uv sync
mkdir -p ~/.config/systemd/user
cp deploy/data/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now history-data history-ocr history-llm
systemctl --user enable --now literature literature-ocr
```

The data services use `/home/ubuntu/Codefield/history` as their working
directory. Their persistent data lives outside this directory:

- `history/storage/`
- `history/ocr-storage/`
- `/home/ubuntu/Codefield/literature/`

### Configuration

Data-host units must set:

```ini
OCR_UPSTREAM_URL=http://127.0.0.1:18080
OCR_UPSTREAM_STYLE=paddlex
OCR_UPSTREAM_TIMEOUT=300
LLM_API_BASE=http://127.0.0.1:11435/v1
LLM_MODEL=qwen3:8b
LLM_TIMEOUT_SECONDS=600
```

When the data host and the model host are on the same intranet, the tunnel is
not needed; point the data host directly at the model host:

```ini
OCR_UPSTREAM_URL=http://10.134.194.183:8080
LLM_API_BASE=http://10.134.194.183:11434/v1
```

### Behavior and expectations

The data host runs no OCR or LLM models. The former local Ollama install
(service, 4.9 GB of models, binary) and the `~/.paddlex` cache were removed on
2026-09-16, and the dependencies no longer include paddleocr / paddlepaddle /
paddlex. With the tunnel down, OCR returns HTTP 503 and the LLM `/health`
reports `ready=false`; this is expected.

OCR calls `POST /layout-parsing` on the remote PaddleX service. Requests contain
a base64 image in JSON; the response must contain
`result.layoutParsingResults[0]`, with text in `prunedResult` or `markdown`. If
the upstream is missing or unreachable, OCR reports `ready: false` or HTTP 503.
The LLM service uses the OpenAI-compatible `/v1` API and requires the `qwen3:8b`
model.

The OCR orchestration service accepts a task immediately and returns its task ID
before processing begins. Tasks are processed one at a time; later tasks remain
in `排队中` and the browser polls the task endpoint until processing starts, then
continuously updates the reader progress display. Do not start a second data or
OCR service manually on the same port; use the corresponding systemd unit.

## Remote host

The remote host runs PaddleX PP-StructureV3 (`8080`) and Ollama + Qwen3-8B
(`11434`). It stores no platform data and does not need this repository's code;
it only has to expose HTTP to the data host. OCR runs fine on CPU; the LLM also
runs on CPU (~4.9 tok/s) but a GPU is preferred (with 6 GB VRAM, Qwen3-8B
measured 28-31 tok/s).

### Installation

Copy the remote assets from this repository to `~/history-service/`:

```text
deploy/service/PP-StructureV3-cpu.yaml
deploy/service/Modelfile.qwen3-8b
deploy/service/history-ocr.service
deploy/service/history-llm.service
deploy/service/history-tunnel.service
```

The OCR and Ollama binaries, virtual environments, model files, and logs are
also expected under `~/history-service/` as referenced by the units.

Install the two model services and the tunnel:

```bash
mkdir -p ~/.config/systemd/user
cp ~/history-service/deploy/service/history-ocr.service ~/.config/systemd/user/
cp ~/history-service/deploy/service/history-llm.service ~/.config/systemd/user/
cp ~/history-service/deploy/service/history-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now history-ocr history-llm history-tunnel
```

The tunnel unit must point to the current data host and use the configured
`~/.ssh/cloud-tunnel` key. Change its SSH destination before enabling it when
the data host address changes.

## Tunnel

The remote host must be able to SSH to the data host using the dedicated key
referenced by `service/history-tunnel.service`. The key on the data host must
allow reverse forwarding only to `127.0.0.1:18080` and `127.0.0.1:11435`.
Keep both reverse forwards bound to loopback; do not expose them publicly.

If the tunnel is active but health checks fail:

1. On the remote host, check `history-ocr` and `history-llm`.
2. On the data host, check ports `18080` and `11435`.
3. Check `journalctl --user -u history-tunnel.service`.
4. Restart the tunnel only after confirming the remote model services are up.

## Verification

On the data host:

```bash
curl -s http://127.0.0.1:8665/health
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8865/health
curl -s http://127.0.0.1:18080/health
curl -s http://127.0.0.1:11435/v1/models
```

Expected results:

- data API reports `status: ok`;
- OCR reports `ready: true`;
- LLM reports `ready: true` and model `qwen3:8b`;
- the tunnel endpoints respond successfully.

## Migration notes

- Copy `deploy/` with the repository.
- Do not copy `.venv/`, `storage/`, `ocr-storage/`, or `.deploy/`.
- Restore the data directories separately.
- Keep the five data-host units and three remote-host units.
- `fetch-assets.py` downloads the remote OCR/Ollama assets when rebuilding the
  remote host.

## Backend document scheduling

The data API owns a durable SQLite queue (`processing_jobs`) shared by all users
of that data site. No extra model, broker, dependency or standalone scheduler
service is needed. The scheduler starts with `service.data:app`; a process-lifetime
OS lock beside the database allows only one active worker, with automatic
lock takeover if the worker process exits. The queue remains in SQLite.

Source upload now requires a saved, owned document record. Archiving the source
and reserving its FIFO queue sequence happen in the same database transaction:
closing the browser immediately after the upload does not stop registration.
Repeated submission returns the same real task and cannot change its mode or
replace its source. A missing source never creates a placeholder backend task.

Registration preparation (cover + first-page metadata) has priority over body
work. The scheduler stops dispatching new body operations and drains any
in-flight page calls before preparing new registrations. Saved body progress is
retained; after registration is saved, its body waits behind earlier documents.
An earlier document waiting for registration/service recovery also retains its
reserved order; later registrations may be prepared but cannot start body ahead
of it. A permanently failed document releases the queue until explicitly retried.

Both registration forms default to **serial**; users can choose **parallel**.
The archived submission freezes that choice. Serial performs OCR + LLM for one
page before advancing. Parallel uses independent OCR/LLM lanes, so OCR may lead
LLM by any number of pages. Both use the existing `/llm/finalize-page` contract,
prompt and the two most recent successful preceding pages as context. The next
document starts only after OCR, LLM and result persistence have all finished.
The browser only uploads, submits and reads states; it runs no body LLM queue.

Checkpoint state, page images, OCR output, finalized text and registration
results are durable. OCR page images are archived before recognition, so failed
OCR pages can still be reviewed. The LLM API now reports `errorKind`:
`unavailable` waits/retries automatically without consuming a failure budget;
`processing` is an ordinary error with a maximum of three attempts. OCR's typed
upstream error codes are similarly classified: protocol/bad-file errors are not
mistaken for service outages. Page failures are marked for human review and
later pages continue. Registration/whole-source failures stop that document
instead of waiting indefinitely for service recovery. Removing a marked failed
page requires confirmation and never deletes its archived source.

### Deploy on the data host, not a code-only workstation

Deploy the frontend and `service/data.py`, `service/scheduler.py`,
`service/ocr.py` and `service/llm.py` together. Restart the data APIs as well as
the existing OCR/LLM orchestration APIs on the data host. The remote model host
needs no code/model changes. The new queue table is created additively on data
API startup; do not clear documents, databases or assets. Restoring a full ZIP
backup retains the queue/checkpoints and relative asset paths. JSON document
exports are not scheduler backups; use the full SQLite + files backup for
process recovery and migration.

The updated data-host unit files set the correct OCR API for each isolated site:

| Unit | OCR API | LLM API |
| --- | --- | --- |
| `history-data` | `http://127.0.0.1:8765` | `http://127.0.0.1:8865` |
| `literature` | `http://127.0.0.1:18765` | `http://127.0.0.1:8865` |

Optional environment settings on the data API:

```ini
PROCESSING_SCHEDULER_ENABLED=true
PROCESSING_RETRY_SECONDS=10
PROCESSING_HTTP_TIMEOUT_SECONDS=1000
```

`PROCESSING_OCR_URL` and `PROCESSING_LLM_URL` point to orchestration APIs on
the data host, **not** directly to PaddleX/Ollama. Server-to-server timeout must
allow three registration OCR calls (currently 300 seconds each) and LLM inference
(currently 600 seconds). The browser no longer holds long recognition requests
open. Missing models/configuration, HTTP 429/502/503/504 and network outages are
retryable; ordinary bad results have bounded retries. Each site's queue is
isolated by its configured database, as before; this is not a cross-site queue.

### Production acceptance

Before production acceptance, exercise two users uploading concurrently, close the
browser during registration/body processing, interrupt OCR and LLM independently,
restart the data API, then restore services. Confirm saved stages are reused and
subsequent bodies never overtake the waiting head. This deployment verification
has not been performed on the code-only workstation.
