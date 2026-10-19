# 部署说明

抖音短视频带货「爆款文案生成器」——零依赖 Node 应用，**无需 `npm install`**，只需 Node ≥ 18。

---

## 一、最快跑起来（本机 / 内网）

```bash
# 1) 配置（可选，不配则自动进入「演示模式」）
cp .env.example .env
# 编辑 .env：至少填 LLM_API_KEY（或保持留空体验演示模式）

# 2) 启动
node server.js          # 或 npm start
```

启动后终端会打印三个地址：

| 用途 | 地址 |
| --- | --- |
| 本机访问 | `http://localhost:8000` |
| 手机同网访问 | `http://<你的内网IP>:8000`（手机连同一 WiFi 即可打开） |

> 手机端是 PWA：浏览器菜单 →「添加到主屏幕」，即可像 App 一样全屏使用。

---

## 二、用大模型（必读）

应用走 **OpenAI 兼容协议**，换服务商只需改 `LLM_BASE_URL` + `LLM_MODEL`：

| 服务商 | Base URL | 示例模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 你的接入点 ID |

- **模型回退**：`LLM_MODELS=deepseek-chat,gpt-4o-mini`，前一个失败自动切下一个（仅在尚未输出内容时重试，不会出现重复片段）。
- **识图**：`LLM_VISION_MODEL` 需填支持视觉输入的模型（如 `gpt-4o` / `qwen-vl-max` / `glm-4v`）。
- **代理**：服务器在国内调用海外模型时，填 `LLM_PROXY=http://127.0.0.1:7890`，或直接依赖系统 `HTTPS_PROXY`/`HTTP_PROXY`。
- 也可以在 App 的「设置 → 大模型接口」里临时填写 Key / Base / 模型（仅存于本机浏览器，适合个人自用）。

不填 Key 时进入**演示模式**：所有接口都有内置模板兜底，功能完整可体验。

---

## 三、Docker 部署

镜像内不需要安装依赖。

```bash
# 构建
docker build -t douyin-copy:latest .

# 运行（推荐用 env-file 传入配置）
docker run -d --name douyin-copy \
  -p 8000:8000 \
  --env-file .env \
  -v douyin-data:/app/.data \
  --restart unless-stopped \
  douyin-copy:latest
```

- `-v douyin-data:/app/.data`：持久化历史 / 热词 / 样本 / 访问口令，容器重建不丢数据。
- 已内置 `HEALTHCHECK`，`docker ps` 可直接看到健康状态。

### Docker Compose（可选）

```yaml
services:
  douyin-copy:
    build: .
    container_name: douyin-copy
    ports:
      - "8000:8000"
    env_file:
      - .env
    volumes:
      - ./data:/app/.data
    restart: unless-stopped
```

```bash
docker compose up -d --build
```

---

## 四、反向代理（公网部署）

生成接口是 **SSE 长连接**，反代必须关闭缓冲，否则前端会「卡住不出字」。项目已设置 `X-Accel-Buffering: no` 与 15s 心跳，Nginx 再补两行即可：

```nginx
location / {
    proxy_pass         http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;

    # SSE 关键配置
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 300s;
    chunked_transfer_encoding on;
}
```

Caddy 更简单（自动 HTTPS）：

```
example.com {
    reverse_proxy 127.0.0.1:8000
}
```

---

## 五、HTTPS 与 PWA

- 「添加到主屏幕」的完整 PWA 能力（离线缓存、独立图标）**要求 HTTPS**（`localhost` 除外）。
- 两种方式：
  1. **交给反代**：用 Caddy / Nginx + Let's Encrypt，最省事。
  2. **应用自带**：`.env` 里填 `TLS_CERT` / `TLS_KEY` 指向证书与私钥，启动即走 HTTPS。

---

## 六、环境变量速查

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 服务端口 | `8000` |
| `LLM_API_KEY` | 大模型 Key，留空=演示模式 | 空 |
| `LLM_BASE_URL` | OpenAI 兼容 Base URL | `https://api.openai.com/v1` |
| `LLM_MODEL` | 默认模型 | `gpt-4o-mini` |
| `LLM_MODELS` | 回退模型列表（逗号分隔） | 空 |
| `LLM_VISION_MODEL` | 识图模型 | 复用 `LLM_MODEL` |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | 生成参数 | `0.9` / `2600` |
| `LLM_RETRIES` | 单模型重试次数 | `2` |
| `LLM_PROXY` | 出网代理 | 空 |
| `ACCESS_TOKEN` | 固定访问口令（设置后固定，App 内不可改） | 空 |
| `RATE_LIMIT` | 每 IP 每分钟请求上限，`0`=不限流 | `60` |
| `DATA_DIR` | 数据目录 | `./.data` |
| `TLS_CERT` / `TLS_KEY` | 启用 HTTPS 的证书/私钥路径 | 空 |

---

## 七、数据、备份与安全

- 数据目录 `DATA_DIR`（默认 `./.data`）内含 `history.json` / `hotwords.json` / `samples.json` / `auth.json`，**直接打包该目录即可备份**；文件为明文 JSON，注意保管。
- **强烈建议公网部署时设置访问口令**：`.env` 的 `ACCESS_TOKEN`（固定），或在 App「设置 → 访问口令」动态设置。口令以 SHA-256 哈希存储，不明文落盘。
- 已内置按 IP 的令牌桶限流（默认 60 次/分钟，生成接口 20 次/分钟），可自行调 `RATE_LIMIT`。
- 若无需公网访问，只在内网/本机使用时，保持 `ACCESS_TOKEN` 为空即可。

---

## 八、运行测试

```bash
node --test      # 或 npm test
```

覆盖合规校验、样本检索、Markdown 解析/切分、商品页解析、LLM 工具函数、Prompt 组装、演示引擎、访问控制与持久化等纯逻辑。

---

## 九、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 生成时「卡住不出字」 | 反代缓冲未关闭，按第四节配置 `proxy_buffering off` |
| 接口返回 401 | 已启用访问口令；在 App「设置 → 访问口令」填写正确口令 |
| 商品链接解析失败 | 淘宝/抖音/拼多多等有登录与反爬；改为手动复制标题与卖点 |
| 识图提示「模型不支持」 | `LLM_VISION_MODEL` 需为多模态模型（如 `gpt-4o`） |
| 手机打不开内网地址 | 确认手机与服务器同一 WiFi，且系统防火墙放行 `PORT` |
| PWA 无法安装 | 非 `https://` 或非 `localhost` 环境无法完整安装，改用 HTTPS |
