/**
 * ============================================================================
 * Auth Worker — 四种认证模式的完整实现 (子提示词 2)
 * ============================================================================
 *
 * 路由 (由 src/index.js 挂载到 /auth/*):
 *   POST /auth/login      { username, password?, serverId?, mode? }
 *   POST /auth/refresh    { refreshToken }
 *   POST /auth/validate   { accessToken }
 *   POST /auth/invalidate { refreshToken }
 *   GET  /auth/skins/:uuid
 *
 * 四种模式 (与 constants.js AUTH_MODES 对应):
 *   online      → Mojang hasJoined 验证 (需客户端先 join)
 *   offline     → 离线 UUID (MD5, 与 Java 一致), 无密码
 *   skin_server → 调用皮肤站 Yggdrasil authenticate (ely.by/littleskin/自建)
 *   hybrid      → 带 serverId 走 online; 带 password 走 skin_server; 否则 offline
 *
 * 产出 (登录成功):
 *   accessToken  JWT (HS256, 15min, 无状态)
 *   refreshToken 不透明串 (7天, KV 可吊销/轮换)
 *   profile      { uuid, name, mode, skinUrl, skinModel }
 *
 * 设计决策:
 *   - 用户落库 USERS_DB (users 表): offline/skin_server 的 UUID→名字 映射
 *     持久化, 断线重连与皮肤查询不再依赖外部服务
 *   - login_audit 记录每次登录 (反爆破审计), 失败也记
 *   - 数据库操作全部 try-catch 包裹: 认证主流程不因审计/皮肤缓存故障失败
 * ============================================================================
 */

import { AUTH_MODES, ERROR_CODES } from '../utils/constants.js';
import { offlineUuid, md5SelfTest } from '../auth/offline-uuid.js';
import { signJWT, verifyJWT, getSecret, generateRefreshToken, REFRESH_TTL_SECONDS } from '../auth/jwt-handler.js';
import { hasJoined as mojangHasJoined, fetchProfile as mojangProfile, decodeTextures } from '../auth/mojang-api.js';
import { SkinServerClient } from '../auth/skin-server.js';

/** 统一 JSON 输出 */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const err = (code, message, status) => json({ ok: false, code, message }, status);

/**
 * Auth Worker 入口 (index.js: /auth/* 全部转交这里)
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url 已解析的请求 URL
 */
export async function handleAuthRequest(request, env, url) {
  // 启动自检: MD5 实现若损坏, offline 模式立即拒绝 (登录是安全边界)
  // 放在首个请求处执行, 代价可忽略
  md5SelfTest();

  const path = url.pathname;
  const method = request.method;

  // ---------- POST /auth/login ----------
  if (path === '/auth/login' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return err(ERROR_CODES.AUTH_MODE_UNSUPPORTED, '请求体必须是 JSON', 400);
    }
    return handleLogin(body, env, request);
  }

  // ---------- POST /auth/refresh ----------
  if (path === '/auth/refresh' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return handleRefresh(body, env);
  }

  // ---------- POST /auth/validate ----------
  if (path === '/auth/validate' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const payload = await verifyJWT(body.accessToken ?? '', await getSecret(env));
    if (!payload) return err(ERROR_CODES.AUTH_INVALID_TOKEN, 'AccessToken 无效或已过期', 401);
    return json({ ok: true, profile: { uuid: payload.uuid, name: payload.name, mode: payload.mode } });
  }

  // ---------- POST /auth/invalidate ----------
  if (path === '/auth/invalidate' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.refreshToken && env.CACHE) await env.CACHE.delete(`rt:${body.refreshToken}`);
    return json({ ok: true }); // 幂等: 无论是否存在都返回成功
  }

  // ---------- GET /auth/skins/:uuid ----------
  if (path.startsWith('/auth/skins/') && method === 'GET') {
    return handleSkinLookup(path.slice('/auth/skins/'.length), env);
  }

  return err('NOT_FOUND', `未知认证端点: ${path}`, 404);
}

/* ==========================================================================
 * 登录主流程
 * ======================================================================== */

