/**
 * ============================================================================
 * RegionDO — 区域游戏引擎 v1.0 (整个项目的核心!) — Phase 2/3/4 整合版
 * ============================================================================
 *
 * ⚠️ 一个 RegionDO = 世界中一个 16×16 区块柱 (X,Z 固定, Y 全高)
 *    实例名 `region:[dim:]x,z` (overworld 无 dim 前缀, 见 game.js)
 *
 * 在 v0.1 (Hibernation/20TPS/LRU/Cesium 持久化/全协议 v2) 基础上新增:
 *   [P2] 视距环区块流式下发 (每 tick 配额, 防 D1 读风暴)
 *   [P2] 服务端权威位置 (PLAYER_POSITION 0x21): TP/校正/重生共用
 *   [P2] WorldManagerDO 路由上报 (register/unregister) → 断线重连恢复
 *   [P2] spawn 从 world_meta 读取; 玩家状态跨重启恢复 (player_data)
 *   [P3] 反作弊: MovementTracker (速度/飞行/垂直) + 回拉校正
 *   [P3] 权限系统 + 管理命令 (/tp /gamemode /kick /ban /op /say /save...)
 *   [P3] 背包同步: WindowItems/SetSlot + ContainerClick + 持久化
 *   [P3] 断线重连: 宽限期内存快照 + D1 兜底, 同 uuid 重连恢复原状态
 *   [P3] 监控: tick 溢出计数上报 WM /report, 阈值告警 /alert
 *   [P4] 怪物 AI: 僵尸追击/攻击 + 猪, EntityWorld 每 tick 推进
 *   [P4] 土地保护: chunk_claims 认领/修改校验
 *   [P4] 经济: 金币余额/转账/发放 (服务端权威)
 *   [P4] 插件事件总线 (HookBus) + example 插件
 *
 * 设计约束不变 (cfmc.md):
 *   1. 内存优先: 热数据全内存, D1 只做低频批量持久化
 *   2. 单 tick CPU < 40ms 熔断;  3. 错误绝不终止 Tick 循环
 * ============================================================================
 */

import { CLIENTBOUND, SERVERBOUND, PACKET_FLAGS, PROTOCOL_VERSION } from '../protocol/packet-definitions.js';
import { decideHandshake, supportSummary } from '../protocol/version-registry.js';
import { selectAdapter } from '../protocol/version-adapters.js';
import { PacketWriter } from '../protocol/packet-writer.js';
import { PacketReader } from '../protocol/packet-reader.js';
import { decompress } from '../protocol/compression.js';
import { loadChunk, decodeBlockIndices } from '../storage/cesium-reader.js';
import {
  prepareSectionUpsert,
  prepareChunkCleanMark,
  prepareBlockChangeLogInsert,
  savePlayerState,
  encodeBlockIndices,
} from '../storage/cesium-writer.js';
import { resolveConfig, CHUNK, BLOCK_NAMES, DIMENSIONS, ERROR_CODES, GAMEMODES, PHASE_DEFAULTS } from '../utils/constants.js';
import { worldToSectionIndex, clamp, Vec3 } from '../utils/math3d.js';
import { logger } from '../utils/logger.js';

import { ROLES, normalizeRole, hasPermission } from '../world/permissions.js';
import { MovementTracker } from '../world/anticheat.js';
import { executeCommand } from '../world/commands.js';
import * as inv from '../world/inventory.js';
import { ClaimRegistry, CLAIMS_LIMIT } from '../world/claims.js';
import { EntityWorld } from '../world/entities.js';
import { HookBus, examplePlugin } from '../world/hook-bus.js';
import { STARTING_BALANCE, validatePay, MAX_GRANT } from '../world/economy.js';
import { filterMessage } from './ChatDO.js';

/** 空气方块名 (版本中立的 "空") — 与客户端 CFMCConstants.AIR_BLOCK_NAME 一致 */
const AIR = BLOCK_NAMES.AIR;

/** 每 tick 每玩家最多下发区块数 (视距环流式; 防首次进服 D1 读风暴) */
const CHUNK_SEND_BUDGET_PER_TICK = 4;
/** 攻击伤害 (简化: 赤手固定值; 武器系统 Phase 4+) */
const ATTACK_DAMAGE = 5;
/** MC 昼夜: 24000 tick/天, 13000-23000 为夜 */
const DAY_LENGTH_TICKS = 24000;

/* ==========================================================================
 * LRU 缓存 (cfmc.md: 最近 256 区块; 命中避免 D1 读, 这是配额的生死线)
 * ======================================================================== */
class LRUCache {
  constructor(maxSize = 256, onEvict = () => {}) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
    /** @type {Map<string, object>} Map 保持插入序 = 访问序 */
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      this.onEvict(oldest, evicted);
    }
  }
}

/* ==========================================================================
 * RegionDO 主体
 * ======================================================================== */
