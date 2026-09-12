/**
 * ============================================================================
 * Gateway 中间件集: CORS / Logger / RateLimiter / 响应工具
 * ============================================================================
 *
 * 为什么手写而不是用 itty-router/hono 等框架:
 *   1. Workers 冷启动时间与代码体积正相关, 零依赖可把入口 Worker 控制在极小体积
 *   2. CFMC 的路由面很小 (<10条), 框架收益有限
 *   3. 中间件行为完全可控, 便于后续做协议层的精细错误码标准化
 *
 * 与原版 Minecraft 的差异:
 *   原版服务器没有 HTTP 面; 本项目的 HTTP 面服务于:
 *   - 客户端 Mod 的服务发现 (GET /)
 *   - Web 管理面板 (Phase 3, 跨域访问 → 需要 CORS)
 *   - 监控探针 (/health)
 *
 * 待改进 (TODO):
 *   - [ ] RateLimiter 目前是 per-isolate 内存实现, 多隔离实例下配额会放大 N 倍
 *   - [ ] Phase 3: 接入 Cloudflare Rate Limiting Binding (原生边缘限流)
 * ============================================================================
 */

/** CORS 允许的来源: env.ADMIN_ORIGIN (面板域名, 推荐生产配置) > 开发期 '*' */
function corsOrigin(env) {
  return env?.ADMIN_ORIGIN ?? '*';
}

/** CORS 头 (origin 随 env 动态; 默认开发期 '*' — 生产设 ADMIN_ORIGIN 收敛) */
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': corsOrigin(env),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 构造 JSON 响应
 * 所有响应统一 application/json; charset=utf-8, 便于客户端 Mod 解析
 */
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * 标准化错误响应
 * ----------------------------------------------------------------
 * 错误码设计约定 (与客户端 Mod 对齐):
 *   RATE_LIMITED / NOT_FOUND / NOT_IMPLEMENTED / UNAUTHORIZED
 *   AUTH_INVALID_TOKEN / AUTH_MODE_UNSUPPORTED / INTERNAL_ERROR ...
 * 客户端依据 code 而非 message 做逻辑判断 (message 仅展示用)
 */
export function errorResponse(code, message, status = 400) {
  return jsonResponse({ ok: false, code, message }, status);
}

/** CORS 预检处理 */
export function handleOptions(_request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/** 给业务响应追加 CORS 头 */
export function withCors(response, _request, env) {
  // ⚠️ WebSocket 升级响应 (101) 必须原样返回!
  //    new Response(response.body, ...) 重建会丢弃 Response.webSocket 属性 →
  //    运行时抛 "101 must have webSocket property" → 客户端只见无上下文的 500。
  //    WS 帧在 TCP 层收发, 浏览器同源策略/CORS 管不到它, 加头也无意义。
  //    (这就是"自检全绿但握手必 500"的根因, 见 worklog Task 13)
  if (response.status === 101 || response.webSocket) return response;

  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 结构化请求日志
 * ----------------------------------------------------------------
 * 设计决策:
 *   - 输出单行 JSON (而不是拼接字符串), 方便 wrangler tail / Logpush
 *     接入 Logflare/Datadog 等做结构化查询 (cfmc.md 要求 #9)
 *   - 只记录 method/path/status/耗时/colo, 不记录请求体 (避免泄漏Token)
 */
export function logRequest(request, response, startTime) {
  const url = new URL(request.url);
  console.log(
    JSON.stringify({
      level: 'info',
      type: 'http',
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startTime,
      colo: request.cf?.colo,
      country: request.cf?.country,
    })
  );
}

/**
 * 内存滑动窗口限流器
 * ----------------------------------------------------------------
 * 实现: 固定窗口计数 (每 windowMs 重置一次), Key = IP
 *
 * 已知限制 (重要!):
 *   1. Workers 是多隔离实例的, 每个实例独立计数 → 实际配额 = maxRequests × 实例数
 *      对"防刷"够用 (攻击者视角仍是阈值), 对"精确配额"不够
 *   2. Map 无持久化, 实例回收后计数清零
 *   3. 生产环境替代方案 (按优先级):
 *      a. Cloudflare WAF Rate Limiting Rules (免费版即可用, 边缘精确计数)
 *      b. 用一个 DO 做全局计数器 (强一致, 但增加一次跨DO调用延迟)
 *      c. Durable Object Rate Limit Binding (需付费计划)
 */
export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs 窗口时长 (毫秒)
   * @param {number} opts.maxRequests 窗口内最大请求数
   */
  constructor({ windowMs = 60_000, maxRequests = 100 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.buckets = new Map();
  }

  /** 提取客户端 IP (Workers 标准: CF-Connecting-IP 头, 不可伪造) */
  #clientKey(request) {
    return request.headers.get('CF-Connecting-IP') ?? 'unknown';
  }

  /**
   * 检查是否应该限流
   * @returns {boolean} true = 已超限, 应返回 429
   */
  check(request) {
    const key = this.#clientKey(request);
    const now = Date.now();

    // 顺手清理过期桶, 防止 Map 无限增长 (内存安全: 上限约 = IP数 × 48字节)
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) {
        if (v.resetAt < now) this.buckets.delete(k);
      }
    }

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return false;
    }

    bucket.count += 1;
    return bucket.count > this.maxRequests;
  }
}
