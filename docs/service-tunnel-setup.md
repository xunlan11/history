# 服务端 · 反向隧道接入手册（可直接交给服务端上的 AI/操作者执行）

> **本文件自包含**，不需要先拉取仓库，也不需要 clone/网络访问 GitHub。
> 完成后，数据端就能通过 `127.0.0.1:18080`（OCR）和 `127.0.0.1:11435`（大模型）调用本机能力。
>
> 术语：**数据端** = 腾讯云 VM `192.144.141.60`（`wenqu.art`），跑存储/编排；
> **服务端** = 本机（`nuc-05zt`），跑 PaddleX `:8080` 与 Ollama `:11434`。
> 两台机器网络不通（数据端 ping/8080/11434 全部不可达），因此由**本机主动**建立 SSH 反向隧道。
> 本文件与 `docs/service-deploy.md` 第 9.5 节内容一致，此处为独立可交付版。

## 目标

把本机的 `127.0.0.1:8080`（PaddleX）与 `127.0.0.1:11434`（Ollama）反向映射到数据端的
`127.0.0.1:18080` 与 `127.0.0.1:11435`，并做成常驻自启服务。

- 全程**不需要 sudo**，所有文件都在 `$HOME` 下。
- 只新增一个 `systemctl --user` unit，**不改**任何现有服务配置、不改 sshd、不开公网端口。
- 数据端 sshd 已满足要求（`AllowTcpForwarding yes`、`GatewayPorts no`、`PermitListen any`、
  仅公钥登录），**不要**去动数据端的 sshd。

## 0. 前置检查（三条全过再往下）

```bash
whoami                                                        # 期望：本机普通用户（非 root）
systemctl --user is-active history-ocr.service history-llm.service
ss -ltn | grep -E ':(8080|11434)' || echo "!! OCR/LLM 未监听"
timeout 5 bash -c '</dev/tcp/192.144.141.60/22' && echo "数据端 22 可达"
```

期望：`history-ocr` 与 `history-llm` 均为 `active` 且 8080/11434 处于 LISTEN，数据端 22 端口可达。

若服务没起，先拉起再继续（OCR 首次加载 12 个模型约 40 s）：

```bash
systemctl --user start history-ocr.service history-llm.service
```

## 1. 生成专用隧道密钥

```bash
[ -f ~/.ssh/id_ed25519_wenqu ] || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_wenqu -N "" -C nuc-tunnel
chmod 600 ~/.ssh/id_ed25519_wenqu
cat ~/.ssh/id_ed25519_wenqu.pub
```

要点：

- `-N ""` 必须是**空口令**，systemd 无法交互输入密码。
- 这是专用密钥，**不要**复用或覆盖已有的个人密钥。
- 幂等：已存在就跳过生成（上面的 `[ -f ... ] ||` 已保证）。

## 2. 把公钥登记到数据端（只授权这两个回环端口的转发）

> 下面第一条 `ssh` 用的是**本机现有默认密钥**（不是刚生成的隧道密钥），
> 前提是本机能免密登录数据端。若报 `Permission denied`，见 2-B。

### 2-A 自动登记（首选）

```bash
KEY=$(cat ~/.ssh/id_ed25519_wenqu.pub)
if ssh -o BatchMode=yes ubuntu@192.144.141.60 "grep -q nuc-tunnel ~/.ssh/authorized_keys"; then
  echo "已登记过，跳过"
else
  printf 'restrict,port-forwarding,permitlisten="127.0.0.1:18080",permitlisten="127.0.0.1:11435" %s\n' "$KEY" > /tmp/nuc-key.line
  ssh ubuntu@192.144.141.60 'cat >> ~/.ssh/authorized_keys' < /tmp/nuc-key.line
fi
ssh ubuntu@192.144.141.60 "grep -c nuc-tunnel ~/.ssh/authorized_keys"   # 期望：1
```

这条授权行的含义：`restrict` 关闭该密钥的一切权限后，只重新打开 `port-forwarding`，
并用 `permitlisten` 限定它**只能**反绑 18080/11435 两个回环端口 —— 即使密钥泄露也无法拿 shell
或转发其它端口。

### 2-B 自动登记失败时（没有到数据端的免密登录）

**停止操作并回报**：把 `cat ~/.ssh/id_ed25519_wenqu.pub` 的输出交给数据端负责人登记
（数据端会用上面同一行格式追加到 `~/.ssh/authorized_keys`）。登记完成后再从第 3 步继续。

