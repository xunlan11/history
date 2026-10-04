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
| Literature data API | data host | 18665 | `data/literature-data.service` |
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
systemctl --user enable --now literature-data literature-ocr
```

The data services use `/home/ubuntu/Codefield/history` as their working
directory. Their persistent data lives outside this directory:

- `history/storage/`
- `history/ocr-storage/`
- `/home/ubuntu/Codefield/literature-data/`

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
- `test-layout-parsing.py` and `test-llm.py` are optional smoke tests.