async function handleLogin(body, env, request) {
  const username = String(body.username ?? '').trim();
  if (!username || username.length > 16) {
    return err('AUTH_BAD_USERNAME', '用户名非法 (1-16字符)', 400);
  }

  // 模式解析: 客户端可显式指定; 否则用 wrangler.toml 的 DEFAULT_AUTH_MODE
  const mode = resolveMode(body.mode ?? env.DEFAULT_AUTH_MODE ?? AUTH_MODES.HYBRID);
  if (!mode) {
    return err(ERROR_CODES.AUTH_MODE_UNSUPPORTED, `未知认证模式: ${body.mode}`, 400);
  }

  let result;
  switch (mode) {
    case AUTH_MODES.ONLINE:
      result = await loginOnline(body, username, env);
      break;
    case AUTH_MODES.OFFLINE:
      result = await loginOffline(username, env);
      break;
    case AUTH_MODES.SKIN_SERVER:
      result = await loginSkinServer(body, env);
      break;
    case AUTH_MODES.HYBRID:
      result = await loginHybrid(body, username, env);
      break;
    default:
      return err(ERROR_CODES.AUTH_MODE_UNSUPPORTED, '该模式尚未实现', 501);
  }

  // 审计落库 (尽力而为, 失败不阻塞登录)
  auditLogin(env, request, result).catch(() => {});

  if (!result.ok) {
    const status = result.reason === 'SKIN_INVALID_CREDENTIALS' || result.reason === 'MOJANG_REJECT' ? 401 : 502;
    return err(ERROR_CODES.AUTH_INVALID_TOKEN, `认证失败: ${result.reason}`, status);
  }

  // ---------- 签发双 Token ----------
  const secret = await getSecret(env);
  const accessToken = await signJWT(
    { uuid: result.profile.uuid, name: result.profile.name, mode: result.profile.mode },
    secret,
    900
  );
  const refreshToken = generateRefreshToken();
  // KV 缺失保护: 绑定异常时跳过 refresh-token 存储 (access 仍可发, 登录不 500)
  if (env.CACHE) {
    await env.CACHE.put(
      `rt:${refreshToken}`,
      JSON.stringify({ uuid: result.profile.uuid, name: result.profile.name }),
      { expirationTtl: REFRESH_TTL_SECONDS }
    );
  }

  // ---------- 用户落库 (offline/skin_server 身份映射持久化) ----------
  upsertUser(env, result.profile).catch(() => {});

  return json({
    ok: true,
    accessToken,
    refreshToken,
    expiresIn: 900,
    profile: result.profile,
  });
}

/** 模式白名单 + 规范化 (拒绝未知值) */
function resolveMode(raw) {
  const m = String(raw ?? '').toLowerCase();
  return Object.values(AUTH_MODES).includes(m) ? m : null;
}

/* ------------------------- 模式 1: online ------------------------- */

async function loginOnline(body, username, env) {
  // 客户端必须已对 Mojang 执行 join, 服务端用相同 serverId 回查
  if (!body.serverId) {
    return { ok: false, reason: 'ONLINE_NEEDS_SERVER_ID' };
  }
  const r = await mojangHasJoined(username, body.serverId);
  if (!r.ok) return r;

  // 纹理从 Mojang 档案取 (best-effort)
  let skin = { skinUrl: null, skinModel: 'wide' };
  try {
    const profile = await mojangProfile(r.profile.uuid);
    if (profile) skin = { ...decodeTextures(profile), skinModel: decodeTextures(profile).model };
  } catch { /* ignore */ }

  return {
    ok: true,
    profile: {
      uuid: r.profile.uuid,
      name: r.profile.name, // 用 Mojang 确认的名字 (大小写以官方为准)
      mode: AUTH_MODES.ONLINE,
      ...skin,
    },
  };
}

/* ------------------------- 模式 2: offline ------------------------- */

async function loginOffline(username, _env) {
  // 离线模式: 用户名即身份。UUID 必须与 Java nameUUIDFromBytes 一致,
  // 否则同一玩家在本地单机与服务端会是两个不同身份 (存档分裂)!
  return {
    ok: true,
    profile: {
      uuid: offlineUuid(username),
      name: username,
      mode: AUTH_MODES.OFFLINE,
      skinUrl: null, // Steve 默认; Phase 2 支持皮肤站补挂
      skinModel: 'wide',
    },
  };
}

/* ----------------------- 模式 3: skin_server ----------------------- */

async function loginSkinServer(body, env) {
  const base = env.DEFAULT_SKIN_SERVER ?? 'https://ely.by';
  if (!body.password) {
    return { ok: false, reason: 'SKIN_NEEDS_PASSWORD' };
  }
  const client = new SkinServerClient(base);
  const r = await client.authenticate(body.username, body.password);
  if (!r.ok) return r;

  // 皮肤纹理补全 (失败不阻塞登录)
  let skin = { skinUrl: null, skinModel: 'wide' };
  try {
    const full = await client.fetchProfileWithSkin(r.profile.uuid);
    if (full) skin = { skinUrl: full.skinUrl, skinModel: full.model ?? 'wide' };
  } catch { /* ignore */ }

  return { ok: true, profile: { ...r.profile, mode: AUTH_MODES.SKIN_SERVER, ...skin } };
}