export class RegionDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.config = resolveConfig(env);
    const parsed = this.#parseRegionFromName();
    this.region = { x: parsed.x, z: parsed.z };
    this.dim = parsed.dim;

    /** 在线玩家: uuid → session (字段见 #handleConnect) */
    this.players = new Map();

    /** 需要持久化的区块坐标 Set<"cx,cz"> (先于缓存初始化, 供驱逐回调使用) */
    this.dirtyChunks = new Set();

    /** 区块缓存 (LRU)。驱逐时把脏区块记回 dirtyChunks */
    this.chunkCache = new LRUCache(this.config.chunkCacheSize ?? 256, (key, evicted) => {
      if (evicted?.isDirty) this.dirtyChunks.add(key);
    });

    /** [P3] 断线重连快照: uuid → {state, expiresAt} (宽限期内重连零损耗恢复) */
    this.reconnectCache = new Map();

    /** [P4] 土地认领注册表 (懒加载 world 库 chunk_claims) */
    this.claims = new ClaimRegistry();
    this.claimsLoaded = false;

    /** [P4] 实体世界 (怪物 AI) */
    this.entityWorld = new EntityWorld({ maxEntities: this.config.maxEntitiesPerRegion });

    /** [P4] 插件事件总线 + 示例插件 */
    this.hooks = new HookBus();
    this.examplePlugin = examplePlugin(this.hooks);

    /** [P3] 玩家操作缓冲 (Tick 内统一处理, 避免消息风暴逐条处理) */
    this.inputQueue = [];

    /** 待写变更日志 (随 persistDirty 一起 flush) */
    this.pendingLogEntries = [];

    /** [P4] 实体移动广播缓冲 (AI tick 期间收集, gameTick 统一广播) */
    this.pendingEntityMoves = [];

    this.tickCount = 0;
    this.gameClock = 6000; // 正午起步 (world_meta 'time')
    this.gameLoopRunning = false;
    /** [P3] TPS 估算 (EWMA of tick 间隔) */
    this.tpsEwma = 20;
    this.lastTickAt = Date.now();
    /** [P3] tick 溢出计数 (上报 WM) */
    this.overrunCount = 0;
    /** 出生点 (懒加载 world_meta) */
    this.spawn = null;
  }

  /* ==========================================================================
   * HTTP 面 (game.js 升级透传 + API 面板管理动作)
   * ======================================================================== */

  async fetch(request) {
    const url = new URL(request.url);

    // 顶层兜底: 任何未捕获异常都以结构化 500 返回 (而非裸异常穿透到调用方,
    // 否则 game.js 的 stub.fetch 会 reject → Gateway 全局 catch → 玩家只见无上下文的 500)
    try {
      return await this.#route(request, url);
    } catch (err) {
      logger.error('region_fetch_fail', {
        path: url.pathname,
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 4).join(' | '),
      });
      return Response.json(
        { ok: false, code: 'REGION_INTERNAL_ERROR', message: err.message },
        { status: 500 }
      );
    }
  }

  async #route(request, url) {
    if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      return this.#handleConnect(url);
    }

    if (url.pathname === '/status') {
      return Response.json({
        ok: true,
        role: 'RegionDO',
        version: 'v1.0 (Phase 3/4)',
        region: this.#regionKey(),
        players: [...this.players.values()].map((p) => ({ name: p.name, pos: { ...p.pos }, role: p.role, gm: p.gamemode })),
        entities: this.entityWorld.stats(),
        claims: this.claims.map.size,
        dirtyChunks: this.dirtyChunks.size,
        cachedChunks: this.chunkCache.map.size,
        tickCount: this.tickCount,
        gameClock: this.gameClock,
        tps: Number(this.tpsEwma.toFixed(1)),
        gameLoopRunning: this.gameLoopRunning,
      });
    }

    /* ---- [P3] API 面板的管理动作 (经 WorldManagerDO 扇出) ---- */
    if (url.pathname === '/say' && request.method === 'POST') {
      const { message } = await request.json();
      this.#broadcastChat(`§6[服务器] §f${String(message).slice(0, 256)}`);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
      const { uuid, reason } = await request.json();
      if (this.players.has(uuid)) {
        this.#kick(uuid, reason || '管理员操作');
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, code: 'NOT_ONLINE' }, { status: 404 });
    }

    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  }

  /* ==========================================================================
   * 玩家连接 / 断开 (Hibernation API)
   * ======================================================================== */

  #handleConnect(url) {
    const uuid = url.searchParams.get('uuid') ?? crypto.randomUUID();
    const name = url.searchParams.get('name') ?? 'Guest';
    const isAdmin = url.searchParams.get('admin') === '1';

    // 容量闸门 (重连的自己不占新名额)
    if (this.players.size >= this.config.maxPlayersPerRegion && !this.players.has(uuid)) {
      return new Response(
        JSON.stringify({ ok: false, code: ERROR_CODES.REGION_FULL, message: '该区域人数已满' }),
        { status: 403 }
      );
    }

    // [P3] 同 uuid 二次连接 = 顶号: 旧会话入重连缓存并踢下线
    if (this.players.has(uuid)) {
      this.#stashReconnect(uuid, this.players.get(uuid));
      this.#kick(uuid, '你的账号在其他位置登录');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // tag[0]=uuid: 唤醒后 getWebSockets(uuid) 反查
    this.state.acceptWebSocket(server, [uuid]);

    // ---- [P3] 会话恢复: 重连快照 → D1 player_data → 默认出生 ----
    const restored = this.#takeReconnect(uuid);
    const spawn = this.#spawnPoint();

    const session = {
      name,
      pos: restored?.pos ? restored.pos.clone() : spawn.clone(),
      yaw: restored?.yaw ?? 0,
      pitch: restored?.pitch ?? 0,
      onGround: true,
      lastKeepAlive: Date.now(),
      moved: false,
      joinedAt: Date.now(),
      // ---- v2 全协议支持字段 (握手后精确化) ----
      adapter: selectAdapter('generic'),
      mcVersion: '',
      mcProto: 0,
      // ---- Phase 3/4 字段 ----
      role: isAdmin ? ROLES.ADMIN : normalizeRole(restored?.role),
      gamemode: restored?.gamemode ?? GAMEMODES.SURVIVAL,
      health: restored?.health ?? 20,
      food: restored?.food ?? 20,
      coins: restored?.coins ?? STARTING_BALANCE,
      inv: restored?.invJson ? inv.deserialize(restored.invJson) : inv.create([
        { slot: 0, item: 'minecraft:diamond_pickaxe', count: 1 },
        { slot: 1, item: 'minecraft:diamond_sword', count: 1 },
        { slot: 2, item: 'minecraft:grass_block', count: 64 },
        { slot: 3, item: 'minecraft:stone', count: 64 },
      ]),
      tracker: new MovementTracker(['survival', 'creative', 'adventure', 'spectator'][restored?.gamemode ?? 0]),
      viewChunks: new Set(),   // 已下发区块 (防重发)
      chunkQueue: [],          // 待下发区块队列 [{cx,cz,dist}]
      anticheatFlags: 0,
      teleported: false,       // 本 tick 有服务端 TP (跳过一次移动广播)
    };
    session.tracker.markTeleport(session.pos);
    this.players.set(uuid, session);

    /* ---- 握手: HandshakeAck + JoinGame ---- */
    const support = supportSummary();
    this.#sendTo(uuid, CLIENTBOUND.HANDSHAKE_ACK.id, this.#buildHandshakeAck(session.adapter, support));

    const join = new PacketWriter(48);
    join.writeInt32(0); // entityId
    join.writeUInt8(session.gamemode);
    join.writeInt32(DIMENSIONS[this.dim]?.id ?? 0);
    join.writeDouble(session.pos.x);
    join.writeDouble(session.pos.y);
    join.writeDouble(session.pos.z);
    this.#sendTo(uuid, CLIENTBOUND.JOIN_GAME.id, join.toUint8Array());

    // 玩家列表 + 欢迎语
    this.#broadcastFrameExcept(uuid, this.#playerInfoPacket('join', uuid, name));
    this.#broadcastChat(`§e${name} 加入了 ${this.#regionKey()} 区域${restored ? ' (状态已恢复)' : ''}`);

    // [P3] 背包/血量整包同步
    this.#sendWindowItems(uuid);
    this.#sendUpdateHealth(uuid);

    // [P2] 视距环区块流式下发 (每 tick 限流, 见 gameTick)
    this.#enqueueViewChunks(uuid);

    // [P2] 上报 WorldManagerDO (路由表 → 断线重连/面板统计的数据源)
    this.#wmFetch('/register', { uuid, name, region: this.#regionKey() }).catch(() => {});

    this.hooks.emit('player.join', { uuid, name, region: this.#regionKey() });

    // 第一个玩家进入 → 启动游戏循环
    if (this.players.size === 1 && !this.gameLoopRunning) {
      this.#startGameLoop();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** HandshakeAck payload (v2: 尾部追加适配器名 + MC 协议支持范围) */
  #buildHandshakeAck(adapter, support) {
    const w = new PacketWriter(32);
    w.writeVarInt(PROTOCOL_VERSION);
    w.writeInt32(this.region.x);
    w.writeInt32(this.region.z);
    w.writeUInt8(this.config.viewDistance);
    w.writeString(adapter.name);
    w.writeVarInt(support.mcProtocolMin);
    w.writeVarInt(support.mcProtocolMax);
    return w.toUint8Array();
  }

  /** 客户端断开: 重连快照 + 立即持久化 + WM 注销 */
  async webSocketClose(ws) {
    const uuid = this.#uuidOf(ws);
    const session = this.players.get(uuid);
    if (!session) return;

    // [P3] 宽限期快照 (期内同 uuid 重连 → 完整恢复 pos/背包/血量)
    this.#stashReconnect(uuid, session);
    this.players.delete(uuid);

    // 立即持久化 (不等 60s 周期; 服务器崩溃也最多丢这一瞬间之后的)
    await this.#persistPlayer(uuid, session).catch((e) => logger.error('persist_player_fail', { uuid, error: e.message }));
    this.#wmFetch('/unregister', { uuid }).catch(() => {});

    this.#broadcast(this.#playerInfoPacket('leave', uuid, session.name));
    this.hooks.emit('player.leave', { uuid, name: session.name });

    // 最后一个玩家离开 → 最终保存 → 不再调度 Alarm → DO 休眠 → 零费用!
    if (this.players.size === 0 && this.gameLoopRunning) {
      await this.persistDirty().catch((e) => logger.error('final_persist_fail', { error: e.message }));
      this.gameLoopRunning = false;
      this.entityWorld.entities.clear(); // 实体随区域休眠清除 (休眠零成本的前提)
      logger.info('region_sleep', { region: this.#regionKey() });
    }
  }

  async webSocketError(ws, _err) {
    await this.webSocketClose(ws); // 视同断开
  }

  /* ==========================================================================
   * 消息接收与分派
   * ======================================================================== */

  /**
   * Hibernation 回调: 有消息才唤醒本 DO (空闲休眠零费用)
   *   - 二进制帧 (Mod): Length|PacketID|Flags|Payload
   *   - 文本 JSON (浏览器调试): Phase 1 兼容通道
   */
  async webSocketMessage(ws, message) {
    const uuid = this.#uuidOf(ws);
    if (!this.players.has(uuid)) return;

    try {
      if (typeof message === 'string') {
        this.#handleTextMessage(uuid, message);
        return;
      }

      /* ---- 帧循环: 一条 WS 消息可含多个连续帧 ---- */
      const reader = new PacketReader(message);
      let guard = 0;
      while (reader.remaining > 0 && guard++ < 256) {
        const length = reader.readVarInt();
        if (length <= 0 || length > 1 << 20) throw new Error(`非法帧长度: ${length}`);
        if (reader.remaining < length) throw new Error('帧不完整');

        const frame = reader.readBytes(length);
        const frameReader = new PacketReader(frame);
        const packetId = frameReader.readVarInt();
        const flags = frameReader.readUInt8();
        let payload = frameReader.readRemaining();

        if (flags & PACKET_FLAGS.COMPRESSED) {
          payload = await decompress(payload);
        }

        this.#dispatchPacket(uuid, packetId, new PacketReader(payload));
      }
    } catch (err) {
      // 坏包只踢坏的, 不断连接; 连续坏包 → 反作弊标记 (面板可见)
      logger.warn('bad_packet', { uuid, error: err.message });
      const session = this.players.get(uuid);
      if (session) session.anticheatFlags++;
      this.#sendChatTo(uuid, `§c malformed packet: ${err.message}`);
    }
  }

  /** 文本 JSON 通道 (Phase 1 浏览器联调兼容) */
  #handleTextMessage(uuid, text) {
    try {
      const data = JSON.parse(text);
      if (data.type === 'chat' && data.msg) {
        this.#handleChat(uuid, String(data.msg).slice(0, 256));
      } else {
        wsSafeSend(this.#wsOf(uuid), JSON.stringify({ type: 'echo', received: data }));
      }
    } catch { /* 非 JSON 文本忽略 */ }
  }

  /** 按包 ID 分派 (未注册的包丢弃并计数 — 向前兼容) */
  #dispatchPacket(uuid, packetId, r) {
    switch (packetId) {
      /* ClientHandshake v2 (全协议协商) — 逻辑与 v0.1 一致 */
      case SERVERBOUND.CLIENT_HANDSHAKE.id: {
        const session = this.players.get(uuid);
        const clientVersion = r.readVarInt();
        let mcVersion = '';
        let mcProto = 0;
        try {
          r.readString(16);
          mcVersion = r.readString(32);
          mcProto = r.readVarInt();
        } catch { /* v1 老客户端: 无尾部字段 */ }

        if (clientVersion !== PROTOCOL_VERSION) {
          this.#kick(uuid, `CFMC 协议版本不匹配 (服务端 v${PROTOCOL_VERSION} / 客户端 v${clientVersion}), 请更新 Mod`);
          break;
        }

        const decision = decideHandshake(mcProto);
        if (session) {
          session.adapter = selectAdapter(decision.adapter);
          session.mcVersion = mcVersion;
          session.mcProto = mcProto;
          logger.info('handshake_negotiated', {
            uuid, mcVersion: mcVersion || '(unreported)', mcProto,
            adapter: session.adapter.name, known: decision.versionInfo?.known ?? false,
          });
          this.#sendTo(uuid, CLIENTBOUND.HANDSHAKE_ACK.id, this.#buildHandshakeAck(session.adapter, supportSummary()));
        }
        break;
      }

      case SERVERBOUND.KEEP_ALIVE.id: {
        const session = this.players.get(uuid);
        if (session) session.lastKeepAlive = Date.now();
        break;
      }

      /* ChatMessage: 命令 (>文本) / 私聊 (@) / 区域聊天 (Phase 3) */
      case SERVERBOUND.CHAT_MESSAGE.id: {
        const text = r.readString(256);
        this.#handleChat(uuid, text);
        break;
      }

      /* PlayerPositionLook: x(D) y(D) z(D) yaw(F) pitch(F) onGround(Bool) flags(U8) */
      case SERVERBOUND.PLAYER_POSITION_LOOK.id: {
        const x = r.readDouble();
        const y = r.readDouble();
        const z = r.readDouble();
        const yaw = r.readFloat();
        const pitch = r.readFloat();
        const onGround = r.readBoolean();
        r.readUInt8(); // flags (相对坐标差量 TODO, 客户端当前发绝对值)
        this.inputQueue.push({ type: 'move', uuid, x, y, z, yaw, pitch, onGround });
        break;
      }

      /* PlayerDigging: status(U8) x(I32) y(I32) z(I32) */
      case SERVERBOUND.PLAYER_DIGGING.id: {
        const status = r.readUInt8();
        const x = r.readInt32();
        const y = r.readInt32();
        const z = r.readInt32();
        if (status === 2) this.inputQueue.push({ type: 'dig', uuid, x, y, z });
        break;
      }

      /* BlockPlace v2: x(I32) y(I32) z(I32) blockName(String) */
      case SERVERBOUND.BLOCK_PLACE.id: {
        const x = r.readInt32();
        const y = r.readInt32();
        const z = r.readInt32();
        const blockName = r.readString(128);
        this.inputQueue.push({ type: 'place', uuid, x, y, z, blockName });
        break;
      }

      /* [P3] HeldItemChange: slot(U8 0-8) */
      case SERVERBOUND.HELD_ITEM_CHANGE.id: {
        const slot = r.readUInt8();
        const session = this.players.get(uuid);
        if (session) inv.setHeld(session.inv, slot);
        break;
      }

      /* [P3] ContainerClick: slot(U8) button(U8) → 简化交换模型 → 整包回发 */
      case SERVERBOUND.CONTAINER_CLICK.id: {
        const slot = r.readUInt8();
        const button = r.readUInt8();
        const session = this.players.get(uuid);
        if (session && inv.handleClick(session.inv, slot, button)) {
          this.#sendWindowItems(uuid);
        }
        break;
      }

      /* [P3] TeleportConfirm: 服务端 TP 后客户端确认 (日志留痕) */
      case SERVERBOUND.TELEPORT_CONFIRM.id: {
        logger.info('teleport_confirm', { uuid });
        break;
      }

      /* [P4] InteractEntity: type(U8: 0=攻击) entityId(I32) */
      case SERVERBOUND.INTERACT_ENTITY.id: {
        const type = r.readUInt8();
        const entityId = r.readInt32();
        if (type === 0) this.#handleAttack(uuid, entityId);
        break;
      }

      default:
        logger.warn('unknown_packet', { uuid, packetId });
        break;
    }
  }

  /* ==========================================================================
   * 聊天 / 命令 / 私聊 (Phase 3)
   * ======================================================================== */

  /**
   * 聊天入口 (二进制 0x17 与 JSON 调试通道共用):
   *   /xxx   → 管理命令 (permissions.js 鉴权)
   *   @Name  → 私聊 (经 ChatDO 定向投递)
   *   其他   → 过滤 → 区域广播
   */
  #handleChat(uuid, rawText) {
    const session = this.players.get(uuid);
    if (!session) return;

    // ---- 命令 ----
    if (rawText.startsWith('/')) {
      const ctx = this.#buildCommandContext(uuid);
      executeCommand(ctx, rawText);
      return;
    }

    // ---- 私聊: "@玩家名 消息" ----
    if (rawText.startsWith('@')) {
      const m = /^@(\S+)\s+(.+)$/.exec(rawText);
      if (!m) {
        this.#sendChatTo(uuid, '§7用法: @玩家名 消息');
        return;
      }
      const target = this.#findPlayerByName(m[1]);
      if (!target) {
        this.#sendChatTo(uuid, `§c玩家 ${m[1]} 不在线`);
        return;
      }
      this.#wmChatPublish({ from: session.name, msg: m[2], channel: 'private', to: target.uuid });
      this.#sendChatTo(uuid, `§7[我 → ${target.name}] §f${m[2]}`);
      if (target.uuid !== uuid && this.players.has(target.uuid)) {
        this.#sendChatTo(target.uuid, `§7[${session.name} → 我] §f${m[2]}`);
      }
      return;
    }

    // ---- 区域聊天: 限流已在 ChatDO 侧做, 这里做过滤 + 广播 ----
    const text = filterMessage(rawText.slice(0, 256));
    this.#broadcastChat(`<${session.name}> ${text}`);
    this.hooks.emit('chat', { uuid, name: session.name, text });
  }

  /* ==========================================================================
   * 游戏主循环 (Alarm 驱动)
   * ======================================================================== */

  #startGameLoop() {
    this.gameLoopRunning = true;
    this.lastTickAt = Date.now();
    this.state.storage.setAlarm(Date.now() + this.config.tickRateMs);
    logger.info('region_start', { region: this.#regionKey() });
  }

  /** Alarm 触发 = 执行一次 tick */
  async alarm() {
    if (this.players.size === 0) {
      this.gameLoopRunning = false;
      return;
    }

    const t0 = Date.now();

    // [P3] TPS 估算 (EWMA)
    const interval = t0 - this.lastTickAt;
    if (interval > 0) this.tpsEwma = this.tpsEwma * 0.9 + (1000 / interval) * 0.1;
    this.lastTickAt = t0;

    try {
      await this.#gameTick();
      this.tickCount++;
      this.gameClock = (this.gameClock + 1) % DAY_LENGTH_TICKS;

      /* ---- 周期任务 ---- */
      if (this.tickCount % 100 === 0) {
        await this.persistDirty(); // 每 5s: 脏区块批量落盘
        this.#cleanupReconnect();  // 每 5s: 清理过期重连快照
      }
      if (this.tickCount % 200 === 0) {
        this.#broadcast(CLIENTBOUND.KEEP_ALIVE.id, new PacketWriter(2).toUint8Array());
        this.#checkHeartbeats();
        // [P2] 世界时间下发 (昼夜由客户端本地渲染)
        const tw = new PacketWriter(8);
        tw.writeInt32(this.gameClock);
        tw.writeBoolean(this.#isNight());
        this.#broadcast(CLIENTBOUND.WORLD_TIME.id, tw.toUint8Array());
      }
      if (this.tickCount % 1200 === 0) {
        await this.#savePlayerStates(); // 每 60s: 玩家状态落 users 库
        this.#reportHealth();           // 每 60s: 指标上报/告警
      }
    } catch (err) {
      logger.error('tick_error', { region: this.#regionKey(), tick: this.tickCount, error: err.message });
    }

    const elapsed = Date.now() - t0;
    if (elapsed > 40) {
      this.overrunCount++;
      logger.warn('tick_overrun', { region: this.#regionKey(), elapsedMs: elapsed });
    }
    if (this.players.size > 0) {
      this.state.storage.setAlarm(Date.now() + Math.max(10, this.config.tickRateMs - elapsed));
    } else {
      this.gameLoopRunning = false;
    }
  }

  /** 单次游戏 Tick */
  async #gameTick() {
    /* ---- 1. 消费输入队列 (移动/挖掘/放置) ---- */
    const qStart = Date.now();
    const inputs = this.inputQueue;
    this.inputQueue = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      try {
        if (input.type === 'move') this.#handlePlayerMove(input);
        else if (input.type === 'dig') await this.#handleDigging(input);
        else if (input.type === 'place') await this.#handlePlacement(input);
      } catch (err) {
        logger.error('input_error', { type: input.type, uuid: input.uuid, error: err.message });
      }
      if (Date.now() - qStart > 40 && i < inputs.length - 1) {
        this.inputQueue = inputs.slice(i + 1).concat(this.inputQueue);
        logger.warn('tick_budget_hit', { region: this.#regionKey(), deferred: inputs.length - 1 - i });
        break;
      }
    }

    /* ---- 2. [P4] 实体 AI (怪物行为 + 生成器) ---- */
    if (this.config.maxEntitiesPerRegion > 0) {
      try {
        this.entityWorld.tickAll({
          tick: this.tickCount,
          isNight: () => this.#isNight(),
          random01: Math.random,
          playersList: () => [...this.players.entries()].map(([u, p]) => ({ uuid: u, pos: p.pos })),
          nearestPlayer: (pos, range) => this.#nearestPlayer(pos, range),
          damagePlayer: (u, amount, byEntityId) => this.#damagePlayer(u, amount, byEntityId),
          canStand: (x, y, z) => this.#canStand(x, y, z),
          onEntityMove: (e) => this.pendingEntityMoves.push(e),
          onEntitySpawn: (e) => this.#broadcastEntitySpawn(e),
        });
      } catch (err) {
        logger.error('entity_tick_error', { error: err.message });
      }
    }

    /* ---- 3. 实体移动差量广播 (与玩家合并进 EntityMove 批量包) ---- */
    const movers = [...this.players.values()].filter((p) => p.moved);
    if (movers.length > 0 || this.pendingEntityMoves.length > 0) {
      const w = new PacketWriter(64 + (movers.length + this.pendingEntityMoves.length) * 48);
      w.writeVarInt(movers.length + this.pendingEntityMoves.length);
      for (const p of movers) {
        w.writeString(this.#uuidOfSession(p));
        w.writeDouble(p.pos.x);
        w.writeDouble(p.pos.y);
        w.writeDouble(p.pos.z);
        w.writeFloat(p.yaw);
        w.writeFloat(p.pitch);
        p.moved = false;
      }
      for (const e of this.pendingEntityMoves) {
        w.writeString(`e${e.id}`); // 实体用 'e<id>' 伪 uuid, 与玩家同构
        w.writeDouble(e.pos.x);
        w.writeDouble(e.pos.y);
        w.writeDouble(e.pos.z);
        w.writeFloat(e.yaw);
        w.writeFloat(0);
      }
      this.pendingEntityMoves = [];
      this.#broadcast(CLIENTBOUND.ENTITY_MOVE.id, w.toUint8Array());
    }

    /* ---- 4. [P2] 视距环区块流式下发 (每玩家每 tick 限额, 防 D1 读风暴) ---- */
    await this.#processChunkQueues();
  }

  #isNight() {
    return this.gameClock >= 13000 && this.gameClock < 23000;
  }

  /* ==========================================================================
   * 游戏逻辑: 移动(反作弊) / 挖掘 / 放置 / 攻击 / 伤害
   * ======================================================================== */

  /** 移动处理: 反作弊校验 + 视距环跨区块检测 + 广播标记 */
  #handlePlayerMove(input) {
    const p = this.players.get(input.uuid);
    if (!p) return;

    // [P3] 反作弊: 速度/飞行/垂直检测 → 不合法则服务端回拉 (PLAYER_POSITION)
    const verdict = p.tracker.feed({ x: input.x, y: input.y, z: input.z, onGround: input.onGround });
    if (verdict.action === 'correct') {
      p.anticheatFlags++;
      logger.warn('anticheat_correct', { uuid: input.uuid, reason: verdict.reason, flags: p.anticheatFlags });
      this.#teleport(input.uuid, verdict.pos, 'anticheat');
      if (p.anticheatFlags % 10 === 0) {
        this.#sendChatTo(input.uuid, '§7[反作弊] 检测到异常移动, 已自动回拉');
      }
      return;
    }

    // 世界边界钳制
    p.pos.set(
      clamp(input.x, -3e7, 3e7),
      clamp(input.y, CHUNK.MIN_Y, CHUNK.MAX_Y),
      clamp(input.z, -3e7, 3e7)
    );
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.onGround = input.onGround;
    p.moved = true;

    // [P2] 跨区块 → 补发新进入视距的区块
    const cx = Math.floor(p.pos.x / 16);
    const cz = Math.floor(p.pos.z / 16);
    if (p.lastChunkKey !== `${cx},${cz}`) {
      p.lastChunkKey = `${cx},${cz}`;
      this.#enqueueMissingChunks(input.uuid, cx, cz);
      // 区域边界提示 (跨区域迁移 TODO Phase 3+: 目前靠 WorldManagerDO 重连路由)
      const rx = Math.floor(cx / 16), rz = Math.floor(cz / 16);
      if ((rx !== this.region.x || rz !== this.region.z) && !p.warnedRegionExit) {
        p.warnedRegionExit = true;
        this.#sendChatTo(input.uuid, '§7你正在离开当前区域, 重连后将自动回到上次位置 (跨区无缝迁移开发中)');
      }
    }
  }

  /** 挖掘 (即挖即碎) — [P4] 土地保护 + 事件总线 */
  async #handleDigging(input) {
    const p = this.players.get(input.uuid);
    if (!p) return;

    // [P4] 认领保护
    const verdict = this.claims.canModify(input.x >> 4, input.z >> 4, input.uuid, p);
    if (!verdict.allowed) {
      this.#sendChatTo(input.uuid, `§c${verdict.reason}`);
      return;
    }

    const old = await this.setBlockState(input.x, input.y, input.z, AIR, input.uuid);
    if (old !== AIR) {
      this.hooks.emit('block.break', { uuid: input.uuid, name: p.name, pos: { x: input.x, y: input.y, z: input.z }, block: old });
    }
  }

  /** 放置 — 适配器规范化 + 认领保护 + [P3] 生存模式扣物品 */
  async #handlePlacement(input) {
    const p = this.players.get(input.uuid);
    if (!p) return;

    const verdict = this.claims.canModify(input.x >> 4, input.z >> 4, input.uuid, p);
    if (!verdict.allowed) {
      this.#sendChatTo(input.uuid, `§c${verdict.reason}`);
      return;
    }

    const normalized = (p.adapter ?? selectAdapter('generic')).normalizeBlockName(input.blockName);
    if (!normalized) {
      logger.warn('place_rejected', { uuid: input.uuid, blockName: input.blockName });
      return;
    }

    // [P3] 生存/冒险模式: 必须手持对应物品且消耗 1 个
    if (p.gamemode === GAMEMODES.SURVIVAL || p.gamemode === GAMEMODES.ADVENTURE) {
      const held = p.inv.slots[p.inv.held];
      if (!held || !normalized.includes(held.item.replace('minecraft:', ''))) {
        this.#sendChatTo(input.uuid, '§7手持物品与放置方块不一致');
        return;
      }
      inv.consumeHeld(p.inv);
      this.#sendWindowItems(input.uuid);
    }

    await this.setBlockState(input.x, input.y, input.z, normalized, input.uuid);
    this.hooks.emit('block.place', { uuid: input.uuid, name: p.name, pos: { x: input.x, y: input.y, z: input.z }, block: normalized });
  }

  /** [P4] 玩家攻击实体 (InteractEntity 0x20) */
  #handleAttack(uuid, entityId) {
    const p = this.players.get(uuid);
    const e = this.entityWorld.entities.get(entityId);
    if (!p || !e) return;

    // 距离合理性 (赤手攻击范围 ~3 格, 放宽到 6 防网络抖动误杀)
    const dist = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y, e.pos.z - p.pos.z);
    if (dist > 6) return;

    const res = this.entityWorld.damage(entityId, ATTACK_DAMAGE);
    if (res.dead) {
      this.#broadcastEntityDestroy(entityId);
      this.#sendChatTo(uuid, `§a击杀 ${e.type} (+1 金币)`);
      p.coins += 1; // [P4] 经济: 击杀奖励
      this.#persistCoins(uuid, p.coins);
      this.hooks.emit('entity.death', { entityId, type: e.type, by: uuid });
    } else {
      this.#sendChatTo(uuid, `§7对 ${e.type} 造成 ${ATTACK_DAMAGE} 伤害 (剩余 ${res.health})`);
    }
  }

  /** [P4] 实体伤害玩家 (AI 回调) — 死亡则重生回出生点 */
  #damagePlayer(uuid, amount, _byEntityId) {
    const p = this.players.get(uuid);
    if (!p || p.gamemode === GAMEMODES.CREATIVE || p.gamemode === GAMEMODES.SPECTATOR) return;

    p.health = Math.max(0, p.health - amount);
    this.#sendUpdateHealth(uuid);

    if (p.health <= 0) {
      this.#broadcastChat(`§c${p.name} 死亡了`);
      this.hooks.emit('player.death', { uuid, name: p.name });
      p.health = 20;
      p.food = 20;
      this.#sendUpdateHealth(uuid);
      this.#teleport(uuid, this.#spawnPoint(), 'respawn');
    }
  }

  /**
   * [P2] 服务端权威传送 (PLAYER_POSITION 0x21):
   * /tp、反作弊回拉、重生共用一条通路; 客户端应回 TeleportConfirm
   */
  #teleport(uuid, pos, source) {
    const p = this.players.get(uuid);
    if (!p) return;
    p.pos.set(pos.x, pos.y, pos.z);
    p.tracker.markTeleport(p.pos);
    p.teleported = true;

    const w = new PacketWriter(40);
    w.writeDouble(p.pos.x);
    w.writeDouble(p.pos.y);
    w.writeDouble(p.pos.z);
    w.writeFloat(p.yaw);
    w.writeFloat(p.pitch);
    this.#sendTo(uuid, CLIENTBOUND.PLAYER_POSITION.id, w.toUint8Array());

    // 补发新视野区块 (传送可能跨区块)
    const cx = Math.floor(p.pos.x / 16);
    const cz = Math.floor(p.pos.z / 16);
    p.lastChunkKey = `${cx},${cz}`;
    this.#enqueueMissingChunks(uuid, cx, cz);
    this.hooks.emit('player.teleport', { uuid, source, pos: { ...p.pos } });
  }

  /* ==========================================================================
   * 方块访问 (v2 name-based, 与 v0.1 一致)
   * ======================================================================== */

  /** 读方块名 (缓存未命中返回 air; 完整异步加载走 #getOrLoadChunk) */
  getBlockName(wx, wy, wz) {
    const cx = wx >> 4, cz = wz >> 4;
    const chunk = this.chunkCache.get(`${cx},${cz}`);
    if (!chunk) return AIR;

    const sectionY = Math.floor(wy / 16);
    const section = chunk.sections.get(sectionY);
    if (!section) return AIR;

    const idx = worldToSectionIndex(wx, wy, wz);
    return section.palette[section.indices[idx]]?.name ?? AIR;
  }

  /** [P4] 实体可站立判定: 地面非空 + 脚部/头部为空 */
  #canStand(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const ground = this.getBlockName(fx, fy - 1, fz);
    return ground !== AIR
      && this.getBlockName(fx, fy, fz) === AIR
      && this.getBlockName(fx, fy + 1, fz) === AIR;
  }

  /** [P4] 最近玩家 (AI 追击目标) */
  #nearestPlayer(pos, range) {
    let best = null;
    let bestDist = range * range;
    for (const [uuid, p] of this.players) {
      const d = (p.pos.x - pos.x) ** 2 + (p.pos.y - pos.y) ** 2 + (p.pos.z - pos.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { uuid, pos: p.pos };
      }
    }
    return best;
  }

  /**
   * 写方块状态 (v2 name-based): 改内存 + 标脏 + 广播 BlockUpdate + 记审计
   * @returns {Promise<string>} 旧方块名
   */
  async setBlockState(wx, wy, wz, blockName, actorUuid = null) {
    if (wy < CHUNK.MIN_Y || wy >= CHUNK.MAX_Y) return AIR;

    const cx = wx >> 4, cz = wz >> 4;
    const chunk = await this.#getOrLoadChunk(cx, cz);
    const sectionY = Math.floor(wy / 16);
    const section = this.#ensureSection(chunk, sectionY);

    const idx = worldToSectionIndex(wx, wy, wz);
    const oldName = section.palette[section.indices[idx]]?.name ?? AIR;
    if (oldName === blockName) return oldName;

    /* ---- 调色板管理 (name 主键; id 仅 section 内局部序号, air 恒 0) ---- */
    let paletteIdx = section.palette.findIndex((e) => e.name === blockName);
    if (paletteIdx === -1) {
      section.palette.push({ id: section.palette.length, name: blockName });
      paletteIdx = section.palette.length - 1;
    }
    section.indices[idx] = paletteIdx;
    section.dirty = true;
    chunk.isDirty = true;
    this.dirtyChunks.add(`${cx},${cz}`);

    // 审计日志 (state_id 列以字符串存方块名, SQLite 动态类型兼容)
    this.pendingLogEntries.push({
      actorUuid,
      actorType: actorUuid ? 'player' : 'system',
      x: wx, y: wy, z: wz,
      oldStateId: oldName,
      newStateId: blockName,
      tick: this.tickCount,
      at: Date.now(),
    });

    /* ---- BlockUpdate 广播 v2 ---- */
    const w = new PacketWriter(24);
    w.writeInt32(wx);
    w.writeInt32(wy);
    w.writeInt32(wz);
    w.writeString(blockName);
    this.#broadcast(CLIENTBOUND.BLOCK_UPDATE.id, w.toUint8Array());

    return oldName;
  }

  /* ==========================================================================
   * 区块加载 / 生成 / 视距环流式
   * ======================================================================== */

  /** 获取或加载区块: 内存 → D1 → 超平坦生成 (三级降级) */
  async #getOrLoadChunk(cx, cz) {
    const key = `${cx},${cz}`;

    const cached = this.chunkCache.get(key);
    if (cached) return cached;

    const loaded = await loadChunk(this.env.WORLD_DB, cx, cz).catch(() => null);
    const chunk = { cx, cz, sections: new Map(), tileEntities: [], isDirty: false };

    if (loaded?.found) {
      for (const s of loaded.sections) {
        chunk.sections.set(s.sectionY, {
          palette: s.palette,
          indices: decodeBlockIndices(s.compressedIndices, Math.max(s.palette.length, 1)),
          skyLight: s.skyLight,
          blockLight: s.blockLight,
          dirty: false,
        });
      }
      chunk.tileEntities = loaded.tileEntities;
    } else {
      this.#generateFlatTerrain(chunk);
      chunk.isDirty = true;
      this.dirtyChunks.add(key);
    }

    this.chunkCache.set(key, chunk);
    return chunk;
  }

  /** 超平坦: 基岩(-64) + 泥土(-63..-61) + 草方块(-60) */
  #generateFlatTerrain(chunk) {
    const section = this.#ensureSection(chunk, -4);
    section.palette = [
      { id: 0, name: BLOCK_NAMES.AIR },
      { id: 1, name: BLOCK_NAMES.BEDROCK },
      { id: 2, name: BLOCK_NAMES.DIRT },
      { id: 3, name: BLOCK_NAMES.GRASS_BLOCK },
    ];
    section.indices.fill(0);

    const idxOf = (x, y, z) => ((y & 0xf) << 8) | ((z & 0xf) << 4) | (x & 0xf);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        section.indices[idxOf(x, 0, z)] = 1;
        section.indices[idxOf(x, 1, z)] = 2;
        section.indices[idxOf(x, 2, z)] = 2;
        section.indices[idxOf(x, 3, z)] = 2;
        section.indices[idxOf(x, 4, z)] = 3; // y=-60 草方块 (出生高度)
      }
    }
    section.dirty = true;
  }

  #ensureSection(chunk, sectionY) {
    let s = chunk.sections.get(sectionY);
    if (!s) {
      s = {
        palette: [{ id: 0, name: BLOCK_NAMES.AIR }],
        indices: new Uint16Array(CHUNK.SECTION_VOLUME),
        skyLight: null,
        blockLight: null,
        dirty: false,
      };
      chunk.sections.set(sectionY, s);
    }
    return s;
  }

  /** ChunkData payload (v2: 调色板名字符串) */
  #buildChunkDataPayload(chunk) {
    const w = new PacketWriter(512);
    w.writeInt32(chunk.cx);
    w.writeInt32(chunk.cz);
    w.writeBoolean(true);

    const packed = [...chunk.sections.entries()].filter(([, s]) => s.palette.length > 1 || s.indices.some((v) => v !== 0));
    w.writeVarInt(packed.length);

    for (const [sectionY, s] of packed) {
      const nonAir = s.indices.reduce((n, pi) => (s.palette[pi]?.name !== AIR ? n + 1 : n), 0);
      w.writeVarInt(sectionY);
      w.writeUInt16(nonAir);
      w.writeVarInt(s.palette.length);
      for (const entry of s.palette) w.writeString(entry.name);

      const raw = encodeBlockIndices(s.indices, s.palette.length);
      w.writeVarInt(raw.length);
      w.writeBytes(raw);
    }
    return w.toUint8Array();
  }

  /* ---- [P2] 视距环流式: 入队 + 限额发送 ---- */

  /** 进服/传送: 重建整个视距环队列 (按距离升序) */
  #enqueueViewChunks(uuid) {
    const p = this.players.get(uuid);
    if (!p) return;
    const cx = Math.floor(p.pos.x / 16);
    const cz = Math.floor(p.pos.z / 16);
    p.lastChunkKey = `${cx},${cz}`;
    p.viewChunks.clear();
    p.chunkQueue = [];
    this.#enqueueMissingChunks(uuid, cx, cz);
  }

  /** 把视野内未下发过的区块加入队列 (按距离排序, 近的先发) */
  #enqueueMissingChunks(uuid, ccx, ccz) {
    const p = this.players.get(uuid);
    if (!p) return;
    const vd = this.config.viewDistance;
    const pending = [];
    for (let dx = -vd; dx <= vd; dx++) {
      for (let dz = -vd; dz <= vd; dz++) {
        const key = `${ccx + dx},${ccz + dz}`;
        if (!p.viewChunks.has(key)) pending.push({ cx: ccx + dx, cz: ccz + dz, dist: dx * dx + dz * dz });
      }
    }
    pending.sort((a, b) => a.dist - b.dist);
    p.chunkQueue = p.chunkQueue.concat(pending);
  }

  /** 每 tick: 每玩家最多发 CHUNK_SEND_BUDGET_PER_TICK 个区块 */
  async #processChunkQueues() {
    for (const [uuid, p] of this.players) {
      let budget = CHUNK_SEND_BUDGET_PER_TICK;
      while (budget-- > 0 && p.chunkQueue.length > 0) {
        const { cx, cz } = p.chunkQueue.shift();
        const key = `${cx},${cz}`;
        if (p.viewChunks.has(key)) continue; // 可能已被并发入队
        p.viewChunks.add(key);
        try {
          const chunk = await this.#getOrLoadChunk(cx, cz);
          this.#sendTo(uuid, CLIENTBOUND.CHUNK_DATA.id, this.#buildChunkDataPayload(chunk));
        } catch (err) {
          logger.error('chunk_send_fail', { uuid, key, error: err.message });
        }
      }
      // 内存保护: 队列积压超过 2×视距 → 截断 (玩家已在别处)
      if (p.chunkQueue.length > (2 * this.config.viewDistance + 1) ** 2) {
        p.chunkQueue.length = 0;
      }
    }
  }

  /* ==========================================================================
   * 持久化 (区块批量 + 玩家状态)
   * ======================================================================== */

  /** 脏区块批量落库 — 单事务原子提交 (与 v0.1 一致) */
  async persistDirty() {
    if (this.dirtyChunks.size === 0 && this.pendingLogEntries.length === 0) return;

    const batchOps = [];

    for (const key of this.dirtyChunks) {
      const chunk = this.chunkCache.get(key);
      if (!chunk) continue;

      const [cx, cz] = key.split(',').map(Number);
      for (const [sectionY, section] of chunk.sections) {
        if (!section.dirty) continue;
        batchOps.push(
          await prepareSectionUpsert(
            this.env.WORLD_DB, cx, cz, sectionY,
            section.palette, section.indices,
            section.skyLight, section.blockLight
          )
        );
        section.dirty = false;
      }
      batchOps.push(prepareChunkCleanMark(this.env.WORLD_DB, cx, cz));
    }

    const logOp = prepareBlockChangeLogInsert(this.env.WORLD_DB, this.pendingLogEntries);
    if (logOp) batchOps.push(logOp);

    try {
      if (batchOps.length > 0) await this.env.WORLD_DB.batch(batchOps);
      this.dirtyChunks.clear();
      this.pendingLogEntries = [];
    } catch (err) {
      logger.error('persist_fail', { region: this.#regionKey(), error: err.message });
      for (const key of this.dirtyChunks) {
        const chunk = this.chunkCache.get(key);
        if (chunk) for (const s of chunk.sections.values()) s.dirty = true;
      }
    }
  }

  /** 周期: 全部在线玩家 → users 库 (位置+背包+金币+角色) */
  async #savePlayerStates() {
    for (const [uuid, p] of this.players) {
      await this.#persistPlayer(uuid, p).catch(() => {});
    }
  }

  /** 单玩家立即持久化 (位置/背包走 savePlayerState; 金币/角色单独 UPDATE) */
  async #persistPlayer(uuid, p) {
    await savePlayerState(this.env, {
      uuid: uuid.replace(/-/g, ''),
      name: p.name,
      world: this.dim,
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      yaw: p.yaw, pitch: p.pitch,
      gamemode: p.gamemode, health: p.health, food: p.food,
    }, inv.serialize(p.inv));
    await this.#persistCoins(uuid, p.coins, p.role);
  }

  /** 金币/角色落盘 (fire-and-forget 调用方无需 await) */
  #persistCoins(uuid, coins, role) {
    return this.env.USERS_DB.prepare('UPDATE player_data SET coins = ?, role = ? WHERE uuid = ?')
      .bind(Math.floor(coins), role ?? 'player', uuid.replace(/-/g, ''))
      .run().catch(() => {});
  }

  /* ==========================================================================
   * 管理命令上下文 (commands.js 的全部副作用回调)
   * ======================================================================== */

  #buildCommandContext(uuid) {
    const sender = this.players.get(uuid);

    return {
      sender: { uuid, name: sender.name, role: sender.role, session: sender },
      reply: (text) => this.#sendChatTo(uuid, text),
      broadcast: (text) => this.#broadcastChat(text),

      findPlayerByName: (name) => this.#findPlayerByName(name),
      onlineAll: () => this.#onlineAll(),
      regionStats: () => ({
        region: this.#regionKey(),
        tps: this.tpsEwma,
        tick: this.tickCount,
        entities: this.entityWorld.stats().total,
        cachedChunks: this.chunkCache.map.size,
      }),

      teleport: (targetUuid, pos, source) => this.#teleport(targetUuid, pos, source),
      teleportToPlayer: (fromUuid, targetUuid) => {
        const t = this.players.get(targetUuid);
        if (t) this.#teleport(fromUuid, t.pos, 'command');
      },

      kick: (targetUuid, reason) => this.#kick(targetUuid, reason),
      ban: (name, reason) => {
        this.#wmFetch('/ban', { name, reason, by: sender.name }).catch(() => {});
        // 本区域在线的同名玩家立即踢出 (其他区域重连时被 game.js 拦截)
        const t = this.#findPlayerByName(name);
        if (t) this.#kick(t.uuid, `封禁: ${reason}`);
      },
      unban: (name) => this.#wmFetch('/unban', { name }).catch(() => {}),
      setRole: async (targetUuid, role) => {
        const t = this.players.get(targetUuid);
        if (!t) return;
        t.role = role;
        await this.#persistCoins(targetUuid, t.coins, role);
        this.#sendChatTo(targetUuid, `§a你的角色已更新为 ${role}`);
      },
      setGamemode: (targetUuid, gm) => {
        const t = this.players.get(targetUuid);
        if (!t) return;
        t.gamemode = gm;
        t.tracker.setGamemode(['survival', 'creative', 'adventure', 'spectator'][gm]);
        this.#sendChatTo(targetUuid, `§a游戏模式已切换 (${gm})`);
      },

      saveAll: () => this.persistDirty().catch(() => {}),

      claim: (claimerUuid) => {
        const cx = Math.floor(sender.pos.x / 16);
        const cz = Math.floor(sender.pos.z / 16);
        const res = this.claims.claim(cx, cz, claimerUuid, CLAIMS_LIMIT);
        if (res.ok) {
          this.env.WORLD_DB.prepare(
            'INSERT OR REPLACE INTO chunk_claims (chunk_x, chunk_z, owner_uuid, owner_name, claimed_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(cx, cz, claimerUuid, sender.name, Date.now()).run().catch(() => {});
          this.hooks.emit('claim.create', { uuid: claimerUuid, cx, cz });
        }
        return { ...res, cx, cz, owned: this.claims.countOf(claimerUuid) };
      },
      unclaim: (claimerUuid) => {
        const cx = Math.floor(sender.pos.x / 16);
        const cz = Math.floor(sender.pos.z / 16);
        const res = this.claims.unclaim(cx, cz, claimerUuid, hasPermission(sender, 'world.claim.bypass'));
        if (res.ok) {
          this.env.WORLD_DB.prepare('DELETE FROM chunk_claims WHERE chunk_x = ? AND chunk_z = ?')
            .bind(cx, cz).run().catch(() => {});
        }
        return res;
      },
      claimsOf: (u) => this.claims.claimsOf(u),

      balanceOf: (u) => this.players.get(u)?.coins ?? 0,
      pay: (fromUuid, toUuid, amount) => {
        const from = this.players.get(fromUuid);
        const to = this.players.get(toUuid);
        if (!from || !to) return { ok: false, reason: '目标不在线' };
        const res = validatePay(from.coins, amount);
        if (!res.ok) return res;
        from.coins -= res.amount;
        to.coins += res.amount;
        this.#persistCoins(fromUuid, from.coins, from.role);
        this.#persistCoins(toUuid, to.coins, to.role);
        return { ok: true };
      },
      grant: (toUuid, amount) => {
        const to = this.players.get(toUuid);
        if (!to) return;
        to.coins += Math.min(MAX_GRANT, Math.max(0, Math.floor(amount)));
        this.#persistCoins(toUuid, to.coins, to.role);
      },
    };
  }

  /* ==========================================================================
   * WorldManagerDO / ChatDO 桥接
   * ======================================================================== */

  /** WM stub POST (fire-and-forget 场景由调用方 .catch 吞错) */
  #wmFetch(path, body) {
    const wm = this.env.WORLD_MANAGER.get(this.env.WORLD_MANAGER.idFromName('singleton'));
    return wm.fetch(`https://wm${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /** 全服/私聊消息 → ChatDO (区域广播外的通道) */
  #wmChatPublish(record) {
    const chat = this.env.CHAT.get(this.env.CHAT.idFromName('singleton'));
    return chat.fetch('https://chat/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {});
  }

  /** 全服在线列表 (WM 路由表) */
  async #onlineAll() {
    try {
      const wm = this.env.WORLD_MANAGER.get(this.env.WORLD_MANAGER.idFromName('singleton'));
      const res = await wm.fetch('https://wm/online');
      const data = await res.json();
      return (data.online ?? []).map((o) => ({ name: o.name, region: o.region }));
    } catch {
      return [...this.players.values()].map((p) => ({ name: p.name, region: this.#regionKey() }));
    }
  }

  /** [P3] 指标上报 + 阈值告警 (每 60s 一次) */
  #reportHealth() {
    const overruns = this.overrunCount;
    this.overrunCount = 0;
    this.#wmFetch('/report', { tickOverruns: overruns }).catch(() => {});
    // 60s 内 >20% tick 溢出 → 告警 (节流在 WM 侧)
    if (overruns > 1200 * 0.2) {
      this.#wmFetch('/alert', {
        level: 'warn',
        message: `区域 ${this.#regionKey()} tick 溢出 ${overruns}/1200`,
        source: 'RegionDO',
      }).catch(() => {});
    }
  }

  /* ==========================================================================
   * 出生点 / 断线重连 (Phase 2/3)
   * ======================================================================== */

  /** 出生点: world_meta (spawn_x/y/z), 首次未加载时用默认值并触发懒加载 */
  #spawnPoint() {
    if (!this.spawn) {
      this.#loadSpawn();
      return new Vec3(0.5, -60, 0.5);
    }
    return this.spawn.clone();
  }

  async #loadSpawn() {
    if (this.spawnLoading) return;
    this.spawnLoading = true;
    try {
      const { results } = await this.env.WORLD_DB.prepare(
        "SELECT key, value FROM world_meta WHERE key IN ('spawn_x','spawn_y','spawn_z')"
      ).all();
      const m = Object.fromEntries((results ?? []).map((r) => [r.key, Number(r.value)]));
      if ([m.spawn_x, m.spawn_y, m.spawn_z].every(Number.isFinite)) {
        this.spawn = new Vec3(m.spawn_x + 0.5, m.spawn_y, m.spawn_z + 0.5);
        logger.info('spawn_loaded', { spawn: { ...this.spawn } });
      }
    } catch { /* world_meta 缺行 → 永久用默认值 */ }
  }

  /** 断开时保存重连快照 (宽限期 config.reconnectGraceMs) */
  #stashReconnect(uuid, session) {
    if (this.config.reconnectGraceMs <= 0) return;
    this.reconnectCache.set(uuid, {
      pos: session.pos.clone(),
      yaw: session.yaw,
      pitch: session.pitch,
      gamemode: session.gamemode,
      health: session.health,
      food: session.food,
      coins: session.coins,
      role: session.role,
      invJson: inv.serialize(session.inv),
      expiresAt: Date.now() + this.config.reconnectGraceMs,
    });
  }

  /** 重连取快照 (过期 → 返回 null, 走 D1 恢复) */
  #takeReconnect(uuid) {
    const snap = this.reconnectCache.get(uuid);
    if (!snap) return null;
    this.reconnectCache.delete(uuid);
    if (Date.now() > snap.expiresAt) return null;
    logger.info('reconnect_restore', { uuid, from: 'memory' });
    return snap;
  }

  #cleanupReconnect() {
    const now = Date.now();
    for (const [uuid, snap] of this.reconnectCache) {
      if (now > snap.expiresAt) this.reconnectCache.delete(uuid);
    }
  }

  /* ==========================================================================
   * 发送 / 心跳 / 查找 工具集
   * ======================================================================== */

  #sendTo(uuid, packetId, payload) {
    wsSafeSend(this.#wsOf(uuid), PacketWriter.frame(packetId, 0, payload));
  }

  #broadcast(packetId, payload) {
    const frame = PacketWriter.frame(packetId, 0, payload);
    for (const ws of this.state.getWebSockets()) wsSafeSend(ws, frame);
  }

  #broadcastFrameExcept(uuid, frame) {
    for (const ws of this.state.getWebSockets()) {
      if (this.#uuidOf(ws) === uuid) continue;
      wsSafeSend(ws, frame);
    }
  }

  /** 聊天广播 (全区域) */
  #broadcastChat(text) {
    const w = new PacketWriter(64 + text.length);
    w.writeString(text.slice(0, 256));
    this.#broadcast(CLIENTBOUND.CHAT_MESSAGE.id, w.toUint8Array());
  }

  /** 聊天定向 */
  #sendChatTo(uuid, text) {
    const w = new PacketWriter(64 + text.length);
    w.writeString(text.slice(0, 256));
    this.#sendTo(uuid, CLIENTBOUND.CHAT_MESSAGE.id, w.toUint8Array());
  }

  /** [P3] WindowItems 整包: count(VarInt) + n × {has(Bool) item(String) count(U8)} */
  #sendWindowItems(uuid) {
    const p = this.players.get(uuid);
    if (!p) return;
    const slots = inv.snapshot(p.inv);
    const w = new PacketWriter(16 + slots.length * 24);
    w.writeVarInt(slots.length);
    for (const s of slots) {
      if (s) {
        w.writeBoolean(true);
        w.writeString(s.item);
        w.writeUInt8(s.count);
      } else {
        w.writeBoolean(false);
      }
    }
    this.#sendTo(uuid, CLIENTBOUND.WINDOW_ITEMS.id, w.toUint8Array());
  }

  /** [P3] UpdateHealth: health(F32) food(U8) */
  #sendUpdateHealth(uuid) {
    const p = this.players.get(uuid);
    if (!p) return;
    const w = new PacketWriter(8);
    w.writeFloat(p.health);
    w.writeUInt8(p.food);
    this.#sendTo(uuid, CLIENTBOUND.UPDATE_HEALTH.id, w.toUint8Array());
  }

  /** [P4] EntitySpawn: entityId(I32) type(String) x,y,z(D) */
  #broadcastEntitySpawn(e) {
    const w = new PacketWriter(48);
    w.writeInt32(e.id);
    w.writeString(e.type);
    w.writeDouble(e.pos.x);
    w.writeDouble(e.pos.y);
    w.writeDouble(e.pos.z);
    this.#broadcast(CLIENTBOUND.ENTITY_SPAWN.id, w.toUint8Array());
  }

  /** [P4] EntityDestroy: entityId(I32) */
  #broadcastEntityDestroy(entityId) {
    const w = new PacketWriter(8);
    w.writeInt32(entityId);
    this.#broadcast(CLIENTBOUND.ENTITY_DESTROY.id, w.toUint8Array());
  }

  /** PlayerInfo(0x08): action(U8) uuid(String) name(String) */
  #playerInfoPacket(action, uuid, name) {
    const w = new PacketWriter(64);
    w.writeUInt8(action === 'join' ? 0 : 1);
    w.writeString(uuid);
    w.writeString(name);
    return PacketWriter.frame(CLIENTBOUND.PLAYER_INFO.id, 0, w.toUint8Array());
  }

  #checkHeartbeats() {
    const now = Date.now();
    for (const [uuid] of this.players) {
      const p = this.players.get(uuid);
      if (now - p.lastKeepAlive > 30_000) {
        this.#kick(uuid, '心跳超时');
        this.#wsOf(uuid)?.close(4000, 'heartbeat_timeout');
      }
    }
  }

  #kick(uuid, reason) {
    const w = new PacketWriter(128);
    w.writeString(reason);
    this.#sendTo(uuid, CLIENTBOUND.DISCONNECT.id, w.toUint8Array());
    this.#wsOf(uuid)?.close(1000, reason);
    logger.info('kick', { uuid, reason, by: 'system' });
  }

  /** 区域内按名字找玩家 (大小写不敏感) */
  #findPlayerByName(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    for (const [uuid, p] of this.players) {
      if (p.name.toLowerCase() === lower) return { uuid, name: p.name };
    }
    return null;
  }

  #wsOf(uuid) {
    const sockets = this.state.getWebSockets(uuid);
    return sockets.length > 0 ? sockets[0] : null;
  }

  #uuidOf(ws) {
    try {
      return ws.getTag?.(0) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  #uuidOfSession(session) {
    for (const [uuid, p] of this.players) {
      if (p === session) return uuid;
    }
    return 'unknown';
  }

  /** 解析实例名 `region:[dim:]x,z` → { x, z, dim } (P4 多维度) */
  #parseRegionFromName() {
    const m = /region:(?:([a-z]+):)?(-?\d+),(-?\d+)/.exec(this.state.id.name ?? '');
    if (!m) return { x: 0, z: 0, dim: 'overworld' };
    return {
      dim: m[1] ?? 'overworld',
      x: parseInt(m[2], 10),
      z: parseInt(m[3], 10),
    };
  }

  /** WM 路由键 (与 game.js idFromName 命名规则互逆) */
  #regionKey() {
    return this.dim === 'overworld' ? `${this.region.x},${this.region.z}` : `${this.dim}:${this.region.x},${this.region.z}`;
  }
}

/** WS 发送安全封装: 失效连接静默跳过 (不冒泡到 tick 循环) */
function wsSafeSend(ws, data) {
  try {
    if (ws) ws.send(data);
  } catch { /* 连接已死, webSocketClose 会清理 */ }
}




