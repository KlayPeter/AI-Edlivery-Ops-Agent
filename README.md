# Delivery Ops Bridge

Delivery Ops Bridge 是一个事件驱动的研发交付中台，用来连接飞书、TAPD 和兼容 OpenAI Chat Completions 的模型网关。

当前仓库已经实现基于 TypeScript / Bun (Elysia) 的重构：

- 飞书 Webhook 接入，支持 `url_verification` 和 `im.message.receive_v1`
- 本地 JSON 存储：消息、任务、更新、站会、日报、看板、审计日志
- 显式任务创建：必须满足 `@机器人 + @员工 + 创建任务语义`
- TAPD Story 创建和状态更新
- 任务确认、阻塞、完成、验收等轻量追踪
- 站会收集、日报、HTML 看板、系统内置定时任务调度
- 看板发布到飞书云盘（开通 Drive 相关 scope 后自动上传并回群链接）

## 当前状态

项目后台现已全面迁移至 **Node.js / Bun** 生态，使用 TypeScript 编写。

- 默认端口: `8090`
- 核心框架: `Elysia`

## 配置文件

当前实际运行配置文件是：

[config/config.json](config/config.json)

示例模板在：

[config/config.example.json](config/config.example.json)

已经配置好的关键项：

- 飞书 `app_id` / `app_secret`
- TAPD `workspace_id` / `api_token` / `workitem_type_id`
- DeepSeek `api_base` / `api_key` / `model`

还需要你后续按真实情况补全或确认：

- `feishu.bot_open_id`
- `feishu.group_chat_id`
- `members` 里的团队成员 `open_id` 和姓名

## 安装与检查

进入 `backend` 目录，安装依赖：

```bash
cd backend
bun install
```

检查 TypeScript 类型是否正确：

```bash
bun run typecheck
```

## 启动本地 Webhook 服务

日常开发联调（支持热更新）：

```bash
cd backend
bun dev
```

正式环境运行：

```bash
cd backend
bun start
```

看到类似输出说明服务起来了：

```text
🦊 Elysia is running at localhost:8090
Loaded config for project: ZenithStrat
```

健康检查：

```bash
curl http://127.0.0.1:8090/healthz
```

应该返回：

```json
{"ok": true}
```

## 暴露公网地址给飞书

如果开发机在内网，你可以使用 `localtunnel` 暴露公网地址供飞书回调。

> [!TIP]
> 推荐使用 `localtunnel` 进行穿透，它可以固定子域名且不易被拦截。

```bash
npx localtunnel --port 8090 --subdomain peter-ops-bot-666
```

它会输出类似：

```text
your url is: https://peter-ops-bot-666.loca.lt
```

把这个地址填到飞书开放平台：

```text
飞书开放平台 -> 你的应用 -> 事件订阅 -> 请求网址
```

请求网址就填：

```text
https://peter-ops-bot-666.loca.lt
```

飞书验证 URL 时，本服务会自动响应 `challenge`。

备选方案（Cloudflared 或 localhost.run）：
```bash
cloudflared tunnel --url http://localhost:8090
```
```bash
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:8090 nokey@localhost.run
```

## 自动任务调度

（每日群聊总结）和（站会收集 / 提醒 / 汇总）已经接入服务内调度器。只要 `backend` 服务常驻，系统会按 `config/config.json` 里的 `schedule` 自动触发日报、站会、看板和超期扫描。

### 先决条件

**Webhook 服务需要常驻**：确保 `bun start` 在后台持续运行。

### 这组定时任务分别做什么

- `standup-push`：私聊每位成员发站会模板
- `standup-second-remind`：私聊催未提交成员
- `standup-mark-missing`：记录未提交名单
- `standup-summary`：汇总站会并发群
- `daily-summary`：发群聊日报
- `dashboard`：生成并发布看板
- `overdue-scan`：扫超期任务并私聊负责人

## 飞书后台还需要开哪些权限

消息收发和事件订阅之外，如果你希望“看板自动上传到飞书云盘，并把可访问链接发回群里”，还需要在飞书开放平台给应用开这些 scope：

- `drive:drive`
- `drive:file`
- `drive:file:upload`
- `docs:permission.setting:write_only`

如果 scope 没开，任务不会中断，但群里会收到一条“看板已生成，云盘共享未配置完成”的提示。

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
