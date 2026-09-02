/**
 * 多机器人运行器（v0.7）
 * 每个用户的机器人是独立实例，具备：
 *  - 人设(persona) + 机器人规定(rules) + 特殊词语法(specialWords)
 *  - 完整指令：/帮助 /重置 /人格 /模型 /ping /查违规（含无斜杠、@前缀兼容）
 *  - 群消息审计账本（每机器人独立持久化，供 /查违规）
 *  - 关键词自动注意 + 自动禁言（三级力度）+ 主动检查（可配置）
 *  - 对话记忆（每机器人独立持久化）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  QQBot,
  errorHandler,
  mentionGate,
  contentSanitizer,
  messageFilter,
  rateLimiter,
} from "@tencent-connect/qqbot-nodejs";
import { LlmClient } from "./llm.js";
import { MemoryStore } from "./memory.js";
import { GroupAuditLog } from "./audit.js";
import { splitLongText, parseCommand } from "./utils.js";
import { Bots } from "./store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const running = new Map(); // botId -> { instance, memory, llm, audit, status, lastError }

// ---------------- 默认配置 ----------------
const DEFAULT_PERSONA = [
  "你是一个严肃、专业、可靠的 QQ 群管理机器人「管理助手」。",
  "",
  "行为准则：",
  "- 语气正式、公事公办，回答简洁（1~4 句）",
  "- 负责解答群规、维护群内秩序，遇到违规行为（色情、辱骂、广告、刷屏等）要正式警告并提醒群规",
  "- 不闲聊、不卖萌、不玩梗，涉及群管理事务认真处理",
  "- 有人询问管理规定时，结合「机器人规定」内容回答",
  "- 始终使用中文，除非对方用其他语言",
  "- 回复请使用纯文本，不要使用 Markdown 格式（不要用 #、**、列表符号等）",
].join("\n");

// 把 AI 输出的 Markdown 转成 QQ 友好的纯文本
function toPlainText(s) {
  return String(s ?? "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trim())
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/^\s*\d+[.、)]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DEFAULT_KEYWORDS = [
  "色情", "黄图", "黄片", "黄站", "约炮", "嫖娼", "卖淫", "裸聊", "福利姬", "性交", "无码",
  "艳照", "色图", "淫秽", "污秽", "三级片", "av资源", "av网址", "av女优", "成人网站", "性爱", "操逼", "肏", "鸡巴",
];

// ---------------- 自动禁言配置 ----------------
// 严重罪行定义：色情类、违法/不实信息类（或审查定级「高」）
// 禁言力度两层：第一层群规（审查 AI 从群规条文换算出 ruleMinutes），第二层档位（倍率缩放）。
// 群规没写时长时，用下表兜底。
const MUTE_LEVELS = {
  light: { multiplier: 0.5, seriousMs: 30 * 60 * 1000, generalMs: 0 },        // 轻微：群规时长减半；兜底仅严重罪行禁言 30 分钟
  medium: { multiplier: 1, seriousMs: 60 * 60 * 1000, generalMs: 10 * 60 * 1000 }, // 中等：按群规执行；兜底一般 10 分钟 / 严重 1 小时
  heavy: { multiplier: 2, seriousMs: 24 * 60 * 60 * 1000, generalMs: 60 * 60 * 1000 }, // 重度：群规时长翻倍；兜底一般 1 小时 / 严重 24 小时
};
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000; // 单次禁言上限 30 天
const SERIOUS_TYPES = new Set(["色情", "违法/不实信息"]);
function isSeriousViolation(v) {
  return Boolean(v && (SERIOUS_TYPES.has(v?.type) || v?.severity === "高"));
}
const REVIEWER_PROMPT = [
  "你是一个 QQ 群的「群规风纪委员」，负责审查群聊消息记录是否违规。",
  "违规类型（按严重程度排序，从严判定）：",
  "1. 色情：色情、低俗、性暗示、约炮、淫秽资源等内容（重点打击，最严重，发现即定级「高」）",
  "2. 违法/不实信息：谣言、诈骗、违法违规、危害社会的内容（重点打击，最严重，发现即定级「高」）",
  "3. 辱骂：脏话、人身攻击、侮辱性言论",
  "4. 广告：广告推销、引流链接、加群广告",
  "5. 刷屏/无意义灌水：同一人短时间内连续大量重复或无意义消息",
  "6. 其他违规：引战、敏感内容等",
  "规则：",
  "- 色情、违法/不实信息一经发现，severity 一律标「高」",
  "- 只报告证据确凿的违规，模棱两可的不算",
  "- evidence 必须逐字照抄消息原文，不得改写、概括或省略，不超过 30 字",
  "- 输出必须是 JSON，格式：",
  '{"violations":[{"type":"色情","user":"昵称","evidence":"原话摘要","severity":"高","ruleMinutes":30}],"summary":"一句话总结"}',
  "- ruleMinutes：按群规换算出的该违规禁言时长（分钟）。群规写明时长的（如「禁言1-24小时」「最高可处禁言2日」），取与情节相称的数值，例如「1-24小时」按情节在 60~1440 之间取值，「最高可处禁言12小时」一般取一半左右；群规只写「禁止/严禁」没写时长的，一般违规填 10、严重违规填 60；群规完全没有涉及该类违规或群规为空时，省略 ruleMinutes 字段。禁止凭空编造群规里不存在的时长",
  '- 没有违规时输出 {"violations":[],"summary":"今日群内未发现违规内容"}',
].join("\n");

// 构建审查提示词：内置判定标准 + 注入群主制定的「机器人规定」（群规优先，JSON 输出要求保持最后）
function buildReviewPrompt(rulesText) {
  if (!rulesText) return REVIEWER_PROMPT;
  const idx = REVIEWER_PROMPT.indexOf("\n规则：\n");
  const block = "\n## 本群机器人规定（群主制定，必须严格遵守；若与上述类型冲突，以本群规为准）\n" + rulesText;
  if (idx < 0) return REVIEWER_PROMPT + "\n\n" + block;
  return REVIEWER_PROMPT.slice(0, idx) + block + REVIEWER_PROMPT.slice(idx);
}

const REBUKES = [
  "喂喂喂，公共场合能不能管管自己？脑子里的黄色废料都漏出来了，这条我记小本本上了！😒",
  "啧，群规第一条：黄色内容禁止外泄。说的就是你，收敛点，再犯直接点名公示！",
  "请你立刻停下！本群不是法外之地，再发这种内容，我就把你今天的所作所为整理成大字报发群里。",
];

const BARE_COMMAND_WORDS = new Set([
  "help", "帮助", "菜单",
  "reset", "重置", "清空",
  "persona", "人格", "人设",
  "model", "模型",
  "ping",
  "xuncha", "巡查", "巡查状态",
  "check", "查违规", "违规检查", "群规检查", "公示",
  "analysis", "分析", "群分析", "建议", "群建议",
]);

export function defaultBotRecord(ownerId, name = "我的机器人") {
  return {
    id: null,
    ownerId,
    name,
    enabled: true,
    status: "stopped",
    lastError: "",
    qq: { appId: "", appSecret: "" },
    llm: { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat", temperature: 0.7 },
    persona: DEFAULT_PERSONA,
    rules: "",
    specialWords: [], // [{ word, action: "reply"|"ai"|"ignore", reply?, prompt? }]
    moderation: { enabled: true, autoRebuke: true, cooldownMinutes: 5, keywords: [...DEFAULT_KEYWORDS], autoMute: { enabled: false, level: "light" } },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeLogger(botId, prefix) {
  const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  return {
    info: (m) => console.log(`[${stamp()}] [${prefix}:${botId}] ℹ️  ${m}`),
    warn: (m) => console.log(`[${stamp()}] [${prefix}:${botId}] ⚠️  ${m}`),
    error: (m) => console.error(`[${stamp()}] [${prefix}:${botId}] ❌ ${m}`),
    debug: () => {},
  };
}

function buildSystemPrompt(record) {
  const parts = [record.persona || DEFAULT_PERSONA];
  if (record.rules && String(record.rules).trim()) {
    parts.push("\n## 机器人规定（必须严格遵守）\n" + String(record.rules).trim());
  }
  return parts.join("\n");
}

function matchSpecialWord(record, text) {
  const words = Array.isArray(record.specialWords) ? record.specialWords : [];
  for (const item of words) {
    const w = String(item?.word ?? "").trim();
    if (!w) continue;
    if (text.includes(w)) return item;
  }
  return null;
}

function matchPornKeywords(moderation, content) {
  if (!moderation?.enabled || !moderation?.autoRebuke) return false;
  const keywords = Array.isArray(moderation.keywords) ? moderation.keywords : [];
  if (keywords.length === 0) return false;
  const text = String(content ?? "").toLowerCase();
  return keywords.some((kw) => text.includes(String(kw).toLowerCase()));
}

async function safeSend(bot, target, content) {
  try {
    await bot.sendText(target, content);
  } catch {}
}

export async function startBot(botId) {
  if (running.has(botId)) return { status: "running", lastError: "" };
  const record = Bots.findWithSecrets(botId);
  if (!record) throw new Error("机器人不存在");

  const problems = [];
  if (!record.qq?.appId) problems.push("QQ AppID 未填写");
  if (!record.qq?.appSecret) problems.push("QQ AppSecret 未填写");
  if (!record.llm?.apiKey && !/localhost|127\.0\.0\.1/.test(record.llm?.baseUrl ?? "")) problems.push("AI API Key 未填写");
  if (problems.length > 0) {
    const err = "启动前检查未通过：" + problems.join("；");
    Bots.update(botId, { status: "error", lastError: err });
    return { status: "error", lastError: err };
  }

  const log = makeLogger(botId, record.name);
  const moderation = {
    enabled: record.moderation?.enabled !== false,
    autoRebuke: record.moderation?.autoRebuke !== false,
    cooldownMs: (record.moderation?.cooldownMinutes ?? 5) * 60 * 1000,
    keywords: Array.isArray(record.moderation?.keywords) ? record.moderation.keywords : [],
  };
  const memory = new MemoryStore({
    maxTurns: 12,
    ttlMs: 3 * 60 * 60 * 1000,
    persist: true,
    filePath: path.join(ROOT, "data", "memories", botId + ".json"),
    logger: log,
  });
  const audit = new GroupAuditLog({
    filePath: path.join(ROOT, "data", "audits", botId + ".json"),
    keepDays: 3,
    maxPerGroupPerDay: 2000,
    logger: log,
  });
  // 已处罚账本：被禁言过的言论（条目 id）不再重复处罚（保留 3 天，与审计账本同步过期）
  const punishedFile = path.join(ROOT, "data", "mutes", botId + ".json");
  const punishedMap = new Map(); // 条目id -> 处罚时间
  try {
    if (existsSync(punishedFile)) {
      const arr = JSON.parse(readFileSync(punishedFile, "utf8"));
      const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
      for (const item of arr ?? []) {
        if (item && item.id && item.ts >= cutoff) punishedMap.set(String(item.id), item.ts);
      }
    }
  } catch {}
  let punishedDirty = false;
  let punishedTimer = null;
  function savePunished() {
    if (!punishedDirty) return;
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const [id, ts] of punishedMap) if (ts < cutoff) punishedMap.delete(id);
    try {
      mkdirSync(path.dirname(punishedFile), { recursive: true });
      writeFileSync(punishedFile, JSON.stringify([...punishedMap].map(([id, ts]) => ({ id, ts }))), "utf8");
      punishedDirty = false;
    } catch (err) {
      log.warn("保存禁言去重记录失败：" + err?.message);
    }
  }
  function schedulePunishedSave() {
    if (punishedTimer) clearTimeout(punishedTimer);
    punishedTimer = setTimeout(() => savePunished(), 1500);
    punishedTimer.unref?.();
  }
  function markPunished(ids) {
    let changed = false;
    for (const id of ids) {
      if (id && !punishedMap.has(id)) {
        punishedMap.set(id, Date.now());
        changed = true;
      }
    }
    if (changed) {
      punishedDirty = true;
      schedulePunishedSave();
    }
  }
  function isPunished(id) {
    return Boolean(id) && punishedMap.has(id);
  }

  // 已检查账本：审查过的消息打标记，下次只查没查过的新消息（保留 3 天）
  const reviewedFile = path.join(ROOT, "data", "reviews", botId + ".json");
  const reviewedMap = new Map(); // 条目id -> 检查时间
  try {
    if (existsSync(reviewedFile)) {
      const arr = JSON.parse(readFileSync(reviewedFile, "utf8"));
      const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
      for (const item of arr ?? []) {
        if (item && item.id && item.ts >= cutoff) reviewedMap.set(String(item.id), item.ts);
      }
    }
  } catch {}
  let reviewedDirty = false;
  let reviewedTimer = null;
  function saveReviewed() {
    if (!reviewedDirty) return;
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const [id, ts] of reviewedMap) if (ts < cutoff) reviewedMap.delete(id);
    try {
      mkdirSync(path.dirname(reviewedFile), { recursive: true });
      writeFileSync(reviewedFile, JSON.stringify([...reviewedMap].map(([id, ts]) => ({ id, ts }))), "utf8");
      reviewedDirty = false;
    } catch (err) {
      log.warn("保存已检查记录失败：" + err?.message);
    }
  }
  function scheduleReviewedSave() {
    if (reviewedTimer) clearTimeout(reviewedTimer);
    reviewedTimer = setTimeout(() => saveReviewed(), 1500);
    reviewedTimer.unref?.();
  }
  function markReviewed(ids) {
    let changed = false;
    for (const id of ids) {
      if (id && !reviewedMap.has(id)) {
        reviewedMap.set(id, Date.now());
        changed = true;
      }
    }
    if (changed) {
      reviewedDirty = true;
      scheduleReviewedSave();
    }
  }
  function isReviewed(id) {
    return Boolean(id) && reviewedMap.has(id);
  }

  const llm = new LlmClient(record.llm ?? {}, log);
  const bot = new QQBot({ appId: record.qq.appId, appSecret: record.qq.appSecret, logger: log });
  const systemPrompt = buildSystemPrompt(record);
  const reviewSystemPrompt = buildReviewPrompt(record.rules && String(record.rules).trim());
  const autoMute = {
    enabled: record.moderation?.autoMute?.enabled === true,
    level: ["light", "medium", "heavy"].includes(record.moderation?.autoMute?.level)
      ? record.moderation.autoMute.level
      : "light",
    scanIntervalMinutes: (() => {
      const n = Number(record.moderation?.autoMute?.scanIntervalMinutes);
      return n >= 5 && n <= 1440 ? n : 10;
    })(),
  };
  function muteDurationMs(itemOrSerious) {
    const item = itemOrSerious && typeof itemOrSerious === "object" ? itemOrSerious : null;
    const isSerious = typeof itemOrSerious === "boolean" ? itemOrSerious : isSeriousViolation(itemOrSerious);
    const lv = MUTE_LEVELS[autoMute.level] ?? MUTE_LEVELS.light;
    const ruleMin = Number(item?.ruleMinutes);
    let minutes;
    if (Number.isFinite(ruleMin) && ruleMin > 0) {
      minutes = ruleMin * lv.multiplier; // 第一层：群规时长 × 第二层：档位倍率
    } else {
      minutes = (isSerious ? lv.seriousMs : lv.generalMs) / 60000; // 群规没写时长：按档位兜底
    }
    minutes = Math.max(1, Math.round(minutes));
    return Math.min(minutes * 60000, MAX_MUTE_MS);
  }
  function formatExpire(durationMs) {
    const d = new Date(Date.now() + durationMs + 8 * 3600 * 1000); // RFC3339，东八区
    return d.toISOString().slice(0, 19) + "+08:00";
  }
  async function muteMember(groupOpenid, memberOpenid, durationMs) {
    try {
      await bot.api.post(`/v2/groups/${groupOpenid}/restrict_chat_setting`, {
        members: [{ op: "add", member_openid: memberOpenid, mute_expire_at: formatExpire(durationMs) }],
      });
      return { ok: true, minutes: Math.round(durationMs / 60000) };
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 120);
      log.warn(`禁言失败（${memberOpenid}）：${msg}`);
      return { ok: false, reason: msg };
    }
  }
  function normalizeForMatch(s) {
    return String(s ?? "")
      .replace(/\s+/g, "")
      .replace(/[，。！？!?,.、:：;；"'""''【】\[\]()（）…—\-_]/g, "");
  }
  function findEntryByEvidence(entries, evidence) {
    const ev = normalizeForMatch(evidence);
    if (!ev) return null;
    for (const e of entries) {
      if (normalizeForMatch(e.content).includes(ev)) return e;
    }
    for (const e of entries) {
      const nc = normalizeForMatch(e.content);
      if (nc.length >= 10 && ev.includes(nc)) return e;
    }
    return null;
  }
  // 按人结清：该用户这批发言全部标记为已处罚，之后不再因这些言论重复禁言
  function markPunishedForUser(uid, reviewedEntries) {
    const ids = reviewedEntries
      .filter((e) => e.uid === uid && !isPunished(e.id))
      .map((e) => e.id);
    markPunished(ids);
  }

  const helpText = [
    `${record.name} · 指令列表`,
    "——————————",
    "/帮助   查看本说明",
    "/重置   清空和你的对话记忆",
    "/人格   查看当前人设",
    "/模型   查看当前 AI 模型",
    "/ping   检查机器人状态",
    "/查违规 审查今天群内消息并公示（仅群聊）",
    "/巡查   查看定时巡查状态（仅群聊）",
    "/群分析 结合人设与群规分析今日群聊，给出管理建议（仅群聊）",
    "提示：指令不带 / 也能用，直接发「查违规」即可",
  ].join("\n");

  const lastRebukeAt = new Map(); // groupId -> ts
  const lastMuteAt = new Map(); // `${groupId}:${uid}` -> ts（60 秒内同一人只禁言一次）
  function canMute(groupId, uid) {
    const key = groupId + ":" + uid;
    const now = Date.now();
    if (now - (lastMuteAt.get(key) ?? 0) < 60 * 1000) return false;
    lastMuteAt.set(key, now);
    return true;
  }
  const lastCheckAt = new Map(); // groupId -> ts

  // ---- 中间件 ----
  bot.use(errorHandler({ format: (err) => `⚠️ 处理消息时出错：${String(err?.message ?? err).slice(0, 120)}` }));
  const scanGroups = new Set();
  bot.use(async (ctx, next) => {
    const m = ctx.message;
    let recordedEntry = null;
    if (m.kind === "group" && m.groupOpenid) {
      scanGroups.add(m.groupOpenid);
      recordedEntry = audit.record(m.groupOpenid, {
        senderId: m.senderId,
        senderName: m.senderName,
        content: m.content,
        isAt: m.rawEventType === "GROUP_AT_MESSAGE_CREATE",
        isBot: m.senderIsBot,
      });
    }
    await next();
    // 关键词自动注意（仅针对未被 @ 的群消息，避免重复回复）
    const msg = ctx.message;
    if (msg.kind === "group" && msg.groupOpenid && !msg.senderIsBot) {
      if (ctx.state?.mention?.shouldAnswer) return;
      if (!matchPornKeywords(moderation, msg.content)) return;
      const now = Date.now();
      const last = lastRebukeAt.get(msg.groupOpenid) ?? 0;
      if (now - last < moderation.cooldownMs) return;
      lastRebukeAt.set(msg.groupOpenid, now);
      let notice = "";
      if (autoMute.enabled) {
        const r = await muteMember(msg.groupOpenid, msg.senderId, muteDurationMs(true));
        if (r.ok && recordedEntry?.id) markPunished([recordedEntry.id]);
        notice = r.ok ? "\n🔇 已禁言 " + r.minutes + " 分钟。" : "\n（禁言失败：" + String(r.reason).slice(0, 60) + "）";
      }
      await safeSend(bot, msg.replyTarget, REBUKES[Math.floor(Math.random() * REBUKES.length)] + notice);
    }
  });
  bot.use(messageFilter({ skipSelfEcho: true }));
  bot.use(rateLimiter({ perSender: { max: 8, windowMs: 60_000 }, global: { max: 120, windowMs: 60_000 } }));
  bot.use(mentionGate({ requireMentionInGroup: true }));
  bot.use(contentSanitizer({ stripBotMention: true, stripAllMentions: true, transform: (c) => c.replace(/<@[^>]*>/g, "") }));

  // ---- 事件 ----
  bot.on("ready", () => {
    running.set(botId, { ...running.get(botId), status: "running", lastError: "" });
    Bots.update(botId, { status: "running", lastError: "" });
    log.info("✅ 已连接 QQ 开放平台");
  });
  bot.on("resumed", () => {
    running.set(botId, { ...running.get(botId), status: "running", lastError: "" });
    Bots.update(botId, { status: "running", lastError: "" });
    log.info("✅ 连接已恢复（RESUME）");
  });
  bot.on("error", (err) => {
    const msg = String(err?.message ?? err).slice(0, 200);
    log.error("网关错误：" + msg);
    Bots.update(botId, { status: "error", lastError: msg });
  });

  bot.on("message", async (ctx, msg) => {
    const text = String(msg.content ?? "").trim().replace(/^(?:@[^\s@]+\s*)+/, "").trim();
    if (!text) return;
    const target = msg.replyTarget;
    const key = MemoryStore.sessionKey(target.scope, target.targetId, msg.senderId);

    // ---- 指令 ----
    const cmd = parseCommand(text);
    if (cmd && (await handleCommand(ctx, msg, cmd))) return;
    const bareWord = text.replace(/^[\/／]\s*/, "").toLowerCase();
    if (BARE_COMMAND_WORDS.has(bareWord) && !/\s/.test(bareWord)) {
      if (await handleCommand(ctx, msg, { name: bareWord, args: "" })) return;
    }
    if (/^[\/／]/.test(text)) {
      await safeSend(bot, target, "❓ 未知指令「" + text.slice(0, 24) + "」。发送 /帮助 查看全部指令。");
      return;
    }

    // ---- 特殊词语法 ----
    const hit = matchSpecialWord(record, text);
    let aiPrompt = "";
    if (hit) {
      if (hit.action === "reply" && String(hit.reply ?? "").trim()) {
        await safeSend(bot, target, String(hit.reply).trim());
        return;
      }
      if (hit.action === "ignore") return;
      if (hit.action === "ai" && String(hit.prompt ?? "").trim()) {
        aiPrompt = String(hit.prompt).trim(); // 交给 AI：提示词参与判断，AI 自行回答
      }
    }

    // ---- AI 回答 ----
    const history = memory.get(key);
    const messages = [{ role: "system", content: systemPrompt }];
    if (aiPrompt) messages.push({ role: "system", content: "【本轮特殊指令】" + aiPrompt });
    messages.push(...history, { role: "user", content: text });

    if (target.scope === "c2c") {
      try { await bot.sendTyping(target, 60); } catch {}
    }
    let reply;
    try {
      reply = await llm.chat(messages, { signal: ctx.signal });
    } catch (err) {
      log.error("AI 调用失败：" + err?.message);
      await safeSend(bot, target, "AI 服务暂时不可用，请稍后再试。");
      return;
    }
    reply = toPlainText(reply);
    if (!reply) return;
    memory.push(key, "user", text);
    memory.push(key, "assistant", reply);
    for (const chunk of splitLongText(reply, 2000)) {
      if (ctx.signal?.aborted) break;
      await safeSend(bot, target, chunk);
    }
  });

  // ---- 指令处理 ----
  async function handleCommand(ctx, msg, cmd) {
    const { name } = cmd;
    switch (name) {
      case "help":
      case "帮助":
      case "菜单": {
        await safeSend(bot, msg.replyTarget, helpText);
        return true;
      }
      case "reset":
      case "重置":
      case "清空": {
        const k = MemoryStore.sessionKey(msg.replyTarget.scope, msg.replyTarget.targetId, msg.senderId);
        memory.clear(k);
        await safeSend(bot, msg.replyTarget, "🧹 已清空我们之间的对话记忆。");
        return true;
      }
      case "persona":
      case "人格":
      case "人设": {
        const snippet = systemPrompt.length > 600 ? systemPrompt.slice(0, 600) + "\n……" : systemPrompt;
        await safeSend(bot, msg.replyTarget, "🎭 当前人设与规定：\n" + snippet);
        return true;
      }
      case "model":
      case "模型": {
        await safeSend(bot, msg.replyTarget, `🧠 当前 AI 模型：${record.llm?.model ?? "未配置"}（${record.llm?.baseUrl ?? ""}）`);
        return true;
      }
      case "ping": {
        await safeSend(bot, msg.replyTarget, "🟢 机器人运行正常！");
        return true;
      }
      case "xuncha":
      case "巡查":
      case "巡查状态": {
        await runScanStatus(ctx, msg);
        return true;
      }
      case "check":
      case "查违规":
      case "违规检查":
      case "群规检查":
      case "公示": {
        await runAuditCheck(ctx, msg);
        return true;
      }
      case "analysis":
      case "分析":
      case "群分析":
      case "建议":
      case "群建议": {
        await runGroupAnalysis(ctx, msg);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- /查违规 ----
  async function runAuditCheck(ctx, msg) {
    const target = msg.replyTarget;
    if (target.scope !== "group") {
      await safeSend(bot, target, "这个指令只能在群里使用。");
      return;
    }
    const groupId = target.targetId;
    const now = Date.now();
    const last = lastCheckAt.get(groupId) ?? 0;
    if (now - last < 2 * 60 * 1000) {
      await safeSend(bot, target, "别催啦，审查也要时间的～ 2 分钟后再来。");
      return;
    }
    lastCheckAt.set(groupId, now);

    const allEntries = audit.getToday(groupId);
    if (allEntries.length === 0) {
      await safeSend(bot, target, "📋 今天还没有收到任何群消息记录。\n（注：未开通全量消息时只能看到 @机器人 的消息）");
      return;
    }
    // 只检查尚未检查过的新消息
    const unchecked = allEntries.filter((e) => !isReviewed(e.id));
    if (unchecked.length === 0) {
      await safeSend(bot, target, "📋 今天没有新消息需要检查，之前的都已检查过了。");
      return;
    }
    const recent = unchecked.slice(-400);
    const recordText = recent.map((e) => `[${e.t}] ${e.user}: ${e.content}`).join("\n");
    await safeSend(bot, target, `🔍 正在检查 ${recent.length} 条新消息（今日已收录 ${allEntries.length} 条），稍等…`);

    let verdict;
    let parsedVerdict = null;
    try {
      verdict = await llm.chat(
        [
          { role: "system", content: reviewSystemPrompt },
          { role: "user", content: `以下是群聊中尚未检查过的消息记录（${recent.length} 条）：\n${recordText}` },
        ],
        { signal: ctx.signal },
      );
      const rawV = String(verdict ?? "").trim();
      const jm = rawV.match(/\{[\s\S]*\}/);
      if (jm) {
        try { parsedVerdict = JSON.parse(jm[0]); } catch {}
      }
    } catch (err) {
      log.error("群规审查失败：" + err?.message);
      await safeSend(bot, target, "审查服务出错了，请稍后再试。");
      return;
    }

    // 本次检查过的消息全部标记，下次不再重复检查
    markReviewed(recent.map((e) => e.id));

    // 自动禁言：按力度对本次新发现的违规者执行
    const muteResults = [];
    if (autoMute.enabled && parsedVerdict && Array.isArray(parsedVerdict.violations) && parsedVerdict.violations.length > 0) {
      const muted = new Map(); // uid -> { durMs, ids }（同一人取最长，记录涉及的条目）
      for (const item of parsedVerdict.violations) {
        const entry = findEntryByEvidence(recent, item?.evidence);
        if (!entry || !entry.uid) continue;
        if (isPunished(entry.id)) continue; // 该条言论已被处罚过，不再重复禁言
        const durMs = muteDurationMs(item);
        if (durMs <= 0) continue;
        const prev = muted.get(entry.uid);
        if (prev === undefined || durMs > prev.durMs) muted.set(entry.uid, { durMs, ids: [entry.id] });
        else prev.ids.push(entry.id);
      }
      for (const [uid, info] of muted) {
        if (!canMute(groupId, uid)) continue; // 60 秒冷却，防并发重复
        const r = await muteMember(groupId, uid, info.durMs);
        if (r.ok) markPunishedForUser(uid, recent); // 本次该人的发言结清
        muteResults.push({ uid, durMs: info.durMs, ...r });
      }
    }
    const report = renderReport(verdict, recent.length, groupId, muteResults, recent);
    for (const chunk of splitLongText(report, 2000)) {
      if (ctx.signal?.aborted) break;
      await safeSend(bot, target, chunk);
    }
  }

  function renderReport(verdictText, totalCount, groupId, muteResults = [], entries = []) {
    let parsed = null;
    const raw = String(verdictText ?? "").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch {}
    }
    const time = new Date().toLocaleString("zh-CN", { hour12: false });
    const lines = [];
    lines.push("📋 今日群规检查报告");
    lines.push(`⏱ 检查时间：${time}　本次检查新消息：${totalCount} 条`);
    lines.push("——————————");
    if (parsed && Array.isArray(parsed.violations)) {
      const v = parsed.violations;
      if (v.length === 0) {
        lines.push("✅ 未发现违规内容，群风良好～");
      } else {
        lines.push(`⚠️ 发现 ${v.length} 条疑似违规：`);
        v.forEach((item, i) => {
          lines.push(`${i + 1}.【${item?.type ?? "违规"}·${item?.severity ?? "中"}】${item?.user ?? "未知"}：「${item?.evidence ?? ""}」`);
        });
        if (parsed.summary) lines.push(`💬 总结：${parsed.summary}`);
      }
    } else {
      lines.push(raw.slice(0, 1500) || "（审查结果为空）");
    }
    if (muteResults.length > 0) {
      lines.push("——————————");
      lines.push("🔇 禁言执行结果：");
      for (const m of muteResults) {
        const user = entries.find((e) => e.uid === m.uid)?.user ?? "未知成员";
        if (m.ok) {
          lines.push(`  · ${user}：禁言 ${Math.round(m.durMs / 60000)} 分钟 ✅`);
        } else {
          lines.push(`  · ${user}：禁言失败（${String(m.reason).slice(0, 60)}）`);
        }
      }
    }
    if (audit.todayAllAt(groupId)) {
      lines.push("——————————");
      lines.push("⚠️ 提示：今天只收到了 @机器人 的消息记录。想监控全群，请在手机 QQ 群设置里开启「获取群内全部消息」。");
    }
    return lines.join("\n");
  }

  // ---- 主动检查：每隔 scanIntervalMinutes 分钟审查最近消息，自动禁言新违规者 ----
  let lastScanAt = 0;
  let scanTimer = null;
  async function runActiveScan() {
    const now = Date.now();
    lastScanAt = now;
    for (const groupId of scanGroups) {
      // 审查所有"未检查"的消息（不限时间窗口，积压的旧消息也会被清掉），最多 400 条
      const entries = audit.getToday(groupId).filter((e) => !isReviewed(e.id)).slice(-400);
      if (entries.length < 1) continue;
      log.info(`定时巡查：${groupId} 本次检查 ${entries.length} 条未审消息`);
      const recordText = entries.map((e) => `[${e.t}] ${e.user}: ${e.content}`).join("\n");
      let parsed = null;
      try {
        const verdict = await llm.chat(
          [
            { role: "system", content: reviewSystemPrompt },
            { role: "user", content: `以下是最近一段时间的群聊消息记录（${entries.length} 条）：\n${recordText}` },
          ],
          {},
        );
        const jm = String(verdict ?? "").match(/\{[\s\S]*\}/);
        if (jm) parsed = JSON.parse(jm[0]);
      } catch {
        continue; // 审查出错：不标记、不报，下次重试
      }
      if (!parsed || !Array.isArray(parsed.violations)) {
        continue; // 审查结果异常：不标记、不报，下次重试
      }
      // 无违规：也要报平安
      if (parsed.violations.length === 0) {
        markReviewed(entries.map((e) => e.id));
        await safeSend(
          bot,
          { scope: "group", targetId: groupId },
          `🔍 定时巡查报告\n本次检查：${entries.length} 条新消息\n结果：未发现违规，群风良好 ✅`,
        );
        continue;
      }
      const muted = new Map();
      for (const item of parsed.violations) {
        const entry = findEntryByEvidence(entries, item?.evidence);
        if (!entry || !entry.uid) continue;
        const durMs = muteDurationMs(item);
        if (durMs <= 0) continue;
        const prev = muted.get(entry.uid);
        if (prev === undefined || durMs > prev.durMs) muted.set(entry.uid, { durMs, ids: [entry.id] });
        else prev.ids.push(entry.id);
      }
      const results = [];
      for (const [uid, info] of muted) {
        if (!canMute(groupId, uid)) continue;
        const r = await muteMember(groupId, uid, info.durMs);
        if (r.ok) {
          markPunishedForUser(uid, entries);
          log.info(`定时巡查：已禁言 ${uid} ${Math.round(info.durMs / 60000)} 分钟`);
        } else {
          log.warn(`定时巡查禁言失败：${String(r.reason).slice(0, 100)}`);
        }
        results.push({ uid, durMs: info.durMs, ...r });
      }
      markReviewed(entries.map((e) => e.id)); // 本次扫描过的消息标记已检查
      // 每次巡查都报一次结果（有违规）
      const lines = ["🔍 定时巡查报告"];
      lines.push(`本次检查：${entries.length} 条新消息`);
      lines.push(`发现 ${parsed.violations.length} 条疑似违规：`);
      parsed.violations.forEach((item, i) => {
        lines.push(`${i + 1}.【${item?.type ?? "违规"}·${item?.severity ?? "中"}】${item?.user ?? "未知"}：「${String(item?.evidence ?? "").slice(0, 30)}」`);
      });
      if (results.length > 0) {
        lines.push("禁言执行：");
        for (const r of results) {
          const name = entries.find((e) => e.uid === r.uid)?.user ?? "未知成员";
          lines.push(r.ok
            ? `· ${name}：已禁言 ${Math.round(r.durMs / 60000)} 分钟`
            : `· ${name}：禁言失败（${String(r.reason).slice(0, 40)}）`);
        }
      }
      await safeSend(bot, { scope: "group", targetId: groupId }, lines.join("\n"));
    }
  }
  if (autoMute.enabled && autoMute.scanIntervalMinutes >= 5) {
    scanTimer = setInterval(
      () => { void runActiveScan().catch((e) => log.warn("定时巡查出错：" + e?.message)); },
      autoMute.scanIntervalMinutes * 60 * 1000,
    );
    scanTimer.unref?.();
    log.info(`定时巡查已开启：每 ${autoMute.scanIntervalMinutes} 分钟审查一次最近消息`);
  }

  // ---- /巡查：查看定时巡查状态 ----
  async function runScanStatus(ctx, msg) {
    const target = msg.replyTarget;
    if (target.scope !== "group") {
      await safeSend(bot, target, "这个指令只能在群里使用。");
      return;
    }
    const groupId = target.targetId;
    const today = audit.getToday(groupId);
    const checked = today.filter((e) => isReviewed(e.id)).length;
    const punished = today.filter((e) => isPunished(e.id)).length;
    const lines = [
      "🔍 定时巡查状态",
      `开关：${autoMute.enabled ? "已开启" : "未开启"}`,
      `间隔：每 ${autoMute.scanIntervalMinutes} 分钟`,
      `今日收录消息：${today.length} 条`,
      `已检查：${checked} 条（剩余未检查 ${today.length - checked} 条）`,
      `已禁言处理：${punished} 条`,
      `上次巡查：${lastScanAt ? new Date(lastScanAt).toLocaleString("zh-CN", { hour12: false }) : "尚未执行"}`,
    ];
    await safeSend(bot, target, lines.join("\n"));
  }

  // ---- /群分析：结合人设与规定（知识库）分析今日群聊并给出建议 ----
  const lastAnalysisAt = new Map(); // groupId -> ts
  async function runGroupAnalysis(ctx, msg) {
    const target = msg.replyTarget;
    if (target.scope !== "group") {
      await safeSend(bot, target, "这个指令只能在群里使用。");
      return;
    }
    const groupId = target.targetId;
    const now = Date.now();
    if (now - (lastAnalysisAt.get(groupId) ?? 0) < 2 * 60 * 1000) {
      await safeSend(bot, target, "分析也要时间的～ 2 分钟后再来。");
      return;
    }
    lastAnalysisAt.set(groupId, now);

    const entries = audit.getToday(groupId);
    if (entries.length === 0) {
      await safeSend(bot, target, "📋 今天还没有收到任何群消息记录，没法分析。");
      return;
    }
    const recent = entries.slice(-400);
    const recordText = recent.map((e) => `[${e.t}] ${e.user}: ${e.content}`).join("\n");
    await safeSend(bot, target, `🧠 正在结合人设与群规分析今天的 ${entries.length} 条消息，稍等…`);

    const ANALYSIS_TASK = [
      "请阅读今天的群聊记录，结合你的「人设」与「机器人规定」（这是你的知识库），输出一份《今日群况分析与建议》：",
      "1. 群活跃度与主要话题",
      "2. 群风与氛围评价",
      "3. 潜在风险与违规苗头",
      "4. 结合群规给出 3~5 条具体、可执行的管理建议",
      "要求：语气与你的角色一致；分点简洁；建议必须贴合本群的「机器人规定」，不要泛泛而谈；输出请使用纯文本，不要用 Markdown 格式。",
    ].join("\n");

    let reply;
    try {
      reply = await llm.chat(
        [
          { role: "system", content: systemPrompt + "\n\n## 当前任务：群聊分析\n" + ANALYSIS_TASK },
          { role: "user", content: `以下是今天的群聊消息记录（${recent.length} 条）：\n${recordText}` },
        ],
        { signal: ctx.signal },
      );
    } catch (err) {
      log.error("群分析失败：" + err?.message);
      await safeSend(bot, target, "分析服务出错了，请稍后再试。");
      return;
    }
    const textOut = toPlainText(reply);
    if (!textOut) {
      await safeSend(bot, target, "没分析出内容，换个时间再试试。");
      return;
    }
    for (const chunk of splitLongText(textOut, 2000)) {
      if (ctx.signal?.aborted) break;
      await safeSend(bot, target, chunk);
    }
  }

  running.set(botId, { instance: bot, memory, llm, audit, scanTimer, savePunished, saveReviewed, status: "starting", lastError: "" });
  Bots.update(botId, { status: "starting", lastError: "" });

  bot.start().catch((err) => {
    const msg = String(err?.message ?? err).slice(0, 200);
    running.set(botId, { ...running.get(botId), status: "error", lastError: msg });
    Bots.update(botId, { status: "error", lastError: msg });
    log.error("启动失败：" + msg);
  });

  return { status: "starting", lastError: "" };
}

export async function stopBot(botId) {
  const entry = running.get(botId);
  if (!entry) {
    Bots.update(botId, { status: "stopped", lastError: "" });
    return { status: "stopped" };
  }
  try { entry.instance?.stop(); } catch {}
  if (entry.scanTimer) clearInterval(entry.scanTimer);
  entry.memory?.flush();
  entry.audit?.flush();
  entry.savePunished?.();
  entry.saveReviewed?.();
  running.delete(botId);
  Bots.update(botId, { status: "stopped", lastError: "" });
  return { status: "stopped" };
}

export function getStatus(botId) {
  return running.has(botId) ? running.get(botId).status : "stopped";
}

export function runningCount() {
  return running.size;
}

/** 停止所有运行中的机器人（用于服务退出时统一落盘） */
export async function stopAllBots() {
  const ids = [...running.keys()];
  for (const id of ids) {
    await stopBot(id);
  }
}
