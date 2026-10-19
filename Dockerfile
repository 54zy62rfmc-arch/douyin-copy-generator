# 零依赖 Node 应用，无需 npm install
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# 仅复制运行所需文件
COPY app/package.json ./
COPY app/server.js ./
COPY app/lib ./lib
COPY app/public ./public

# 历史 / 热词 / 样本 / 访问口令等数据目录
RUN mkdir -p /app/.data

EXPOSE 8000

# 首页可访问即视为存活
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "--experimental-sqlite", "server.js"]
