<div align="center">
  <img src="https://raw.githubusercontent.com/github/explore/80688e429a7d4ef2fca1e82350fe8e3517d3494d/topics/bot/bot.png" width="100" height="100" alt="Bot Logo">
  <h1>🚀 Delivery Ops Bridge</h1>
  <p><strong>智能化研发交付中台：打通飞书、TAPD 与 AI，告别低效项目管理</strong></p>
  <p>
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://react.dev"><img src="https://img.shields.io/badge/React-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://open.feishu.cn"><img src="https://img.shields.io/badge/Feishu-00B2FF?style=for-the-badge&logo=feishu&logoColor=white" alt="Feishu" /></a>
    <a href="https://www.docker.com"><img src="https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
  </p>
</div>

<br />

> **Delivery Ops Bridge** 是一款专为现代敏捷团队打造的智能化中台，提供从 **React 可视化管理面板** 到 **Bun 驱动的 AI 引擎** 的完整解决方案。
> 它可以免去繁琐的工单填报和日常催收，将冰冷的管理系统变成整个团队的“私人研发助理”。

---

## ✨ 核心特性 (Features)

- **🤖 群聊即工单 (ChatOps)**：在飞书群中只需发送 `@机器人 安排任务`，大模型会自动拆解任务属性（负责人、截止日期、优先级）并双向同步至远端 TAPD，开发者全程无需打开工单系统。
- **🔄 极简状态流转**：群内回复“卡住了”或“做完了”，AI 会精准捕捉语义，自动更新状态流，并 `@` 相关人员请求协助。
- **📊 自动化站会与日报**：内置毫秒级智能调度引擎，每日定时私聊收集成员进度，傍晚自动生成高浓缩 AI 研发日报并发送至群聊。
- **📈 现代化控制台**：自带开箱即用的前端管理台（基于 React + Tailwind），一站式实现系统配置修改、迭代看板预览和审计日志回溯。
- **⚡️ 极致轻量架构**：底层基于 SQLite + Prisma 的高性能本地关系型存储，兼顾部署轻量化与数据强一致性，零依赖 MySQL 也能轻松应对高并发长连接。

---

## 🏗 工程架构 (Architecture)

本项目采用彻底的前后端分离模式，并针对不同职责划分为两个子项目：

- **[Frontend (管理后台)](frontend/README.md)**: React 18, Vite, Tailwind CSS, Shadcn UI
- **[Backend (核心引擎)](backend/README.md)**: Bun, Elysia, Prisma ORM, 飞书/TAPD 官方 SDK
- **AI 赋能**: DeepSeek / OpenAI 兼容接口，驱动底层意图识别与日报摘要。

详细的底层架构设计，请参考 📚 [系统架构与业务逻辑详解](docs/系统架构与业务逻辑详解.md)。

---

## 🚀 快速开始 (Quick Start)

### 1. 启动后端 (Backend)

进入 `backend` 目录，安装依赖、同步数据库并启动服务：

```bash
cd backend
bun install
bun run setup  # 自动同步数据库结构并启动本地热更新开发服务
```

*如果你需要可视化修改和查看底层数据，可以运行 `bun run db:studio` 启动 Web 数据控制台。*

第一次启动后，请补充完整的环境配置密钥：
```bash
cp config/config.example.json config/config.json
```

### 2. 启动前端 (Frontend)

进入 `frontend` 目录，安装依赖并启动管理控制台：

```bash
cd frontend
pnpm install
pnpm dev
```
打开终端提示的地址（如 `http://localhost:5173`），即可通过图形化 UI 进行所有底层系统的配置。

---

## 🐳 Docker 生产环境部署 (Deployment)

如果你准备将项目部署到服务器上正式使用，强烈推荐使用 **Docker** 一键启动，无需在服务器上手动配置各种环境。

```bash
cd backend
docker-compose up -d --build
```

> **提示**：Docker 编排配置已自动将宿主机的 `data` 目录与 `.env` 环境变量映射进容器中，重装或重启都不会丢失任何业务数据。详细指令请参考 [Backend README](backend/README.md) 或 [部署规范](docs/项目部署与开发协作流程.md)。

---

## 🌐 飞书长连接集成 (WebSocket)

本项目现已全面升级为 **官方长连接 (WSClient)** 模式接收飞书消息，**完全无需配置公网 Webhook**，也无需依赖 ngrok 等内网穿透工具，内网开发即可畅享真实双向通信！

1. 填写 `app_id` 和 `app_secret` 并启动后台。
2. 前往 **飞书开放平台 -> 事件订阅**。
3. 将 **[订阅方式]** 切换为 **[使用长连接接收事件]** 并保存即可生效。

---

