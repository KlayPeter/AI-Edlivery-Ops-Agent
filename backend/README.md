# Backend (AI 中枢引擎)

后端模块是整个项目的“大脑”。它负责全天候与飞书保持长连接，拦截对话并通过大模型驱动完成自动化办公流。

## 🛠️ 技术栈

- **运行时**: [Bun](https://bun.sh) (极速的全栈 JS 运行时)
- **框架**: ElysiaJS (基于 TypeScript 的高性能 Web 框架)
- **数据库**: SQLite 
- **ORM**: Prisma (提供强类型的数据库操作)
- **AI 接入**: `@ai-sdk/openai` (兼容 DeepSeek 等所有类 OpenAI 接口)

## 🎯 包含的功能模块

1. **WebSocket 长连接器**：基于飞书官方 SDK，实现内网安全监听企业通讯。
2. **AI 意图路由层**：基于职责链模式的 Handler，将自然语言指令精准路由至对应业务逻辑。
3. **Cron 调度引擎**：内置的毫秒级任务调度器，精准触发站会收集与日报推送。
4. **OpenAPI 桥接层**：负责清洗、映射 TAPD 等老牌管理系统的数据模型。

## 🚀 本地开发启动

请确保你已经安装了 [Bun](https://bun.sh)。

**1. 安装依赖**
```bash
bun install
```

**2. 一键启动 (推荐)**
该命令会自动将你的数据库表结构同步 (db:push)，并以热更新 (watch) 模式启动服务器。
```bash
bun run setup
```

**3. 查看与管理底层数据**
我们为你提供了一个基于网页的可视化数据库客户端，运行后即可在浏览器修改 SQLite 数据：
```bash
bun run db:studio
```

## 🐳 Docker 容器化部署 (生产环境)

生产环境中，强烈建议使用 Docker 运行后端，以规避不同操作系统中原生 SQLite 的依赖冲突问题。

**启动步骤：**
1. 复制 `.env.example` 为 `.env`，填写真实的敏感秘钥。
2. 确保在根目录存在数据持久化文件夹：`mkdir ../data`
3. 使用 docker-compose 一键编译并后台启动：
```bash
docker-compose up -d --build
```

**查看运行日志：**
```bash
docker-compose logs -f
```

## 🛡️ 代码质量保障

本项目全程开启 TypeScript 严格模式，提交代码前，请务必执行以下指令以确保没有类型错误：
```bash
bun run typecheck
```
