<div align="center">
  <h1>🚀 Delivery Ops Bridge</h1>
  <p>
    <strong>A high-performance, event-driven AI Delivery & Operations Middle-End</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Elysia-000000?style=for-the-badge" alt="Elysia" />
    <img src="https://img.shields.io/badge/Feishu-00B2FF?style=for-the-badge&logo=feishu&logoColor=white" alt="Feishu" />
    <img src="https://img.shields.io/badge/TAPD-FF6A00?style=for-the-badge&logo=tencent&logoColor=white" alt="TAPD" />
  </p>
</div>

<br />

**Delivery Ops Bridge** 是一个专为敏捷研发团队打造的智能化交付中台。它无缝打通了 **飞书 (Feishu)**、**TAPD** 与 **AI 模型网关 (OpenAI / DeepSeek)**，通过自动化的工作流和 AI 能力，显著降低项目管理的沟通成本，提升研发交付效率。

---

## ✨ 核心特性

- **🤖 智能化任务解析**：无需打开 TAPD，只需在群聊中 `@机器人 + @责任人 + 任务描述`，AI 将自动拆解任务、识别优先级并创建记录。
- **🔄 全自动工作流闭环**：支持任务的确认接受、阻塞记录、进度更新、完成以及验收。
- **📊 多维度统计生成**：
  - **每日站会收集**：自动私聊提醒成员提交站会，到点自动汇总并发送至群聊。
  - **研发日报**：结合群聊上下文和 AI 总结能力，自动生成研发日报。
  - **可视化看板**：自动生成精美的 HTML 交付看板，并发布到飞书云盘供全量团队查阅。
- **⚡️ 极致性能**：全面拥抱 **TypeScript + Bun** 和 **Elysia** 框架，实现毫秒级 Webhook 响应与超低内存占用。
- **🔌 灵活的扩展层**：模块化的 Adapter 设计，轻松支持对接其他企业级办公系统。

## 🏗 技术栈

| 类别 | 技术方案 | 描述 |
| --- | --- | --- |
| **运行时** | `Bun` | 提供极速的启动体验、原生的 TS 支持及卓越的并发性能 |
| **框架** | `Elysia` | 最快的 Bun Web 框架，提供强类型的开发体验 |
| **AI SDK** | `@ai-sdk/openai` | 标准化的 LLM 接入层，支持 OpenAI、DeepSeek 等模型 |
| **数据层** | `JsonStore` | 轻量级本地数据引擎，免去重数据库依赖的部署烦恼 |

## 🚀 快速开始

### 1. 环境准备

确保你已在系统中安装了 [Bun](https://bun.sh/) 运行时引擎。

### 2. 克隆与安装依赖

```bash
git clone https://github.com/your-org/delivery-ops-bridge.git
cd delivery-ops-bridge/backend

# 使用 Bun 极速安装依赖
bun install
```

### 3. 配置环境变量

从示例文件创建你的配置：

```bash
cp config/config.example.json config/config.json
```

你需要填写的关键配置包括：
- **Feishu**: `app_id`, `app_secret`, `bot_open_id`
- **TAPD**: `workspace_id`, `api_token`
- **AI / DeepSeek**: `api_base`, `api_key`

### 4. 启动服务

**日常开发（开启热更新，推荐）：**

```bash
bun dev
```

**生产环境启动：**

```bash
bun start
```

启动成功后，你将看到如下标志性输出：
```
🦊 Elysia is running at localhost:8090
Loaded config for project: ZenithStrat
```

---

## 🌐 暴露公网回调 (Webhook)

要在飞书开放平台接收事件推送，必须将本地的 `8090` 端口暴露至公网。推荐使用 **localtunnel**：

```bash
# 替换你的专属子域名
npx localtunnel --port 8090 --subdomain peter-ops-bot-666
```
将获取到的 HTTPS 地址填写至 **飞书开放平台 -> 事件订阅 -> 请求网址**。

*(如遇网络受限，也可考虑使用 `cloudflared tunnel` 或 `localhost.run` 替代。)*

---

## 🕒 自动化调度器 (Cron Jobs)

系统内部集成了毫秒级的守护任务调度器。只需保证 `bun start` 在后台常驻，系统便会按照 `config.json` 中的 `schedule` 时间表自动执行以下任务：

- `standup-push`: 定点分发站会模板
- `standup-summary`: 聚合站会并推送到群
- `overdue-scan`: 识别延期风险任务并预警
- `dashboard`: 渲染每日迭代进度数据看板

---

## 🔐 飞书开放平台权限说明

为确保所有功能正常运作，请为应用开启以下必备权限：

- **基础通信**：`im:message.receive_v1` (接收消息)
- **文档与云盘（用于自动发布看版）**：
  - `drive:drive`
  - `drive:file`
  - `drive:file:upload`
  - `docs:permission.setting:write_only`

---

## 📂 核心目录结构

```text
├── backend/                  # Bun & TypeScript 后端核心逻辑
│   ├── src/
│   │   ├── adapters/         # 外部 API 适配器 (Feishu, TAPD, LLM)
│   │   ├── core/             # 核心引擎 (Scheduler, Store)
│   │   ├── services/         # 业务编排 (MessageHandler, Standup, Jobs)
│   │   └── index.ts          # Elysia 路由与系统启动入口
│   ├── package.json          # 依赖与脚本
├── config/                   # 配置文件目录
├── data/                     # (Git Ignore) 运行时产生的数据和产物
└── README.md                 # 项目文档
```

<div align="center">
  <sub>Built with ❤️ by the Delivery Ops Team.</sub>
</div>
