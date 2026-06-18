# Delivery Ops Bridge

Delivery Ops Bridge 是一个事件驱动的研发交付中台，用来连接飞书、TAPD 和兼容 OpenAI Chat Completions 的模型网关。

当前仓库已经实现：

- 飞书 Webhook 接入，支持 `url_verification` 和 `im.message.receive_v1`
- 本地 JSON 存储：消息、任务、更新、站会、日报、看板、审计日志
- 显式任务创建：必须满足 `@机器人 + @员工 + 创建任务语义`
- TAPD Story 创建和状态更新
- 任务确认、阻塞、完成、验收等轻量追踪
- 站会收集、日报、HTML 看板、定时任务
- 看板发布到飞书云盘（开通 Drive 相关 scope 后自动上传并回群链接）
- `--dry-run` 模式，方便先联调飞书而不真实写 TAPD 或发飞书

## 当前状态

项目已验证通过：

```bash
python3 -m pytest -q
```

本机当前情况：

- `cloudflared` 已安装：`/opt/homebrew/bin/cloudflared`
- `8080` 端口已被别的 `node` 服务占用
- 建议本项目统一使用 `8090`

## 配置文件

当前实际运行配置文件是：

[config/config.json](/Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent/config/config.json)

示例模板在：

[config/config.example.json](/Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent/config/config.example.json)

已经配置好的关键项：

- 飞书 `app_id`
- 飞书 `app_secret`
- TAPD `workspace_id`
- TAPD `api_token`
- TAPD `workitem_type_id`
- DeepSeek `api_base`
- DeepSeek `api_key`
- DeepSeek `model`

还需要你后续按真实情况补全或确认：

- `feishu.bot_open_id`
- `feishu.group_chat_id`
- `members` 里的团队成员 `open_id` 和姓名

## 安装与检查

如果还没装依赖，执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

检查项目是否正常：

```bash
python3 -m pytest -q
python3 -m compileall delivery_ops_bridge tests
```

## 启动本地 Webhook 服务

开发联调建议先用 dry-run：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json --dry-run server --host 127.0.0.1 --port 8090
```

看到类似输出说明服务起来了：

```text
Delivery Ops Bridge listening on http://127.0.0.1:8090
```

健康检查：

```bash
curl http://127.0.0.1:8090/healthz
```

应该返回：

```json
{"ok": true}
```

如果准备真实联飞书和 TAPD，把 `--dry-run` 去掉：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json server --host 127.0.0.1 --port 8090
```

## 暴露公网地址给飞书

本机已经安装了 `cloudflared`，直接执行：

```bash
cloudflared tunnel --url http://localhost:8090
```

它会输出一个公网 HTTPS 地址，类似：

```text
https://xxxxx.trycloudflare.com
```

把这个地址填到飞书开放平台：

```text
飞书开放平台 -> 你的应用 -> 事件订阅 -> 请求网址
```

请求网址就填：

```text
https://xxxxx.trycloudflare.com
```

飞书验证 URL 时，本服务会自动响应 `challenge`。

如果 `cloudflared` 启动后外部访问报 `1033`，通常是当前网络拦截了 Cloudflare Tunnel 需要的出站连接。这个环境下可以直接切换到 `localtunnel`：

```bash
npx localtunnel --port 8090
```

它会输出类似：

```text
your url is: https://busy-shoes-type.loca.lt
```

把这个 `https://...loca.lt` 地址同样填到飞书开放平台的事件订阅请求网址里。

如果 `localtunnel` 也不稳定，可以直接用 `localhost.run`，这个仓库当前验证通过的方案就是它：

```bash
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:8090 nokey@localhost.run
```

成功后会输出类似：

```text
https://b4b3866780c66b.lhr.life
```

把这个地址填到飞书开放平台的事件订阅请求网址里即可。这个地址在当前会话里已经验证过可以正确返回飞书需要的 `url_verification` 响应。

## 本地消息联调

你可以先用 dry-run 模式本地喂一条事件：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json --dry-run handle-event --pretty <<'JSON'
{"event":{"sender":{"sender_id":{"open_id":"ou_3f85f7ad58df6c643468bbe64e738c91"}},"message":{"message_id":"om_local_test","chat_id":"oc_c6f9a8a03198c9f24e894517d7a622e1","chat_type":"group","message_type":"text","content":"{\"text\": \"@AI交付助理 @张三 创建任务：配置检查任务 截止时间：明天 优先级：P2 验收标准：dry-run能创建任务\"}","mentions":[{"id":{"open_id":"ou_1d83ab6e737842016438b59cdb122bc0"},"name":"AI交付助理"},{"id":{"open_id":"ou_3f85f7ad58df6c643468bbe64e738c91"},"name":"张三"}],"create_time":"2026-06-18T10:00:00Z"}}}
JSON
```

返回里如果有：

```json
{
  "handled": true,
  "action": "task_created"
}
```

说明解析链路是通的。

## 模块 1 / 模块 3 自动任务

模块 1（每日群聊总结）和模块 3（站会收集 / 提醒 / 汇总）都已经做成了可直接挂到 `crontab` 的命令。

### 先决条件

1. **Webhook 服务需要常驻**

模块 3 不是只有“定时发提醒”这么简单，它还要持续接收成员私聊机器人的站会回复。所以除了 `crontab`，还需要这个服务长期运行：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json server --host 127.0.0.1 --port 8090
```