不要尝试：改用密码登录（数据端已禁用 `PasswordAuthentication`）、修改数据端 sshd、
或先把私钥拷到数据端 —— 都不需要。

## 3. 安装隧道 unit（内容内联，无需仓库）

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/history-tunnel.service <<'EOF'
[Unit]
Description=Reverse SSH tunnel to data server (OCR 8080 + LLM 11434)
After=network-online.target history-ocr.service history-llm.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i %h/.ssh/id_ed25519_wenqu -R 127.0.0.1:18080:127.0.0.1:8080 -R 127.0.0.1:11435:127.0.0.1:11434 ubuntu@192.144.141.60
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
```

> 若本机已有仓库最新代码（`cd ~/history && git pull`），可直接
> `cp ~/history/deploy/service/history-tunnel.service ~/.config/systemd/user/`，内容完全一致。
>
> 关键参数：`ExitOnForwardFailure=yes`（端口绑不上就退出，便于排错）；
> `ServerAliveInterval=30`（保活）；`IdentitiesOnly=yes` + `-i`（只用隧道密钥）；
> `Restart=always`（断线自愈）。目标地址硬编码为 `ubuntu@192.144.141.60`，
> 数据端换域名/IP 时改这一行并重启。

## 4. 启动并设置自启

```bash
systemctl --user daemon-reload
systemctl --user enable --now history-tunnel.service
sleep 3
systemctl --user is-active history-tunnel.service        # 期望：active
journalctl --user -u history-tunnel.service -n 20 --no-pager
```

首次连接会自动写入 `known_hosts`（`StrictHostKeyChecking=accept-new`），属正常。

## 5. 验证（两侧都要看）

服务端侧：

```bash
systemctl --user status history-tunnel.service --no-pager | head -12
```

数据端侧（用本机现有密钥 ssh 过去执行）：

```bash
ssh ubuntu@192.144.141.60 '
  ss -ltn | grep -E ":(18080|11435)"
  curl -s -o /dev/null -w "ocr health=%{http_code}\n" http://127.0.0.1:18080/health
  curl -s -m 10 http://127.0.0.1:11435/v1/models | head -c 200; echo
'
```

期望结果：

- 18080 与 11435 都在 `127.0.0.1` 上 LISTEN（且**只**绑回环）；
- `ocr health=200`；
- 模型列表里能看到 `qwen3:8b`。

## 6. 完成后回报（把这两段输出贴回给数据端负责人）

```bash
systemctl --user is-active history-ocr history-llm history-tunnel
ssh ubuntu@192.144.141.60 'ss -ltn | grep -E ":(18080|11435)"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/health'
```

数据端收到后会重启 `history-llm` / `history-ocr` / `literature-ocr` 并做端到端验证
（`scripts/check_ocr_upstream.py` + 两侧 `/health`）。

## 7. 排错

| 现象 | 处理 |
| --- | --- |
| journal 出现 `remote port forwarding failed for listen port 18080/11435` | ① 第 2 步公钥没登记成功；② 数据端该端口已被占用（数据端 `ss -ltnp \| grep -E ':(18080\|11435)'`）；③ 上次隧道残留（数据端 `pkill -f 'ssh.*18080'` 后 `systemctl --user restart history-tunnel`） |
| `Permission denied (publickey)` | 隧道公钥未登记，或 unit 里 `-i` 路径不对（`%h` = 本机用户家目录） |
| 隧道 active，但数据端 curl 返回 502 / 空响应 | 本机 8080/11434 自身没起：`systemctl --user status history-ocr history-llm`（OCR 启动约 40 s） |
| 用一阵子断开 | 已由 `ServerAliveInterval=30` + `Restart=always` 自愈；若频繁断开且 `journalctl --user -u history-tunnel` 有网络重置记录，检查网络/代理 |
| 数据端地址变更 | 改 unit 里的 `ubuntu@<数据端>`，`cp` 回 `~/.config/systemd/user/` 后 `daemon-reload` + `restart` |

## 8. 边界：本任务不要做的事

1. 不要 `sudo`，不要改系统 sshd、不动 `ufw`。
2. 不要开任何新的公网端口，不要把 `-R` 绑到 `0.0.0.0`（数据端已 `GatewayPorts no`，保持现状）。
3. 不要修改 `history-ocr.service` / `history-llm.service` 的配置或升级组件；本任务只新增一个 tunnel unit。
4. 不要删除或覆盖本机已有的其它 SSH 密钥。
5. 隧道只解决「数据端能访问服务端」；OCR/大模型自身的部署与调优见 `docs/service-deploy.md`。
