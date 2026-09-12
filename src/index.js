/**
 * ============================================================================
 * CFMC-Edge — Gateway Worker 入口
 * ============================================================================
 *
 * 职责 (Phase 1 骨架):
 *   1. TLS 终止后的第一入口: 所有请求先进这里
 *   2. 基础路由分发: 静态信息 / 健康检查 / 认证 / REST API / WebSocket
 *   3. 全局中间件挂载点 (CORS / Logger / RateLimiter, 见 workers/gateway.js)
 *   4. 导出 Durable Object 类 (Workers 平台要求 DO 类必须从入口模块导出)
 *
 * 与原版 Minecraft 服务器的差异:
 *   - 原版: 单进程 MainThread 接收所有 TCP 连接 (Netty), 一个 World 一个 Tick 循环
 *   - 本项目: 无状态 Worker 只做"路由器", 有状态的游戏逻辑全部下沉到
 *     Durable Object (RegionDO = 区域游戏引擎), 每个 Region 独立 Tick
 *
 * 性能考量:
 *   - 入口 Worker 保持零状态、零磁盘访问, P99 处理耗时 < 5ms
 *   - WebSocket 升级请求直接透传给 DO (fetch 转发), Worker 不缓存任何包数据,
 *     避免大包 (ChunkData 可达数百KB) 在 Worker 中产生多余拷贝
 *
 * 待改进 (TODO):
 *   - [ ] Phase 2: 按玩家坐标哈希路由到对应 Region (WorldManagerDO 提供路由表)
 *   - [ ] Phase 3: 接入 Cloudflare WAF Rate Limiting Binding 替代内存限流器
 * ============================================================================
 */

import {
  jsonResponse,
  errorResponse,
  handleOptions,
  withCors,
  RateLimiter,
  logRequest,
} from './workers/gateway.js';
import { handleAuthRequest } from './workers/auth.js';
import { handleGameWebSocket } from './workers/game.js';
import { handleApiRequest } from './workers/api.js';
import { handleSelfTest } from './workers/selftest.js';
import { PROTOCOL_VERSION } from './protocol/packet-definitions.js';
import { supportSummary } from './protocol/version-registry.js';
// Text 规则导入 (wrangler.toml [[rules]] type="Text") — Phase 3 管理面板
import panelHtml from './admin/panel.html';

/** DO 类导出 —— 必须在入口模块, 否则 wrangler deploy 校验失败 */
export { WorldManagerDO } from './durable-objects/WorldManagerDO.js';
export { RegionDO } from './durable-objects/RegionDO.js';
export { ChatDO } from './durable-objects/ChatDO.js';

/** 内存限流器 (per-isolate; 生产环境应换成 WAF 规则或 DO 计数器, 见 gateway.js 注释) */
const limiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 120, // 每IP每分钟120次: 对登录/REST足够, 不影响WS长连接
});

export default {
  /**
   * 主入口 —— 所有 HTTP/WS 请求
   * @param {Request} request
   * @param {Env} env 绑定 (WORLD_MANAGER/REGION/CHAT/USERS_DB/WORLD_DB/CACHE/BACKUPS...)
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    try {
      // ---------- 0. CORS 预检 (Web 管理面板跨域访问) ----------
      if (request.method === 'OPTIONS') {
        return handleOptions(request, env);
      }

      // ---------- 1. 限流 (仅对非 WebSocket 升级请求生效) ----------
      const isWsUpgrade = request.headers.get('Upgrade') === 'websocket';
      if (!isWsUpgrade) {
        const limited = limiter.check(request);
        if (limited) {
          return withCors(
            errorResponse('RATE_LIMITED', '请求过于频繁, 请稍后再试', 429),
            request
          );
        }
      }

      // ---------- 2. 路由分发 ----------
      const response = await route(request, env, url, ctx);

      // ---------- 3. 统一日志 + CORS 包裹 ----------
      logRequest(request, response, startTime);
      return withCors(response, request, env);
    } catch (err) {
      // 全局兜底: 任何未捕获异常都不能泄漏堆栈给客户端
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'unhandled_exception',
          path: url.pathname,
          error: err.message,
          stack: err.stack,
        })
      );
      return withCors(
        errorResponse('INTERNAL_ERROR', '服务器内部错误', 500),
        request,
        env
      );
    }
  },
};

/**
 * 路由表
 * ----------------------------------------------------------------
 * GET  /            服务信息 (协议版本/能力集, 供客户端 Mod 发现服务)
 * GET  /health      健康检查 (负载均衡/监控探针)
 * GET  /debug/selftest  部署自检 (D1 建表/KV/DO 逐项探测, 排障第一步)
 * GET  /admin       Web 管理面板 (Phase 3)
 * GET  /ws/game     WebSocket 升级 → 验证身份 → 转发给 RegionDO (game.js)
 * ANY  /auth/*      认证服务: 登录/刷新/校验/吊销/皮肤 (auth.js)
 * ANY  /api/*       RESTful API: 统计/在线/封禁/广播 (api.js, Phase 3)
 */
async function route(request, env, url, ctx) {
  const { pathname } = url;

  // ===== 服务信息 =====
  if (pathname === '/' && request.method === 'GET') {
    return jsonResponse({
      name: 'CFMC-Edge',
      description: 'Serverless Minecraft server on Cloudflare Edge',
      protocolVersion: PROTOCOL_VERSION,
      phase: '3-core', // Phase 3: 生产化 (权限/反作弊/命令/背包/重连/面板/监控)
      // 全协议支持: 1.8~1.21.x 任意 MC 版本的 CFMC Mod 均可接入 (v2 协议版本中立)
      mcSupport: supportSummary(),
      capabilities: {
        websocket: true,
        chat: true,
        world: true,
        auth: true,
        commands: true,      // P3 管理命令
        inventory: true,     // P3 背包同步
        reconnect: true,     // P3 断线重连
        entities: true,      // P4 怪物 AI
        claims: true,        // P4 土地保护
        economy: true,       // P4 经济系统
        plugins: true,       // P4 插件事件总线
        adminPanel: '/admin',
      },
      endpoints: ['/health', '/ws/game', '/auth/*', '/api/*', '/admin', '/debug/selftest'],
    });
  }

  // ===== 健康检查 =====
  if (pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      colo: request.cf?.colo ?? 'unknown', // 命中的边缘数据中心
      region: request.cf?.country ?? '??',
      timestamp: Date.now(),
    });
  }

  // ===== WebSocket 游戏入口 (game.js: 身份验证 + Region 路由) =====
  if (pathname === '/ws/game' && request.headers.get('Upgrade') === 'websocket') {
    return handleGameWebSocket(request, env);
  }

  // ===== 认证服务 (auth.js: 四种模式, 子提示词 2) =====
  if (pathname.startsWith('/auth/')) {
    return handleAuthRequest(request, env, url);
  }

  // ===== 部署自检 (selftest.js): D1 建表 / KV / DO 逐项探测, 排障第一步 =====
  if (pathname === '/debug/selftest' && request.method === 'GET') {
    return handleSelfTest(request, env);
  }

  // ===== Web 管理面板 (Phase 3): 单文件 SPA 由 Worker 直接托管 =====
  if (pathname === '/admin' && request.method === 'GET') {
    return new Response(panelHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // ===== RESTful API (Phase 3): 面板数据源 + 管理动作 =====
  if (pathname.startsWith('/api/')) {
    return handleApiRequest(request, env);
  }

  // ===== 404 兜底 =====
  return errorResponse('NOT_FOUND', `未知路径: ${pathname}`, 404);
}
