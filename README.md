# Viper

百度网盘分享链接 → 加速直链，跑在 Cloudflare Workers。单用户，登录态换一次性签名票。

## 鉴权模型

```
浏览器登录 (/login, 密码 Session)
        │
        ▼
生成链接 (/gen) ── session 校验 ── 调百度 API ── 存 dlink 到 KV
        │
        ▼
返回 https://<domain>/p?t=<HMAC 签名票>   （15 分钟、一次性）
        │
        ▼
NDM 请求 /p ── 验票 ── 302 到真实 dlink
```

- Session：随机 UUID 存 KV（只存 hash），Cookie `HttpOnly; Secure; SameSite=Lax`。
- 签名票：`v1.<payload>.<HMAC-SHA256>`，含目标 ID、过期时间、随机 nonce；nonce 用后即焚，防重放。
- 未登录：打不开 `/gen`；票泄露：15 分钟失效 + 一次性。

## 部署（CF Workers Builds，CF 侧拉取）

1. 建 KV，记下 id：

```bash
npx wrangler kv namespace create VIPER_KV
```

2. 把 id 填进 `wrangler.toml` 的 `id = "REPLACE_WITH_KV_ID"`。

3. CF 控制台 → Workers & Pages → Create → Connect to Git → 选 `mrjg117/Viper`：
   - Build command：`npm test`（可留空）
   - Deploy command：`npx wrangler deploy`

4. Project → Settings → Secrets and variables 添加 4 个 Secret：

| Secret | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 登录密码 |
| `SIGN_SECRET` | 签名密钥，随机长字符串 |
| `BAIDU_CLIENT_ID` | 百度开放平台 AppKey |
| `BAIDU_CLIENT_SECRET` | 百度开放平台 SecretKey |

回调地址由代码按请求域名自动生成（`/auth/callback`），无需配置项。百度开放平台里登记的回调域名填 Worker 的 `https://<domain>/auth/callback`。

之后 push 到 `main`，CF 自动拉取并部署。

本地部署：填好 toml 的 KV id，`wrangler secret put` 上述 4 个密钥，`npx wrangler deploy`。

首次使用：访问 `/auth/start` 扫码授权百度账号，token 存 KV，Cron 每天自动刷新。

NDM 全局设置一次：`User-Agent = pan.baidu.com`，`Referer = https://pan.baidu.com/`。
302 无法替客户端改 UA，必须在下载器里设。

## 文件

- `src/auth.js` — 鉴权核心：session、HMAC 签名票、一次性校验
- `src/index.js` — Worker 路由 + OAuth + Cron 刷新
- `src/baidu.js` — 分享解析、转存、filemetas 取 dlink、access_token 刷新
- `test/` — 鉴权与路由测试

## 状态

鉴权链路已实现并通过测试。百度取链部分（`src/baidu.js`）按开放平台接口写好，但未接真实账号联调；分享页元信息解析（`shareMeta`）依赖页面内字段，百度改版时需调整。

仅供自有账号自用，账号风控与封禁风险自负。
