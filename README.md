<div align="center">
  <h1>🚀 Delivery Ops Bridge</h1>
  <p><strong>智能化研发交付中台：打通飞书、TAPD 与 AI，告别低效项目管理</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
    <img src="https://img.shields.io/badge/React-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Feishu-00B2FF?style=for-the-badge&logo=feishu&logoColor=white" alt="Feishu" />
  </p>
</div>

<br />

**Delivery Ops Bridge** 是专为敏捷团队打造的智能化中台，提供从 **React 前端管理面板** 到 **Bun 后端 AI 引擎** 的完整解决方案。它可以帮你免去繁琐的工单填报和日常催收，把冰冷的管理系统变成整个团队的“私人研发助理”。

---

## ✨ 核心特性

- **🤖 群聊即工单**：在飞书群 `@机器人 安排任务`，AI 会自动拆解任务属性并双向同步至 TAPD，开发者全程无需打开工单系统。
- **🔄 极简状态流转**：群内回复“卡住了/做完了”，AI 会自动捕捉进度、更新状态并 @ 相关人员求助。
- **📊 自动化站会与日报**：内置智能调度系统，每天定时私聊收集成员进度，傍晚自动生成高浓缩 AI 研发日报发送至群聊。
- **📈 现代化前端面板**：自带开箱即用的前端管理台，一站式管理系统配置、查看迭代看板、监控审计日志。
- **⚡️ 极致轻量架构**：告别繁重的数据库部署，采用基于本地 JSON 的纯内存驱动，极低资源占用。

---

## 🏗 技术栈

- **前端 (Frontend)**: React, Vite, Tailwind CSS, Shadcn UI
- **后端 (Backend)**: Bun, Elysia (TypeScript)
- **核心组件**: JsonStore (本地数据底座), @ai-sdk/openai (大模型接入)
- **集成平台**: 飞书开放平台 (Webhook), TAPD 开放 API

---

## 🚀 快速开始

本项目包含独立的 `frontend` (管理后台) 和 `backend` (核心接口与机器人) 两部分。

### 1. 启动后端 (Backend)

进入 `backend` 目录，使用 Bun 安装依赖并启动服务：

```bash
cd backend
bun install
bun dev  # 启动本地热更新开发服务 (默认运行在 8090 端口)
```

后端启动后，请将示例配置文件复制并补充完整（主要填写飞书、TAPD 和大模型秘钥）：
```bash
cp config/config.example.json config/config.json
```

### 2. 启动前端 (Frontend)

进入 `frontend` 目录，安装依赖并启动可视化管理台：

```bash
cd frontend
pnpm install
pnpm dev
```
打开终端提示的地址（如 `http://localhost:5173`），即可通过可视化 UI 进行全部系统配置。

---

## 🌐 飞书 Webhook 联调

要接收飞书的即时消息，必须将后端的 `8090` 端口暴露到公网。推荐使用 **localtunnel**：

```bash
npx localtunnel --port 8090 --subdomain peter-ops-bot-666
```
将获取到的 HTTPS 地址填写至 **飞书开放平台 -> 事件订阅 -> 请求网址**。

## 📂 核心目录结构

```text
├── backend/                  # Bun & TypeScript 后端核心逻辑 (Elysia, AI Adapters)
├── frontend/                 # React & Vite 前端管理后台 (配置可视化, 面板查阅)
├── config/                   # 系统配置文件目录 (主要维护 config.json)
├── data/                     # 运行时轻量级存储目录 (代码不追踪)
└── README.md                 # 项目文档
```
