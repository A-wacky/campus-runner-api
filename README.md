# 校园跑跑 · 后端部署到 Render（免费、永久地址、不用买域名）

## 这个文件夹是什么

一个**可以直接上传到 GitHub** 的最小后端仓库：

| 文件 | 作用 |
|---|---|
| `server.js` | 后端全部代码（零依赖，只用 Node 内置模块） |
| `package.json` | 声明 `npm start` = `node server.js` |
| `render.yaml` | Render 蓝图，自动建服务 + 生成管理员口令 |
| `.gitignore` | 防止把 `data.json`（含用户数据）传上去 |

> ⚠️ 注意：**不要**把 `H:\campus-runner\server\data.json` 传上来。里面有 7 个真实注册用户的手机号和密码哈希。服务首次启动会自己生成种子数据。

---

## 第一步：建 GitHub 仓库并上传

1. 打开 https://github.com/new
2. Repository name 填 `campus-runner-api`
3. 选 **Public**（Render 免费版要求公开仓库）→ Create repository
4. 在新仓库页面点 **Add file → Upload files**
5. 把本文件夹里这 4 个文件拖进去（`server.js`、`package.json`、`render.yaml`、`.gitignore`）
6. 点 **Commit changes**

上传完仓库根目录应该能看到这 4 个文件（不是套在一个子文件夹里）。

---

## 第二步：在 Render 建服务

1. 回到 https://dashboard.render.com 的 **Create a new Web Service**
2. 点 **Web Services 网络服务** 那张卡片 → **New Web Service →**
3. **Connect a repository** → 授权 GitHub → 选 `campus-runner-api`
4. 填写：

| 项 | 值 |
|---|---|
| Name | `campus-runner-api` |
| Region | **Singapore**（离国内最近） |
| Branch | `main` |
| Root Directory | 留空 |
| Runtime | **Node** |
| Build Command | `echo "zero dependencies, nothing to build"` |
| Start Command | `node server.js` |
| Instance Type | **Free** |

5. **Environment Variables** 里加两条：
   - `CAMPUS_ADMIN_PASSWORD` = 自己起一个强口令（管理员账号 `202325817` 的密码）
   - `NODE_VERSION` = `20`
6. 点 **Deploy Web Service**

等 1–3 分钟，日志出现 `服务已启动` 类似字样就成功了。

你的永久地址会是：

```
https://campus-runner-api.onrender.com
```

打开 `https://campus-runner-api.onrender.com/ping` 应该返回：

```json
{"ok":true,"service":"campus-runner","version":"1.5.3",...}
```

---

## 第三步：防止免费实例休眠

Render 免费实例 **15 分钟无请求就会休眠**，下次访问要冷启动 30–50 秒。

用免费定时器保活：

1. 注册 https://cron-job.org （免费）
2. 建一个 cron job：URL 填 `https://campus-runner-api.onrender.com/ping`，间隔 **10 分钟**
3. 保存并启用

这样它就一直醒着。

---

## ⚠️ 必须知道的两个限制

### 1. 数据会丢

Render 免费实例的文件系统是**临时的**：

- 重新部署 → `data.json` 清空
- 实例重启 → 清空
- 休眠后再唤醒 → 清空

也就是说**用户注册的账号、发布的任务、聊天记录，在重新部署后会全部消失**，回到初始种子数据。

保活能避免「休眠丢数据」，但**每次你推送代码更新都会丢**。

如果数据必须留住，三个选择：

- 升级 Render 付费磁盘（$7/月起）
- 改用 Render 免费 Key Value（Redis，25 MB）+ 改存储层（需要改代码，约 1–2 小时）
- **用 ngrok 静态域名把后端留在自己电脑上** —— 数据存在本地硬盘，不会丢，最省事

### 2. 免费额度

- 每月 750 小时（单实例够用，刚好不超）
- 出口带宽 100 GB/月

校园内几十人用足够。

---

## 对比：为什么还可能选 ngrok

| | Render | ngrok 静态域名 |
|---|---|---|
| 花钱 | 0 | 0 |
| 地址固定 | ✅ | ✅ |
| 电脑要开 | ❌ | ✅ 要 |
| 数据持久 | ❌ 会丢 | ✅ 存本地 |
| 需要 GitHub | ✅ | ❌ |
| 冷启动 | 有（保活可解决） | 无 |

**结论**：想「关机也能用」选 Render，想「数据不丢」选 ngrok。

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 部署失败 `Cannot find module` | 文件没放在仓库根目录 | 确认 `server.js` 和 `package.json` 在同一层 |
| 打开 `/ping` 超时 30 秒后成功 | 免费实例冷启动 | 正常，配保活 |
| 打开 `/ping` 返回 404 | Root Directory 填错了 | 清空它 |
| App 连不上但浏览器能开 | App 里地址带结尾斜杠 | 去掉结尾的 `/` |
| `502 Bad Gateway` | 进程启动就崩了 | 看 Render 的 Logs，多半是 Node 版本太低 |
