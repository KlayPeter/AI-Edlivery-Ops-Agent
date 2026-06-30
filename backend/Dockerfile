# 使用官方 Bun 镜像
FROM oven/bun:1 as builder

WORKDIR /app

# 1. 拷贝 package.json 和 bun.lockb 并安装依赖
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# 2. 拷贝源码及 Prisma schema
COPY . .

# 3. 生成 Prisma Client
RUN bunx prisma generate

# ----------------- 运行阶段 -----------------
FROM oven/bun:1-slim

WORKDIR /app

# 从 builder 阶段拷贝 node_modules 和所有源码
# 包含了生成的 Prisma Client
COPY --from=builder /app /app

# 创建持久化数据挂载点
RUN mkdir -p /app/data

# 声明对外暴露的端口
EXPOSE 8090

# 启动服务前，先通过 prisma db push 确保数据库表结构已创建 (可选，适用于第一次启动)
# 在实际生产中推荐在启动脚本里运行 db:push，或者直接运行 src/index.ts
CMD bun run db:push && bun run src/index.ts
