# CFMC-Edge 部署指南

> 从零开始，把一套 Serverless Minecraft 服务器部署到 Cloudflare 全球边缘网络。
> 架构与设计背景见 [README.md](README.md)，本指南只回答三件事：**怎么跑起来、怎么验证、怎么运维**。

## 目录

- [0. 部署概览](#0-部署概览)
- [1. 前置要求](#1-前置要求)
- [2. 快速部署（五分钟版）](#2-快速部署五分钟版)
- [3. 详细步骤](#3-详细步骤)
- [4. 自定义域名（可选）](#4-自定义域名可选)
- [5. 运维手册](#5-运维手册)
- [6. 升级与扩展](#6-升级与扩展)
- [7. 故障排查](#7-故障排查)
- [8. 安全加固清单](#8-安全加固清单)
- [9. 附录](#9-附录)

## 0. 部署概览

一次 `wrangler deploy` 会部署 **1 个 Gateway Worker**（内含 Auth/Game 路由与限流/CORS 中间件）+ **3 类 Durable Object**（WorldManagerDO / RegionDO / ChatDO），并绑定 2 个 D1 数据库、1 个 KV、1 个 R2、1 个 Queue：

```
玩家 (cfmc-client Mod)
   │  WSS · CFMC 自定义二进制协议 v2
   ▼
Gateway Worker (src/index.js)          ← 部署主体: 路由/认证/限流
   │                │
   ▼                ▼
Auth Worker      Durable Objects 层 (按需创建, 无人自动休眠)
(四种认证模式)   WorldManagerDO · RegionDO × N · ChatDO
   │                │
   └──── D1 × 2 / KV / R2 / Queue ────
```

对外端点一览（部署验证时会用到）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `GET /` | GET | 服务信息 + 全协议支持范围（客户端 Mod 服务发现） |
| `GET /health` | GET | 健康检查（监控探针打这里） |
| `GET /ws/game` | WebSocket | 游戏连接入口（升级后转发给 RegionDO） |
| `POST /auth/login` | POST | 登录，换取 Access/Refresh 双 Token |
| `POST /auth/refresh` | POST | 刷新 Access Token |
| `POST /auth/validate` | POST | 校验 Token 有效性 |
| `POST /auth/invalidate` | POST | 吊销 Token（登出） |
| `ANY /api/*` | — | REST API：统计/在线/聊天历史 + 管理（封禁/广播/维护，需 X-Admin-Token） |

## 1. 前置要求

### 1.1 账号与工具

| 项目 | 要求 | 说明 |
|------|------|------|
| Cloudflare 账号 | 必需 | Free 计划即可部署（SQLite-backed Durable Objects 已支持免费计划） |
| Node.js | ≥ 18 | 建议 20 LTS；`node -v` 确认 |
| npm | 随 Node | 仅安装 wrangler 等开发工具链，不进入运行时 |
| 客户端 Mod | 联机测试用 | 到 [cfmc-client Releases](https://github.com/ZerexaNet/cfmc-client/releases) 下载对应版本的 jar |

### 1.2 计划与配额（Free vs Paid）

> 配额数字会随官方调整变化，下表仅作部署决策参考，请以 Cloudflare 官方文档为准。

| 维度 | Free 计划 | Paid 计划（$5/月起） |
|------|-----------|---------------------|
| Workers 请求数 | 10 万次/天 | 无硬上限（按量计费） |
| Durable Objects | SQLite-backed DO 可用，有每日请求配额 | 更高配额 |
| D1 | 5 GB 存储 / 500 万行读·天 | 更高 |
| WebSocket（Hibernation） | 支持 | 支持 |
| 适合场景 | 测试服 / 朋友服（20 人以内） | 公开服 / 多区域大服 |

**费用直觉**：CFMC 的核心设计是"没人玩的区域 DO 自动休眠"（Alarm + WebSocket Hibernation），因此闲置成本为零；小规模服的主要开销集中在 DO 请求与 D1 行读写上，Free 计划通常够用，玩家量上来后再升级 Paid。

### 1.3 你不需要准备的东西

- **不需要 VPS / 公网 IP / 域名证书**：TLS 由 Cloudflare 边缘自动处理；
- **不需要 Docker / 常驻进程**：Worker 按请求冷启动，DO 按需拉起；
- **不需要提前建库**：第 3.3 节的脚本一条命令完成建库建表。

## 2. 快速部署

### 2.1 方式 A：一键部署（推荐，零命令行）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZerexaNet/cfmc-server)

点击按钮后，Cloudflare 会完成三件事：**克隆仓库到你的 GitHub 账号** → **自动供给并绑定资源**（2×D1、KV、3 类 Durable Objects，平台读取本仓库 `wrangler.toml`）→ **Workers Builds 构建部署**（执行 `npx wrangler deploy`）。

> ⚠️ **一键部署不会自动建表**：按钮的部署命令只执行 `wrangler deploy`，不跑 `db:migrate`，
> 因此两个 D1 库创建后是**空的**（无任何表）。这不影响连接（服务端已做降级兼容），
> 但玩家数据/封禁/区块持久化会静默失效，**部署后请务必完成下面的建表步骤（一次性）**。

向导中需要你做的只有两件事：

1. **输入 Secrets**（清单见 [.dev.vars.example](.dev.vars.example)，向导逐项提示）：
   - `AUTH_JWT_SECRET`：JWT 签名密钥，填 `openssl rand -hex 32` 的输出（或任意强随机串）；
   - `ADMIN_TOKEN`：管理面板/管理 API 令牌，同样填强随机值。
2. **等待构建完成**，记下向导给出的 `https://cfmc-edge.<你的子域>.workers.dev` 地址。

验证：

```bash
curl https://cfmc-edge.<你的子域>.workers.dev/health
# → {"status":"ok",...} 即部署成功

# 自检: 浏览器打开也可, 逐项报告 D1 建表/KV/DO 状态与修复指引
curl https://cfmc-edge.<你的子域>.workers.dev/debug/selftest
```

**建表（一键部署后必做一次，两个库都要）**：Dashboard → Storage & Databases → D1 SQLite →
依次点开两个库 → **Console** 标签 → 分别粘贴以下仓库文件全文并执行（SQL 幂等，重跑无副作用）：

| D1 库（名字以你向导里实际命名为准） | 要粘贴的仓库文件 |
|------|------------------|
| `cfmc-users` | `src/storage/migrations/users/0001_init.sql` |
| `cfmc-world` | `src/storage/migrations/world/0001_init.sql` |

偏好命令行的话，等价操作（在克隆的仓库目录内，名字换成你的实际库名）：

```bash
npx wrangler d1 execute cfmc-users --remote --file=src/storage/migrations/users/0001_init.sql -y
npx wrangler d1 execute cfmc-world --remote --file=src/storage/migrations/world/0001_init.sql -y
```

客户端 Mod 连接 `wss://cfmc-edge.<你的子域>.workers.dev/ws/game`；管理面板在 `https://<该地址>/admin`。

> - **R2 与 Queue 默认未启用**（免费账号开箱即用，二者为预留绑定），启用见 3.5；
> - 一键部署后续：克隆到你账号的仓库 push 即自动重新部署；改名/换域名/资源调参见第 3、6 章。

### 2.2 方式 B：CLI 部署（五分钟版）

已经熟悉 Cloudflare 生态的话，照抄即可；每一步的细节见第 3 节。

```bash
# 0. 克隆并安装依赖
git clone https://github.com/ZerexaNet/cfmc-server.git
cd cfmc-server && npm install

# 1. 登录 Cloudflare（弹出浏览器授权）
npx wrangler login

# 2. 初始化 D1：创建 2 个库 + 自动回填 wrangler.toml 占位符 + 按迁移建表
bash scripts/init-d1.sh

# 3. 创建 KV 命名空间，把输出的 id 填入 wrangler.toml 的 <YOUR_KV_NAMESPACE_ID>
npx wrangler kv namespace create CACHE

# 4. 配置密钥（Secret 保存，不落盘、不进 git）
openssl rand -hex 32 | npx wrangler secret put AUTH_JWT_SECRET
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN      # 管理面板/管理 API 令牌
npx wrangler secret put ALERT_WEBHOOK_URL                       # 可选，粘 webhook 地址

# 5. 部署（R2/Queue 为可选预留绑定，默认未启用，见 3.5）
npm run deploy   # 自动先应用 D1 迁移（已应用则跳过），再 wrangler deploy

# 6. 验证（URL 换成上一步输出的 workers.dev 地址）
curl https://cfmc-edge.<你的子域>.workers.dev/health
```

看到 `{"status":"ok",...}` 即部署成功。客户端 Mod 连接地址为 `wss://cfmc-edge.<你的子域>.workers.dev/ws/game`。

## 3. 详细步骤

### 3.1 安装工具链

```bash
# Node.js ≥ 18（Ubuntu 示例，其他平台用官方安装包）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 克隆项目并安装开发依赖（wrangler 只出现在 devDependencies，不会打包进 Worker）
git clone https://github.com/ZerexaNet/cfmc-server.git
cd cfmc-server
npm install
```

本项目**运行时零第三方依赖**（`dependencies` 为空），`npm install` 装的全是开发工具链，这也是 Workers 冷启动快的前提。

### 3.2 登录 Cloudflare

**方式 A：浏览器授权（个人电脑，推荐）**

```bash
npx wrangler login
npx wrangler whoami   # 验证：打印账号邮箱与权限即成功
```

**方式 B：API Token（服务器 / CI 无浏览器环境）**

1. 打开 Dashboard → 右上角头像 → **My Profile → API Tokens → Create Token**；
2. 使用 **Edit Cloudflare Workers** 模板（含 Workers/D1/KV/R2/Queue 的写权限）；
3. 把 Token 写入环境变量（**不要**提交到 git）：

```bash
export CLOUDFLARE_API_TOKEN="你的token"
export CLOUDFLARE_ACCOUNT_ID="你的account_id"   # Dashboard 首页右侧可见
npx wrangler whoami                              # 验证
```

### 3.3 初始化 D1 数据库

```bash
bash scripts/init-d1.sh
```

脚本自动完成三件事：

1. 创建 `cfmc-users`（账号/审计）与 `cfmc-world`（类 Cesium 地图存档）两个 D1 库；
2. 从命令输出提取 `database_id`，**自动替换** `wrangler.toml` 里的两个占位符；
3. 按 wrangler 标准迁移建表：`wrangler d1 migrations apply USERS_DB/WORLD_DB`（迁移文件在 `src/storage/migrations/{users,world}/0001_init.sql`，全幂等，重复执行无副作用）。

手动等效命令（想逐步执行时用）：

```bash
npx wrangler d1 create cfmc-users          # 输出中的 database_id 记下
npx wrangler d1 create cfmc-world
# 编辑 wrangler.toml 替换两个 <YOUR_XXX_DB_ID> 后：
npx wrangler d1 migrations apply USERS_DB --remote
npx wrangler d1 migrations apply WORLD_DB --remote
```

只想先本地跑通（无需 Cloudflare 账号）：

```bash
bash scripts/init-d1.sh --local   # miniflare 在本地模拟 D1，占位符无需替换
npm run dev                        # http://localhost:8787
```

### 3.4 创建 KV 命名空间

KV 用于会话缓存 / Refresh Token / 皮肤纹理缓存等读多写少场景：

```bash
npx wrangler kv namespace create CACHE
# 输出示例: id = "abcd1234..."
# 把 id 填入 wrangler.toml:
#   [[kv_namespaces]]
#   binding = "CACHE"
#   id = "abcd1234..."
```

### 3.5 R2 与 Queue（可选预留绑定，默认未启用）

`wrangler.toml` 中 `[[r2_buckets]]`（备份归档）与 `[[queues.producers]]`（异步任务削峰）**默认处于注释状态**——二者是预留能力，当前代码不会访问，不启用不影响任何功能；且 R2 需在 Dashboard 开通一次（免费，但账号需绑定支付方式）、Queue 需 Workers Paid 计划，默认关闭可让免费账号开箱即用（含一键部署）。

需要启用时：

```bash
# R2: Dashboard → R2 页面点一次开通(免费, 需绑定支付方式)，或直接:
npx wrangler r2 bucket create cfmc-backups

# Queue: 需 Workers Paid 计划 (注意: 队列名是 cfmc-events, 不是绑定名 EVENTS_QUEUE)
npx wrangler queues create cfmc-events
```

然后取消 `wrangler.toml` 中对应段落的注释并重新部署即可。

> ⚠️ **Queue 段落不能简单去掉 `#`**：wrangler v4 里顶层 `queues` 必须是对象，
> 生产者要写成 `[[queues.producers]]`（配置内已用正确语法预写好）。若手动改成
> `[[queues]]` 会报错 `The field "queues" should be an object but got [...]`。
> 另外若要加消费者 `[[queues.consumers]]`，需先在 `src/index.js` 导出
> `async queue(batch, env, ctx)` handler，否则部署会被 API 拒绝。

### 3.6 核对 wrangler.toml

**一键部署用户跳过本节**（资源 ID 由平台自动供给并回写）。CLI 手动部署前确认三个占位符都已替换：

| 占位符 | 来源 | 绑定 |
|--------|------|------|
| `<YOUR_USERS_DB_ID>` | `init-d1.sh` 自动回填（或 `wrangler d1 info cfmc-users`） | `d1_databases.USERS_DB` |
| `<YOUR_WORLD_DB_ID>` | 同上（`cfmc-world`） | `d1_databases.WORLD_DB` |
| `<YOUR_KV_NAMESPACE_ID>` | `wrangler kv namespace create CACHE` 输出 | `kv_namespaces.CACHE` |

常用环境变量（`[vars]`，可按需调整，改后重新 `deploy` 生效）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEFAULT_AUTH_MODE` | `hybrid` | 全服默认认证模式：`online`（正版）/ `offline` / `skin_server` / `hybrid` |
| `DEFAULT_SKIN_SERVER` | `https://ely.by` | 外置皮肤站地址（也可 `https://littleskin.cn` 或自建） |
| `MAX_PLAYERS_PER_REGION` | `25` | 单区域（16×16 区块柱）最大玩家数 |
| `TICK_RATE_MS` | `50` | Tick 间隔，50ms = 20 TPS（与原版一致） |
| `PERSIST_INTERVAL_MS` | `5000` | 脏区块落盘 D1 的间隔，调大省配额、调小降低丢档窗口 |
| `VIEW_DISTANCE` | `6` | 区块视距 |
| `COMPRESSION_THRESHOLD` | `256` | 包体超过该字节数才压缩 |

### 3.7 配置 Secrets（必须；一键部署已在向导输入）

| Secret | 必需 | 用途 |
|--------|------|------|
| `AUTH_JWT_SECRET` | 是 | 签发/校验 Access Token |
| `ADMIN_TOKEN` | 面板用 | Web 管理面板（`/admin`）与管理 API（`/api/admin/*`）鉴权 |
| `ALERT_WEBHOOK_URL` | 否 | 监控告警 webhook（Discord/飞书 Incoming Webhook 等） |

```bash
# 生成 64 位强随机 hex 并直接写入 Secret（不经过 shell 历史，不落盘）
openssl rand -hex 32 | npx wrangler secret put AUTH_JWT_SECRET
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ALERT_WEBHOOK_URL   # 可选，粘 webhook 地址
```

- Secret 与代码分离，`wrangler.toml` 里**永远不要**写真实密钥；
- Secrets 清单模板见 [.dev.vars.example](.dev.vars.example)：一键部署向导据此逐项提示；本地开发复制为 `.dev.vars`（已被 .gitignore 忽略）后填值；
- `AUTH_JWT_SECRET` 漏配时服务端会首次自动生成随机密钥存入 KV 并打警告（每次部署唯一、重启不失效，不再依赖公共 dev 密钥），但生产环境仍应显式配置以便轮换；
- 多环境时 Secret 按环境隔离：`npx wrangler secret put AUTH_JWT_SECRET --env production`；
- 轮换：重新执行 `secret put` 即可，已登录玩家下次请求 401 后需重新登录（客户端会自动跳转认证界面）。

### 3.8 本地开发与联调

```bash
npm run dev      # wrangler dev, 默认 http://localhost:8787
npm test         # vitest 单元测试 (协议编解码/认证/版本注册表)
```

浏览器打开 `http://localhost:8787/health`，或用双标签页验证 WebSocket 互聊（Phase 1 验收标准）：

```javascript
// 两个标签页各执行一段, 即可互发聊天
const ws = new WebSocket("ws://localhost:8787/ws/game?uuid=test-1&name=Alice");
ws.onmessage = (e) => console.log("收到:", e.data);
ws.onopen = () => ws.send(JSON.stringify({ type: "chat", msg: "hello" }));
```

### 3.9 部署上线

```bash
npm run deploy        # = wrangler deploy
```

- 输出末尾会给出 `https://cfmc-edge.<你的子域>.workers.dev` 访问地址；
- 首次部署时 `[[migrations]]` 里的 DO 迁移（`new_sqlite_classes`）会自动执行，**不需要**手动跑任何 DO 命令；后续部署迁移 tag 不变则自动跳过；
- 生产环境建议用命名环境隔离配置：`wrangler deploy --env production`（对应 `wrangler.toml` 的 `[env.production]` 段；注意该环境的 vars/secrets/路由需单独配置）。

### 3.10 部署验证

```bash
BASE=https://cfmc-edge.<你的子域>.workers.dev

# 1. 健康检查: 应返回 {"status":"ok","colo":"...","timestamp":...}
curl $BASE/health

# 2. 服务信息: 确认 protocolVersion 为 2, mcSupport 显示支持的 MC 版本范围
curl $BASE/

# 3. 部署自检: D1 建表/KV/DO 逐项探测, 任何一项失败都会给出修复指引
curl $BASE/debug/selftest
```

`/` 返回的 `mcSupport` 字段即"全协议支持"的自检结果（正常应显示 1.8 ~ 1.21.x 均可接入）。最后用客户端 Mod 实测：安装对应版本 jar → 按 P 打开连接界面 → 填入 `wss://cfmc-edge.<你的子域>.workers.dev/ws/game` → 选择认证模式登录进服。

### 3.11 管理面板与运维端点（Phase 3）

- 面板：浏览器打开 `https://<你的域名>/admin`，输入 `ADMIN_TOKEN` 即可查看在线/区域/TPS、踢人、封禁、全服广播、维护模式开关、聊天审计；
- API：`GET /api/stats` / `GET /api/online` 公开只读；`/api/admin/*` 需 `X-Admin-Token` 头；
- 旧世界导入：`npm run import:anvil -- <anvil存档目录>`（解析 region/*.mca → Cesium SQL → 灌入 D1）。

## 4. 自定义域名（可选）

`workers.dev` 子域开箱即用；若想用自有域名（如 `mc.example.com`）：

1. 域名的 DNS 托管到该 Cloudflare 账号（Free 计划即可）；
2. Dashboard → **Workers & Pages → cfmc-edge → Settings → Domains & Routes → Add → Custom Domain**，填 `mc.example.com`，CF 自动签发证书并绑定路由；
3. 或用 wrangler 在 `wrangler.toml` 声明：

```toml
routes = [
  { pattern = "mc.example.com", custom_domain = true }
]
```

客户端连接地址相应改为 `wss://mc.example.com/ws/game`。

## 5. 运维手册

### 5.1 实时日志

```bash
npm run tail                      # wrangler tail --format pretty
npx wrangler tail --format json   # 原始 JSON (结构化字段: level/latency_ms/path...)
```

日志来自 Gateway Worker 的结构化 Logger（`workers/logger.js`），含请求路径、状态码、耗时；DO 内的 `console.log` 也会出现在同一数据流中。Ctrl+C 停止。

### 5.2 指标与监控

- **Dashboard → Workers & Pages → cfmc-edge → Metrics**：请求数、错误率、CPU 时间、DO 请求量与 WebSocket 连接数；
- **外部拨测**：把 `GET /health` 接入 UptimeRobot/Better Stack 等免费拨测（5 分钟间隔足够）；
- 长期建议（Phase 3）：Logpush 把 JSON 日志投递到 R2/第三方做留存分析。

### 5.3 版本管理与回滚

```bash
npx wrangler deploy --dry-run --outdir dist   # 只打包不上传, 预览将部署的内容
npx wrangler versions list                    # 查看历史版本
npx wrangler rollback                         # 交互式回滚到上一版本 (秒级生效)
```

### 5.4 数据备份

```bash
# 导出世界库 (SQL 文本)
npx wrangler d1 export cfmc-world --remote --output=world-$(date +%F).sql

# 归档到 R2 的 BACKUPS 桶
npx wrangler r2 object put cfmc-backups/world-$(date +%F).sql --file=world-$(date +%F).sql

# 同理备份账号库
npx wrangler d1 export cfmc-users --remote --output=users-$(date +%F).sql
```

建议每周手动（或用任一台有 wrangler 的机器跑 cron）备份一次；`world_meta` 表里的 `updated_at` 可用于核对备份新鲜度。

### 5.5 数据巡检

```bash
# 世界体量: 区块/方块变更数
npx wrangler d1 execute cfmc-world --remote --command "SELECT count(*) AS chunks FROM chunks"
npx wrangler d1 execute cfmc-world --remote --command "SELECT count(*) AS edits FROM block_change_log"

# 账号库: 注册与最近登录
npx wrangler d1 execute cfmc-users --remote --command "SELECT count(*) AS users FROM users"
npx wrangler d1 execute cfmc-users --remote --command "SELECT * FROM login_audit ORDER BY id DESC LIMIT 10"
```

## 6. 升级与扩展

### 6.1 拉取上游更新

```bash
git pull origin main
npm install          # devDependencies 可能更新 (wrangler 版本)
npm test             # 先跑测试
npm run deploy       # 自动应用新增 D1 迁移 (幂等), 再部署
```

> **从 Phase 2 时代的老库升级**（迁移机制引入前的部署，`player_data` 缺 `role`/`coins` 列）：迁移 0001 对已存在的表是 no-op，补列需手动执行一次增量脚本：
> `npx wrangler d1 execute USERS_DB --remote --file=src/storage/migrations/002-phase3-p4.sql -y`
> （SQLite 无 ADD COLUMN IF NOT EXISTS，重复执行报 duplicate column 属预期；缺列场景跑一次即可）。

常规更新不涉及 DO 迁移与 schema 变更时，以上四条即可；涉及变更见 6.2。

### 6.2 Schema 变更流程

1. 新增迁移文件：`src/storage/migrations/users/0002-xxx.sql`（账号库）或 `src/storage/migrations/world/0002-xxx.sql`（世界库），**只加列/加表，不重命名不删除**（老数据无损）；
2. 无需手动执行——下次 `npm run deploy`（含一键部署触发的自动构建）会按序号自动应用未跑过的迁移，并在 D1 的 `d1_migrations` 表中登记；
3. 迁移语句保持幂等（IF NOT EXISTS），可安全重跑。

### 6.3 性能与成本调参

| 想要 | 调整 |
|------|------|
| 更流畅的战斗/移动 | `TICK_RATE_MS` 调小（如 40），注意 DO CPU 配额消耗同步上升 |
| 降低 D1 账单 | `PERSIST_INTERVAL_MS` 调大（如 10000）；视距 `VIEW_DISTANCE` 调小 |
| 更多同区域玩家 | `MAX_PLAYERS_PER_REGION` 调大，观察 tail 日志确认无 CPU 超限告警 |
| 弱网环境省流量 | `COMPRESSION_THRESHOLD` 调小（更多包走压缩） |

### 6.4 多环境管理

`wrangler.toml` 的 `[env.production]` 支持整套独立配置（vars/路由/绑定 id 均可不同），Secrets 按环境隔离（`--env production`）。命名规则建议：日常开发直接部署默认环境，正式服统一用 `--env production`。

## 7. 故障排查

| 症状 | 可能原因 | 解决 |
|------|----------|------|
| `wrangler deploy` 报 D1 id 无效 | 手动部署占位符未替换 / id 抄错 | 核对 3.6 的三个占位符；`wrangler d1 list` 比对（一键部署自动回写 id，不会出现） |
| 部署成功但 `/health` 500 | 绑定缺失（KV 未创建却被 toml 引用 / 自行启用 R2/Queue 后未真正创建） | `npm run tail` 看堆栈；缺什么按 3.4/3.5 补建，或注释对应段落 |
| WebSocket 握手返回 401 | Token 缺失/过期，或认证模式不匹配 | 检查客户端 `DEFAULT_AUTH_MODE`；`/auth/login` 重新换取 Token |
| WebSocket 握手返回 500 / 客户端"连接异常断开" | 握手链路本身故障（路由/鉴权/DO 升级链） | 打开 `GET /debug/selftest` 看 `handshake.e2e` 项：失败时 detail 会显示服务端返回的**完整错误 body**（客户端 mod 只显示状态码），按内容定位；或 `npm run tail` 复现后看 `region_fetch_fail` 堆栈 |
| `/debug/selftest` 报"缺表: bans, ..." | D1 库建了但迁移没跑（一键部署不执行 `db:migrate`） | 按 2.1 的建表步骤在 D1 Console 粘贴对应 0001 SQL；或 CLI `npx wrangler d1 execute <库名> --remote --file=<对应SQL> -y` |
| `wrangler login` 卡住 | 服务器/远程环境无浏览器 | 用 3.2 方式 B 的 API Token + 环境变量 |
| 本地 `wrangler dev` 报 Queue 配置错误 | 自行启用了 Queue，但本地模拟不支持 producer-only 配置 | `[[queues.producers]]` 默认已注释；若自行启用后遇到，注释掉即可 |
| 部署报 `The field "queues" should be an object` | Queue 段被写成顶层 `[[queues]]` 数组（v4 非法形态，常见于取消注释时手滑） | 改回 `[[queues.producers]]` + `binding`/`queue` 两行（见 wrangler.toml 预写模板） |
| 游戏内 1101 / DO 重启频繁 | DO CPU 超限（单 Tick 计算过大） | 调大 `PERSIST_INTERVAL_MS`；检查是否有异常玩家刷包（tail 观察） |
| 客户端提示"协议版本不支持" | 服务端 `version-registry.js` 缺该 MC 版本条目 | 在版本表加一行协议号（全协议支持机制的设计就是加一行） |
| 聊天/方块正常但区块不加载 | WORLD_DB 未建表（跳过了迁移步骤） | `npm run db:migrate`（幂等），或重跑 `bash scripts/init-d1.sh` |
| 请求全部 429 | 触发内存限流器（120 次/分/IP） | 属预期行为；如误伤可调 `src/index.js` 的 `maxRequests` |

**通用排查路径**：`npm run tail` 复现问题 → 看首个 error 级日志的 `stack` → 对照上表处理。`/health` 的 `colo` 字段可确认命中的边缘节点，用于区分"单区域故障"与"全局故障"。

## 8. 安全加固清单

上线公开服之前逐项过一遍：

- [ ] `AUTH_JWT_SECRET` 已用 `openssl rand -hex 32` 生成，且只存在 Secret 中（一键部署用户：确认向导中输入的是强随机值而非留空）；
- [ ] `DEFAULT_AUTH_MODE` 与运营策略一致（公开服建议 `online` 或 `hybrid`，纯 `offline` 有被盗号风险）；
- [ ] Cloudflare 账号已开启两步验证；API Token 用最小权限模板且设了过期时间；
- [ ] 评估限流参数（`src/index.js` 中 120 次/分/IP）是否匹配预期人数；
- [ ] CORS：当前为开发宽松策略，Web 管理面板（Phase 3）上线前改为域名白名单；
- [ ] 每周备份 D1 到 R2（5.4），并做过一次恢复演练；
- [ ] `git remote -v` 确认仓库不含任何 Token（Secret 只在 Cloudflare 侧）。

## 9. 附录

### 9.1 资源绑定清单

| 绑定名 | 类型 | 资源名 | 创建命令 | 用途 |
|--------|------|--------|----------|------|
| `USERS_DB` | D1 | `cfmc-users` | `wrangler d1 create cfmc-users` | 账号/玩家数据/登录审计 |
| `WORLD_DB` | D1 | `cfmc-world` | `wrangler d1 create cfmc-world` | 类 Cesium 地图存档（7 表） |
| `CACHE` | KV | 命名空间 CACHE | `wrangler kv namespace create CACHE` | 会话/Refresh Token/皮肤缓存 |
| `BACKUPS` | R2 | `cfmc-backups` | 默认未启用（wrangler.toml 已注释），启用见 3.5 | 世界备份/大文件托管（预留） |
| `EVENTS_QUEUE` | Queue | `EVENTS_QUEUE` | 默认未启用（需 Paid 计划），启用见 3.5 | 异步任务削峰（预留） |
| `WORLD_MANAGER` | DO | WorldManagerDO | 随代码部署 | 单例协调：路由表/在线状态 |
| `REGION` | DO | RegionDO | 随代码部署 | 区域游戏引擎（20TPS Tick） |
| `CHAT` | DO | ChatDO | 随代码部署 | 全服聊天 |

### 9.2 常用命令速查

```bash
npm run dev                 # 本地开发 (miniflare 全模拟)
npm run deploy              # 自动应用 D1 迁移后部署
npm run db:migrate          # 手动应用远端 D1 迁移 (幂等)
npm run db:migrate:local    # 本地模拟库应用迁移
npm run tail                # 实时日志
npm test                    # 单元测试
npm run init:d1             # D1 建库 + 回填 id + 应用迁移 (远端)
npm run init:d1:local       # D1 本地模拟建表
npx wrangler whoami         # 登录状态
npx wrangler d1 list        # 列出 D1 库
npx wrangler versions list  # 部署历史
npx wrangler rollback       # 回滚
```

### 9.3 参考文档

- Workers 概览与 DO：https://developers.cloudflare.com/durable-objects/
- D1（含配额）：https://developers.cloudflare.com/d1/
- WebSocket Hibernation API：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- wrangler 命令手册：https://developers.cloudflare.com/workers/wrangler/commands/
- 配套客户端（含 Actions 自动打包说明）：https://github.com/ZerexaNet/cfmc-client

