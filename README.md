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

**Delivery Ops Bridge** 是一个专为敏捷研发团队打造的智能化交付中台，旨在**彻底消灭研发过程中的低效管理摩擦**。

你是否厌倦了：
- 🤬 每天被打断去 TAPD/Jira 里填写繁琐的工单和更改状态？
- 🥱 每天定时的站会变成流水账，或者总有人忘记写日报？
- 🤯 项目进度不透明，项目经理和 Leader 每天要在群里四处追问“这个提测了吗”、“那个阻塞在哪”？

**Delivery Ops Bridge 就是为了解决这些痛点而生！** 它将 **飞书 (Feishu)** 的即时沟通能力、**TAPD** 的工单数据底座，与 **AI 大模型 (OpenAI / DeepSeek)** 的深度语义理解能力无缝融合。
它把冰冷的管理系统变成了你的“私人研发助理”：**你只需要在熟悉的聊天框里用自然语言对话，剩下的建单、状态流转、进度催办、报告汇总等所有脏活累活，全部由 AI 自动化代劳。**

---

## 🎯 为什么选择 Delivery Ops Bridge？（核心场景）

### 1. 🤖 终极效率黑科技：群聊即工单
研发同学**再也不用打开复杂的 TAPD 或 Jira 界面**。
只需在群聊里轻松 @ 机器人：`@AI交付助理 @张三 安排一个支付接口优化的任务，今天下班前搞定，P1优先级`。
AI 会自动识别语义、提取意图、拆解任务属性（如主责人、Deadline、优先级、验收标准等），并**瞬间双向同步到 TAPD 中完成建单**。

### 2. 🔄 状态流转，一语带过
“我接了”、“卡住了因为缺权限”、“做完了求验收” —— 只要你在群内直接引用或回复任务消息，AI 会自动捕捉进度更新。它不仅能追踪任务，还能在你声明“阻塞”时，智能抽取阻塞原因，并@相关人员火速请求协助。

### 3. 📊 告别“催交”：全自动化的站会与智能日报
系统内置毫秒级守护的调度引擎。
- **智能站会**：每天上午自动私聊组员温柔“催更”昨今工作，到点后将所有人进度整齐划一地汇总至群内。
- **AI 研发日报**：每天傍晚，AI 统揽全天群内所有产生过交互的任务、阻塞与进度，自动生成**高度凝练、结构化的智能研发日报**，彻底告别毫无营养的流水账。

### 4. 📈 领导最爱：高颜值迭代数据看板
基于沉淀的真实交付数据，系统每天下班前会自动渲染一份极具科技感的精美 HTML 交付看板，并**自动上传至飞书云盘**将公网链接发回群中。迭代燃尽、延期预警、全组产能分布，一张图安排得明明白白！

### 5. ⚡️ 极致轻量，开箱即用
全面拥抱目前最潮的 **TypeScript + Bun + Elysia** 架构。以几乎可忽略不计的内存占用，提供超高并发的 Webhook 响应能力。纯原生轻量级 `JsonStore` 存储架构让你**完全无需部署 MySQL/Redis** 即可光速跑起来！

---

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