/* ------------------------- 模式 4: hybrid ------------------------- */

async function loginHybrid(body, username, env) {
  // 策略链 (cfmc.md: 有Token走正版, 否则降级离线+皮肤站):
  //   1. body.serverId 存在 → 客户端带正版会话 → online 验证
  //   2. body.password 存在 → 皮肤站账密登录
  //   3. 都没有 → offline (最宽容的兜底, 保证"总能进服")
  if (body.serverId) {
    const r = await loginOnline(body, username, env);
    if (r.ok) return r;
    // 正版失败不直接拒绝 — 降级继续 (可按社区策略改为直接拒绝)
  }
  if (body.password) {
    const r = await loginSkinServer(body, env);
    if (r.ok) return r;
  }
  return loginOffline(username, env);
}

/* ==========================================================================
 * 辅助: 刷新 / 皮肤查询 / 落库 / 审计
 * ======================================================================== */

async function handleRefresh(body, env) {
  const token = body.refreshToken;
  if (!token) return err(ERROR_CODES.AUTH_INVALID_TOKEN, '缺少 refreshToken', 400);
  if (!env.CACHE) return err(ERROR_CODES.AUTH_INVALID_TOKEN, 'KV 绑定不可用, 无法校验 RefreshToken', 503);

  const stored = await env.CACHE.get(`rt:${token}`);
  if (!stored) return err(ERROR_CODES.AUTH_INVALID_TOKEN, 'RefreshToken 无效或已过期', 401);

  const session = JSON.parse(stored);

  // 轮换 (rotation): 旧 refresh 立即作废, 发新的 — 检测重放攻击的基础
  await env.CACHE.delete(`rt:${token}`);

  const secret = await getSecret(env);
  const newAccess = await signJWT(
    { uuid: session.uuid, name: session.name, mode: 'refresh' },
    secret,
    900
  );
  const newRefresh = generateRefreshToken();
  await env.CACHE.put(`rt:${newRefresh}`, stored, { expirationTtl: REFRESH_TTL_SECONDS });

  return json({ ok: true, accessToken: newAccess, refreshToken: newRefresh, expiresIn: 900 });
}

async function handleSkinLookup(uuid, env) {
  // 1. 先查本地缓存库 (users.skin_url)
  try {
    const row = await env.USERS_DB.prepare('SELECT skin_url, skin_model FROM users WHERE uuid = ?')
      .bind(uuid.replace(/-/g, '').toLowerCase())
      .first();
    if (row?.skin_url) {
      return json({ ok: true, skinUrl: row.skin_url, model: row.skin_model ?? 'wide', source: 'cache' });
    }
  } catch { /* DB 故障则继续走远端 */ }

  // 2. 回源 Mojang
  try {
    const profile = await mojangProfile(uuid);
    if (profile) {
      const tex = decodeTextures(profile);
      return json({ ok: true, skinUrl: tex.skinUrl, capeUrl: tex.capeUrl, model: tex.model, source: 'mojang' });
    }
  } catch { /* ignore */ }

  return json({ ok: false, code: 'SKIN_NOT_FOUND', message: '未找到该玩家的皮肤' }, 404);
}

/** 用户表 UPSERT (uuid 冲突则更新名字/皮肤/登录计数) */
async function upsertUser(env, profile) {
  const now = Date.now();
  const bareUuid = profile.uuid.replace(/-/g, '');
  await env.USERS_DB.prepare(
    `INSERT INTO users (uuid, name, name_lower, auth_mode, skin_url, skin_model, created_at, last_login_at, login_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       last_login_at = excluded.last_login_at,
       skin_url = COALESCE(excluded.skin_url, users.skin_url),
       skin_model = COALESCE(excluded.skin_model, users.skin_model),
       login_count = users.login_count + 1`
  ).bind(bareUuid, profile.name, profile.name.toLowerCase(), profile.mode, profile.skinUrl ?? null, profile.skinModel ?? null, now, now).run();
}

/** 登录审计 (成功/失败都记, 反爆破数据源) */
async function auditLogin(env, request, result) {
  await env.USERS_DB.prepare(
    `INSERT INTO login_audit (uuid, name, ip, auth_mode, success, fail_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    result.profile?.uuid?.replace(/-/g, '') ?? null,
    result.profile?.name ?? null,
    request.headers.get('CF-Connecting-IP'),
    result.profile?.mode ?? 'unknown',
    result.ok ? 1 : 0,
    result.ok ? null : result.reason ?? 'UNKNOWN'
  ).run();
}
