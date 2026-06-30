# Frontend (可视化管理中台)

前端模块是 **Delivery Ops Bridge** 的控制中心。我们采用了现代化、轻量级的前端技术栈构建，以保证绝佳的响应速度与组件复用性。

## 🛠️ 技术栈

- **框架**: [React 18](https://react.dev/) + [Vite](https://vitejs.dev/)
- **路由**: React Router
- **样式**: Tailwind CSS (原子化类名)
- **UI 组件库**: [Shadcn UI](https://ui.shadcn.com/) (无头组件库，样式可深度定制)
- **图标**: Lucide React

## 🎯 包含的功能模块

1. **机器人配置中心**：动态配置飞书与 TAPD 的双向绑定策略。
2. **群组与人员管理**：可视化管理监听哪些群聊，以及各团队成员的开关。
3. **调度表设置**：图形化配置每天收集站会和生成日报的具体时间。
4. **看板大屏预览**：实时预览通过数据分析得出的项目进度大屏。

## 🚀 启动项目

请确保你已经安装了 [Node.js](https://nodejs.org/) 与 `pnpm` 包管理器。

**1. 安装依赖**
```bash
pnpm install
```

**2. 启动开发服务器 (支持热更新)**
```bash
pnpm dev
```

**3. 构建生产版本**
```bash
pnpm build
```
执行完毕后，所有的静态 HTML/JS 产物将生成在 `dist` 目录下。你可以将其扔给 Nginx、Vercel 等任何静态服务容器进行托管。
