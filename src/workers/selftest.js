/**
 * ============================================================================
 * Selftest — 部署自检端点 (GET /debug/selftest)
 * ============================================================================
 *
 * 为什么需要它:
 *   "连接报 500 / 异常断开" 的可疑点很多 — D1 表没建 / KV 缺失 / DO 类未注册 /
 *   Secret 没配。传统做法是 wrangler tail 翻日志, 对新手门槛高; 本端点把
 *   全部关键依赖逐项探测一遍, 浏览器打开即见结论, 30 秒定位问题层。
 *
 * 设计原则:
 *   - 只读 + 幂等: 不写业务表 (CACHE 探针键用完即删, TTL 60s 兜底)
 *   - 逐项隔离: 单项失败不影响后续检查 (Promise 全 try-catch)
 *   - 失败项给出"下一步动作"文案, 直接可操作
 *
 * 安全性: 不暴露任何敏感值 (不回显 Secret 内容, 只报告"是否已配置");
 *   无鉴权也可安全公开 (只泄露表名与状态布尔值, 无业务数据)。
 * ============================================================================
 */

import { jsonResponse } from './gateway.js';

/** 逐项执行并收集结果 (单项失败不中断) */
async function step(checks, name, hint, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, ok: true, ms: Date.now() - started, detail });
    return true;
  } catch (err) {
    checks.push({ name, ok: false, ms: Date.now() - started, error: String(err?.message ?? err), hint });
    return false;
  }
}