2. **飞书事件回调公网地址需要常驻**

如果现在还在用 `localhost.run` / `localtunnel` 这种临时地址，它也要一直挂着。生产环境建议直接放到一台云主机，用固定域名反代到 `8090`。

3. **crontab 负责触发定时动作**

当前模块 1 / 3 / 看板 / 超期扫描的定时样例已经写在：

[scripts/crontab.example](/Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent/scripts/crontab.example)

### 安装 crontab

先确认项目绝对路径。当前这台机器是：

```bash
cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent
pwd
```

然后编辑 crontab：

```bash
crontab -e
```

把下面这组命令贴进去，并把路径保持为你的真实项目目录：

```cron
0 9 * * 1-5   cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh standup-push
30 9 * * 1-5  cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh standup-remind
10 11 * * 1-5 cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh standup-summary
0 10 * * *    cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh overdue-scan
30 18 * * *   cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh daily-summary
40 18 * * *   cd /Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent && DELIVERY_OPS_CONFIG=config/config.json scripts/run.sh dashboard
```

装好后查看：

```bash
crontab -l
```

### 这组定时任务分别做什么

- `standup-push`：工作日 09:00 私聊每位成员发站会模板
- `standup-remind`：工作日 09:30 私聊催未提交成员
- `standup-summary`：工作日 11:10 汇总站会并发群
- `daily-summary`：每天 18:30 发群聊日报
- `dashboard`：每天 18:40 生成并发布看板
- `overdue-scan`：每天 10:00 扫超期任务并私聊负责人

## 定时任务命令

直接运行单个任务：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json job standup-push
python3 -m delivery_ops_bridge.cli --config config/config.json job standup-remind
python3 -m delivery_ops_bridge.cli --config config/config.json job standup-summary
python3 -m delivery_ops_bridge.cli --config config/config.json job overdue-scan
python3 -m delivery_ops_bridge.cli --config config/config.json job daily-summary
python3 -m delivery_ops_bridge.cli --config config/config.json job dashboard
```

如果只是演练流程，不想真实调用外部系统：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json --dry-run job daily-summary
```

crontab 示例见：

[scripts/crontab.example](/Users/admin/Desktop/Peter/AI-Delivery-Ops-Agent/scripts/crontab.example)

## 飞书后台还需要开哪些权限

消息收发和事件订阅之外，如果你希望“看板自动上传到飞书云盘，并把可访问链接发回群里”，还需要在飞书开放平台给应用开这些 scope：

- `drive:drive`
- `drive:file`
- `drive:file:upload`
- `docs:permission.setting:write_only`

当前代码已经支持这条链路；如果 scope 没开，任务不会中断，但群里会收到一条“看板已生成，云盘共享未配置完成”的提示。

如果你后面要把看板做成**可在线编辑的飞书文档**，再补：

- `docs:doc`

## 目录说明

默认运行时数据目录是 `data/`：

- `data/messages/`：原始飞书消息
- `data/tasks/`：任务数据
- `data/updates/`：任务状态与进度日志
- `data/standups/{date}/`：每日站会
- `data/summaries/`：日报结构化结果
- `data/dashboards/`：HTML 看板与统计 JSON
- `data/logs/audit.jsonl`：审计日志

## 常用命令

测试：

```bash
python3 -m pytest -q
```

启动 dry-run 服务：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json --dry-run server --host 127.0.0.1 --port 8090
```

启动真实服务：

```bash
python3 -m delivery_ops_bridge.cli --config config/config.json server --host 0.0.0.0 --port 8090
```

> [!TIP]
> 推荐使用 `localtunnel` 进行穿透，它可以固定子域名且不易被拦截。注意后端需绑定 `--host 0.0.0.0` 确保外部访问。

启动 localtunnel（推荐首选方案，固定飞书 Webhook 域名）：

```bash
npx localtunnel --port 8090 --subdomain peter-ops-bot
```

启动 Cloudflare tunnel（备选方案，部分网络环境可能会被拦截导致返回 HTML 错误）：

```bash
cloudflared tunnel --url http://localhost:8090
```

启动 localhost.run 备用方案：

```bash
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:8090 nokey@localhost.run
```
