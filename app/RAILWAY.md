# Railway 部署必读

## 最简步骤（5 分钟）

### 前置条件
- 有 GitHub 账号（没有就去 github.com 免费注册）
- 电脑装了 git（已经有了，C:\Users\Administrator\Tools\PortableGit\bin\git.exe）

### Step 1：推代码到 GitHub
```powershell
# 打开 PowerShell，cd 到项目根目录
cd E:\MigratedData\UserFolders\Documents\Trae-CN\default\douyin-copy-generator

# 初始化 git 仓库（如果还没有）
#（已经有了，跳过）

# 在 GitHub 创建一个新仓库（网页操作），然后本地推上去
git remote add origin https://github.com/<你的用户名>/douyin-copy-generator.git
git push -u origin master
```

### Step 2：Railway 一键部署
1. 打开 https://railway.app ，GitHub 账号登录
2. 点击 **「New Project」→「Deploy from GitHub repo」**
3. 选刚推的仓库（douyin-copy-generator）
4. 等待自动构建（30 秒 ~ 2 分钟）

Railway 会自动识别 `app/Dockerfile` → 构建镜像 → 部署 → 分配 HTTPS 域名（形如 `douyin-copy.up.railway.app`）。

### Step 3：配置大模型 Key（在 Railway 网页端）
1. 项目构建完成后，点左侧 **「Variables」**
2. 逐个添加（key 不用进代码仓库，安全）：

| KEY | VALUE |
|---|---|
| `LLM_API_KEY` | `（在 Railway 后台填你的 Ark Key，不要写进代码仓库）` |
| `LLM_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` |
| `LLM_MODEL` | `doubao-seed-2-1-turbo-260628` |
| `PORT` | `8000` |

3. 保存后自动重启服务

### Step 4：拿到 HTTPS 域名
项目页面 → 点击 **「Settings」→「Networking」→「Public Networking」** 里看到的域名（例如 `douyin-copy.up.railway.app`），复制保存。

### Step 5：手机安装 PWA（零证书折腾）
- iPhone：Safari 打开 `https://你的域名` → 菜单栏「分享」→「添加到主屏幕」
- Android：Chrome 打开 → 右上角菜单「添加到主屏幕」

### ⚠️ Railway 免费额度注意
- 每月 $5 额度，够一台机器跑 24/7（约 750 小时）
- 如果只在手机用、一天开几小时，额度够用到月底
- 超出会自动停机，不扣钱

---

## 数据持久化
历史记录 / 热词库 / 样本库 存在 SQLite，Railway 自动为 Dockerfile 路线创建持久卷（`app/.data`），重建不丢数据。

如果 Railway 没自动挂载，在项目页面 **「Settings」→「Volumes」** → 「Create New Volume」→ 路径填 `/app/.data`，保存。

---

## 更新部署
改完代码本地 commit 后：
```powershell
git push
```
Railway 会自动检测 GitHub 仓库变化、重新构建、部署。

---

## 域名（可选）
想用自己的域名？Railway 项目 →「Settings」→「Networking」→「Custom Domain」→ 输入域名，按提示加 CNAME 记录。Railway 自动申请 Let's Encrypt 证书。