/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleSelfTest(request, env) {
  const checks = [];
  let fatal = false;

  /* ---------- 1. 绑定存在性 (一键部署向导被手改/资源未供给的第一 suspects) ---------- */
  const expected = ['WORLD_MANAGER', 'REGION', 'CHAT', 'USERS_DB', 'WORLD_DB', 'CACHE'];
  const missing = expected.filter((b) => !env[b]);
  checks.push({
    name: 'bindings',
    ok: missing.length === 0,
    detail: missing.length === 0 ? `全部就位 (${expected.join(', ')})` : `缺失: ${missing.join(', ')}`,
    ...(missing.length > 0 && { hint: '绑定缺失说明部署时 wrangler.toml 的对应段被删改 — 重新从 GitHub main 部署 (Deploy 按钮), 不要在向导里删除资源段落' }),
  });
  // 绑定缺失时后续检查必然连环抛错, 直接短路给出结论
  if (missing.length > 0) fatal = true;

  /* ---------- 2. USERS_DB: 连通性 + 建表核对 ---------- */
  if (!fatal) {
    await step(checks, 'USERS_DB.tables', 'D1 控制台 (cfmc-users → Console) 粘贴 src/storage/migrations/users/0001_init.sql 全文并执行', async () => {
      const { results } = await env.USERS_DB
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
      const tables = new Set((results ?? []).map((r) => r.name));
      const need = ['users', 'player_data', 'bans', 'chat_history', 'login_audit'];
      const absent = need.filter((n) => !tables.has(n));
      if (absent.length > 0) throw new Error(`缺表: ${absent.join(', ')}`);
      return `5 张表齐全 (${need.join(', ')})`;
    });

    /* ---------- 3. WORLD_DB: 连通性 + 建表核对 ---------- */
    await step(checks, 'WORLD_DB.tables', 'D1 控制台 (cfmc-world → Console) 粘贴 src/storage/migrations/world/0001_init.sql 全文并执行', async () => {
      const { results } = await env.WORLD_DB
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
      const tables = new Set((results ?? []).map((r) => r.name));
      // 必须核对 0001_init.sql 的全部 8 张表, 一张都不能少:
      // 典型事故 — 库里只有部分表但缺 tile_entities 时, loadChunk 对每个已存在
      // 区块的 TileEntity 查询都会抛错, 部署自检却报"就绪", 运行时才发现。
      // (entities/scheduled_ticks 同理: 半截迁移必须在这里暴露, 而不是上线后)
      const need = [
        'world_meta', 'chunks', 'chunk_sections', 'tile_entities',
        'entities', 'block_change_log', 'scheduled_ticks', 'chunk_claims',
      ];
      const absent = need.filter((n) => !tables.has(n));
      if (absent.length > 0) throw new Error(`缺表: ${absent.join(', ')}`);
      return `8 张表齐全 (${need.join(', ')})`;
    });

    /* ---------- 4. KV CACHE 读写 ---------- */
    await step(checks, 'CACHE.rw', 'Dashboard → Workers & Pages → cfmc-edge → Settings → Bindings 检查 CACHE 绑定; 或重新部署', async () => {
      const key = `selftest:${Date.now()}`;
      await env.CACHE.put(key, 'ok', { expirationTtl: 60 });
      const v = await env.CACHE.get(key);
      await env.CACHE.delete(key);
      if (v !== 'ok') throw new Error('写入后读不到');
      return 'KV 写/读/删正常';
    });

    /* ---------- 5. WorldManagerDO 存活 ---------- */
    await step(checks, 'WORLD_MANAGER.do', 'DO 类未注册通常是 [[migrations]] 段被删 — 重新从 GitHub main 部署', async () => {
      const stub = env.WORLD_MANAGER.get(env.WORLD_MANAGER.idFromName('singleton'));
      const res = await stub.fetch('https://wm/status');
      const j = await res.json();
      if (!j.ok) throw new Error('DO /status 返回异常');
      return `DO 正常 (路由表 ${j.routes} 条, 维护模式=${j.maintenance})`;
    });

    /* ---------- 6. RegionDO 存活 (region:0,0) ---------- */
    await step(checks, 'REGION.do', '同上; 若仅此项失败, 看 wrangler tail 里 region_fetch_fail 的具体异常', async () => {
      const stub = env.REGION.get(env.REGION.idFromName('region:0,0'));
      const res = await stub.fetch('https://region/status');
      const j = await res.json();
      if (!j.ok) throw new Error('RegionDO /status 返回异常');
      return `DO 正常 (tps=${j.tps}, 游戏循环=${j.gameLoopRunning})`;
    });

    /* ---------- 7. 端到端握手探测 (真实走一遍 /ws/game 升级链) ---------- */
    await step(checks, 'handshake.e2e', '此项失败 = 握手链路本身有故障 — 把上方 detail 的错误 body 原样反馈, 或 npx wrangler tail 看实时日志', async () => {
      // 以探针身份向本 Worker 发起真实 WS 升级 (fetch + Upgrade: websocket):
      //   101         → game.js 鉴权/路由 → RegionDO /connect → 101 全链路可用
      //   401/403/503 → 链路通, 被认证/封禁/维护规则正常拦截 (非故障)
      //   5xx         → 把响应体 code/message 原样报出 — 客户端 mod 只显示状态码,
      //                 看不到 body, 这里是唯一能看到握手错误详情的窗口
      // 探针用固定 uuid (重复探测覆盖同一条 WM 路由记录, 不产生垃圾条目);
      // 会短暂进入 region:0,0 并立即退出, DO 收到 close 自动清理会话。
      const origin = new URL(request.url).origin;
      const res = await fetch(`${origin}/ws/game?uuid=selftest-probe&name=SelftestProbe`, {
        headers: { Upgrade: 'websocket' },
      });
      if (res.status === 101) {
        // 出站升级的客户端套接字必须 accept, 否则运行时报错; 立即关闭即完成清理
        try { res.webSocket?.accept(); res.webSocket?.close(1000, 'selftest done'); } catch { /* 对端已断, 无妨 */ }
        return '端到端握手成功 (101) — /ws/game → RegionDO 全链路正常, 可以连接';
      }
      let body = '';
      try { body = JSON.stringify(await res.json()); } catch { body = (await res.text().catch(() => '')).slice(0, 200); }
      if (res.status === 401 || res.status === 403 || res.status === 503) {
        return `链路可达, 被业务规则拦截 (${res.status} ${body}) — 认证/封禁/维护按配置工作, 非故障`;
      }
      throw new Error(`握手返回 ${res.status}: ${body || '(无响应体)'}`);
    });

    /* ---------- 8. Secrets 配置提示 (非致命) ---------- */
    checks.push({
      name: 'secrets.hint',
      ok: true,
      detail:
        'AUTH_JWT_SECRET: ' + (env.AUTH_JWT_SECRET ? '已配置' : '未配置 (自动降级 KV 随机密钥, 可用但每次部署换密钥)') +
        ' / ADMIN_TOKEN: ' + (env.ADMIN_TOKEN ? '已配置' : '未配置 (/admin 面板不可用)'),
    });
  }

  const failed = checks.filter((c) => !c.ok);
  return jsonResponse({
    ok: failed.length === 0 && !fatal,
    verdict: failed.length === 0 && !fatal
      ? '全部通过 — 服务端就绪, 可以连接'
      : `${failed.length} 项失败 — 按 hint 修复后重测`,
    checks,
    tip: '本端点只读安全, 可随时刷新重测; 修好一项刷新一次即可',
  });
}
