/**
 * QQ 机器人托管平台 - 后端 API（付费版 v0.8）
 * 新增：验证码、密码强度校验、密保找回、邀请码注册、会员计划（免费/月卡/买断）、后台管理系统
 */
import express from "express";
import https from "node:https";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Users, Bots, Sessions, Invites, RedeemCodes, Settings, PLANS,
  hashPassword, verifyPassword, genId,
} from "./store.js";
import { startBot, stopBot, runningCount, defaultBotRecord } from "./bot-runner.js";
import { generateCaptcha, verifyCaptcha } from "./captcha.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

// ---------------- 鉴权 ----------------
function auth(req, res, next) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = token ? Sessions.find(token) : null;
  const user = session ? Users.findById(session.user_id) : null;
  if (!session || !user) return res.status(401).json({ error: "未登录或登录已过期" });
  if (user.status !== "active") return res.status(403).json({ error: "账号已被禁用，请联系管理员" });
  req.user = user;
  req.token = token;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "需要管理员权限" });
  next();
}
function ownBot(req, res, next) {
  const bot = Bots.find(req.params.id);
  if (!bot) return res.status(404).json({ error: "机器人不存在" });
  if (bot.ownerId !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "无权操作该机器人" });
  req.bot = bot;
  next();
}

function passwordStrength(pw) {
  const s = String(pw ?? "");
  if (s.length < 8 || s.length > 64) return "密码需 8~64 位";
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return "密码需同时包含字母和数字";
  return null;
}

function effectivePlan(user) {
  if (user.plan === "monthly" && user.plan_expires_at < Date.now()) return PLANS.free;
  return PLANS[user.plan] ?? PLANS.free;
}

// ---------------- 验证码 ----------------
app.get("/api/captcha", (req, res) => res.json(generateCaptcha()));

// ---------------- 用户 ----------------
app.post("/api/register", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const captchaId = String(req.body?.captchaId ?? "");
  const captchaCode = String(req.body?.captchaCode ?? "");
  const inviteCode = String(req.body?.inviteCode ?? "").trim().toUpperCase();
  const securityQuestion = String(req.body?.securityQuestion ?? "").trim();
  const securityAnswer = String(req.body?.securityAnswer ?? "").trim();

  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) return res.status(400).json({ error: "用户名需为 2~20 位字母/数字/中文/下划线" });
  const pwErr = passwordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!verifyCaptcha(captchaId, captchaCode)) return res.status(400).json({ error: "验证码错误或已过期" });
  if (Users.findByUsername(username)) return res.status(409).json({ error: "用户名已存在" });

  const userCount = Users.count();
  const requireInvite = userCount > 0 && Settings.get("require_invite") === "1";
  let inviteToConsume = null;
  if (userCount > 0 && (requireInvite || inviteCode)) {
    const invite = Invites.find(inviteCode);
    if (!invite || !invite.enabled || invite.used_at > 0) return res.status(400).json({ error: "邀请码无效或已被使用" });
    inviteToConsume = invite.code;
  }
  if (securityQuestion.length < 2) return res.status(400).json({ error: "请设置密保问题" });
  if (securityAnswer.length < 2) return res.status(400).json({ error: "请设置密保答案" });

  const isFirstUser = userCount === 0;
  const user = Users.create({
    id: genId(), username, passwordHash: hashPassword(password), createdAt: Date.now(),
    role: isFirstUser ? "admin" : "user", status: "active", plan: "free", planExpiresAt: 0,
    securityQuestion, securityAnswerHash: hashPassword(securityAnswer),
  });
  if (inviteToConsume) Invites.consume(inviteToConsume, user.id);
  const token = Sessions.create(user.id);
  res.json({ token, username: user.username, role: user.role });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const captchaId = String(req.body?.captchaId ?? "");
  const captchaCode = String(req.body?.captchaCode ?? "");
  if (!verifyCaptcha(captchaId, captchaCode)) return res.status(400).json({ error: "验证码错误或已过期" });
  const user = Users.findByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "用户名或密码错误" });
  if (user.status !== "active") return res.status(403).json({ error: "账号已被禁用，请联系管理员" });
  const token = Sessions.create(user.id);
  res.json({ token, username: user.username, role: user.role });
});

// ---------------- 找回密码（密保） ----------------
app.post("/api/forgot/question", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const user = Users.findByUsername(username);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (!user.security_question) return res.status(400).json({ error: "该账号未设置密保问题" });
  res.json({ question: user.security_question });
});

app.post("/api/forgot/reset", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const answer = String(req.body?.answer ?? "").trim();
  const newPassword = String(req.body?.newPassword ?? "");
  const user = Users.findByUsername(username);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (!verifyPassword(answer, user.security_answer_hash)) return res.status(400).json({ error: "密保答案错误" });
  const pwErr = passwordStrength(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  Users.setPassword(user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

app.post("/api/logout", auth, (req, res) => { Sessions.remove(req.token); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, plan: req.user.plan, planExpiresAt: req.user.plan_expires_at });
});

// ---------------- 机器人 CRUD ----------------
function sanitizeBot(b) {
  return {
    id: b.id, ownerId: b.ownerId, name: b.name, enabled: b.enabled, status: b.status, lastError: b.lastError,
    qq: { appId: b.appId, hasSecret: Boolean(b.appSecretEnc) },
    llm: { baseUrl: b.baseUrl, model: b.model, temperature: b.temperature, hasKey: Boolean(b.apiKeyEnc) },
    persona: b.persona, rules: b.rules, specialWords: b.specialWords, moderation: b.moderation,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}

app.get("/api/bots", auth, (req, res) => res.json(Bots.listByOwner(req.user.id).map(sanitizeBot)));

app.post("/api/bots", auth, (req, res) => {
  const plan = effectivePlan(req.user);
  const owned = Bots.countByOwner(req.user.id);
  if (owned >= plan.botQuota) {
    return res.status(403).json({ error: `当前${plan.name}最多创建 ${plan.botQuota} 个机器人，升级会员可增加配额` });
  }
  const name = String(req.body?.name ?? "").trim() || "我的机器人";
  const record = defaultBotRecord(req.user.id, name);
  record.id = genId();
  record.qq = { appId: String(req.body?.qq?.appId ?? "").trim(), appSecret: String(req.body?.qq?.appSecret ?? "").trim() };
  record.llm = { ...record.llm, ...(req.body?.llm ?? {}), baseUrl: String(req.body?.llm?.baseUrl ?? record.llm.baseUrl).trim(), apiKey: String(req.body?.llm?.apiKey ?? "").trim(), model: String(req.body?.llm?.model ?? record.llm.model).trim() };
  if (req.body?.persona !== undefined) record.persona = String(req.body.persona);
  if (req.body?.rules !== undefined) record.rules = String(req.body.rules);
  if (Array.isArray(req.body?.specialWords)) {
    record.specialWords = req.body.specialWords.filter((w) => w && String(w.word ?? "").trim()).map((w) => ({ word: String(w.word).trim(), action: ["reply", "ai", "ignore"].includes(w.action) ? w.action : "reply", reply: String(w.reply ?? ""), prompt: String(w.prompt ?? "") }));
  }
  if (req.body?.moderation) {
    record.moderation = {
      enabled: req.body.moderation.enabled !== false,
      autoRebuke: req.body.moderation.autoRebuke !== false,
      cooldownMinutes: 5,
      keywords: Array.isArray(req.body.moderation.keywords) ? req.body.moderation.keywords.filter((k) => String(k).trim()).map((k) => String(k).trim()) : [],
      autoMute: {
        enabled: req.body.moderation.autoMute?.enabled === true,
        level: ["light", "medium", "heavy"].includes(req.body.moderation.autoMute?.level) ? req.body.moderation.autoMute.level : "light",
        scanIntervalMinutes: (() => { const n = Number(req.body.moderation.autoMute?.scanIntervalMinutes); return n >= 5 && n <= 1440 ? n : 10; })(),
      },
    };
  }
  res.json(sanitizeBot(Bots.create(record)));
});

app.put("/api/bots/:id", auth, ownBot, (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || "我的机器人";
  if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
  const qqPatch = {};
  if (req.body?.qq?.appId !== undefined) qqPatch.appId = String(req.body.qq.appId).trim();
  if (req.body?.qq?.appSecret) qqPatch.appSecret = String(req.body.qq.appSecret).trim();
  if (Object.keys(qqPatch).length) patch.qq = qqPatch;
  const llmPatch = {};
  if (req.body?.llm?.baseUrl) llmPatch.baseUrl = String(req.body.llm.baseUrl).trim();
  if (req.body?.llm?.apiKey) llmPatch.apiKey = String(req.body.llm.apiKey).trim();
  if (req.body?.llm?.model) llmPatch.model = String(req.body.llm.model).trim();
  if (req.body?.llm?.temperature !== undefined) llmPatch.temperature = Number(req.body.llm.temperature) || 0.7;
  if (Object.keys(llmPatch).length) patch.llm = llmPatch;
  if (req.body?.persona !== undefined) patch.persona = String(req.body.persona);
  if (req.body?.rules !== undefined) patch.rules = String(req.body.rules);
  if (Array.isArray(req.body?.specialWords)) {
    patch.specialWords = req.body.specialWords.filter((w) => w && String(w.word ?? "").trim()).map((w) => ({ word: String(w.word).trim(), action: ["reply", "ai", "ignore"].includes(w.action) ? w.action : "reply", reply: String(w.reply ?? ""), prompt: String(w.prompt ?? "") }));
  }
  if (req.body?.moderation) {
    patch.moderation = {
      enabled: req.body.moderation.enabled !== false,
      autoRebuke: req.body.moderation.autoRebuke !== false,
      cooldownMinutes: 5,
      keywords: Array.isArray(req.body.moderation.keywords) ? req.body.moderation.keywords.filter((k) => String(k).trim()).map((k) => String(k).trim()) : [],
      autoMute: {
        enabled: req.body.moderation.autoMute?.enabled === true,
        level: ["light", "medium", "heavy"].includes(req.body.moderation.autoMute?.level) ? req.body.moderation.autoMute.level : "light",
        scanIntervalMinutes: (() => { const n = Number(req.body.moderation.autoMute?.scanIntervalMinutes); return n >= 5 && n <= 1440 ? n : 10; })(),
      },
    };
  }
  res.json(sanitizeBot(Bots.update(req.params.id, patch)));
});

app.delete("/api/bots/:id", auth, ownBot, async (req, res) => {
  await stopBot(req.params.id);
  Bots.remove(req.params.id);
  res.json({ ok: true });
});

app.post("/api/bots/:id/start", auth, ownBot, async (req, res) => {
  try { res.json(await startBot(req.params.id)); } catch (err) { res.status(500).json({ error: String(err?.message ?? err) }); }
});
app.post("/api/bots/:id/stop", auth, ownBot, async (req, res) => { res.json(await stopBot(req.params.id)); });

// ---------------- 后台管理（仅管理员） ----------------
app.get("/api/admin/stats", auth, adminOnly, (req, res) => {
  const running = Bots.all().filter((b) => b.status === "running" || b.status === "starting").length;
  const unusedInvites = Invites.listAll().filter((i) => i.enabled && !i.used_at).length;
  res.json({ users: Users.count(), bots: Bots.count(), runningBots: running, unusedInvites });
});

app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  res.json(Users.listAll().map((u) => ({
    id: u.id, username: u.username, role: u.role, status: u.status, plan: u.plan,
    planExpiresAt: u.plan_expires_at, createdAt: u.created_at,
    botCount: Bots.countByOwner(u.id),
  })));
});

app.get("/api/admin/bots", auth, adminOnly, (req, res) => {
  res.json(Bots.all().map((b) => {
    const owner = Users.findById(b.ownerId);
    return { ...sanitizeBot(b), ownerName: owner?.username ?? "未知", ownerId: b.ownerId };
  }));
});

app.post("/api/admin/users/:id/plan", auth, adminOnly, (req, res) => {
  const plan = String(req.body?.plan ?? "");
  if (!PLANS[plan]) return res.status(400).json({ error: "无效的计划" });
  let expiresAt = 0;
  if (plan === "monthly") {
    const days = Number(req.body?.days ?? 30) || 30;
    expiresAt = Date.now() + days * 24 * 3600 * 1000;
  }
  Users.setPlan(req.params.id, plan, expiresAt);
  res.json({ ok: true, plan, expiresAt });
});

app.post("/api/admin/users/:id/status", auth, adminOnly, (req, res) => {
  Users.updateStatus(req.params.id, req.body?.status === "disabled" ? "disabled" : "active");
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/role", auth, adminOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "不能修改自己的角色" });
  Users.updateRole(req.params.id, req.body?.role === "admin" ? "admin" : "user");
  res.json({ ok: true });
});

app.get("/api/admin/invites", auth, adminOnly, (req, res) => {
  res.json(Invites.listAll().map((i) => ({ ...i, usedByName: i.used_by ? (Users.findById(i.used_by)?.username ?? "") : "" })));
});
app.post("/api/admin/invites", auth, adminOnly, (req, res) => {
  const count = Math.min(50, Math.max(1, Number(req.body?.count ?? 1) || 1));
  const note = String(req.body?.note ?? "").trim();
  const created = [];
  for (let i = 0; i < count; i++) {
    const code = "P" + crypto.randomBytes(4).toString("hex").toUpperCase();
    Invites.create(code, note);
    created.push(code);
  }
  res.json({ created });
});
app.post("/api/admin/invites/:code/toggle", auth, adminOnly, (req, res) => {
  const inv = Invites.find(req.params.code);
  if (!inv) return res.status(404).json({ error: "邀请码不存在" });
  Invites.setEnabled(req.params.code, inv.enabled ? 0 : 1);
  res.json({ ok: true });
});
app.delete("/api/admin/invites/:code", auth, adminOnly, (req, res) => { Invites.delete(req.params.code); res.json({ ok: true }); });

app.get("/api/info", auth, (req, res) => res.json({ runningBots: runningCount(), version: "0.8.0" }));

// ---------------- 账号设置：改用户名 / 改密码 / 改密保 ----------------
app.post("/api/change-username", auth, (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) return res.status(400).json({ error: "用户名需为 2~20 位字母/数字/中文/下划线" });
  if (Users.findByUsername(username)) return res.status(409).json({ error: "用户名已被占用" });
  Users.updateUsername(req.user.id, username);
  res.json({ ok: true, username });
});

app.post("/api/change-security", auth, (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  const answer = String(req.body?.answer ?? "").trim();
  if (question.length < 2) return res.status(400).json({ error: "请设置密保问题" });
  if (answer.length < 2) return res.status(400).json({ error: "请设置密保答案" });
  Users.setSecurity(req.user.id, question, hashPassword(answer));
  res.json({ ok: true });
});

// ---------------- 修改密码 ----------------
app.post("/api/change-password", auth, (req, res) => {
  const oldPassword = String(req.body?.oldPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!verifyPassword(oldPassword, req.user.password_hash)) return res.status(400).json({ error: "原密码错误" });
  const pwErr = passwordStrength(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  Users.setPassword(req.user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

// ---------------- 系统设置（邀请码开关） ----------------
app.get("/api/settings/public", (req, res) => res.json({ requireInvite: Settings.get("require_invite") === "1" }));
app.get("/api/admin/settings", auth, adminOnly, (req, res) => res.json({ requireInvite: Settings.get("require_invite") === "1" }));
app.post("/api/admin/settings", auth, adminOnly, (req, res) => {
  Settings.set("require_invite", req.body?.requireInvite ? "1" : "0");
  res.json({ ok: true });
});

// ---------------- 充值卡密（用户自助开通会员） ----------------
app.post("/api/redeem", auth, (req, res) => {
  const code = String(req.body?.code ?? "").trim().toUpperCase();
  const rc = RedeemCodes.find(code);
  if (!rc || !rc.enabled || rc.used_at > 0) return res.status(400).json({ error: "卡密无效或已被使用" });
  let plan = rc.type;
  let expiresAt = 0;
  if (rc.type === "monthly") {
    const base = Math.max(Number(req.user.plan_expires_at) || 0, Date.now());
    expiresAt = base + Number(rc.days || 30) * 24 * 3600 * 1000;
  } else if (rc.type === "lifetime") {
    plan = "lifetime";
  }
  Users.setPlan(req.user.id, plan, expiresAt);
  RedeemCodes.consume(code, req.user.id);
  res.json({ ok: true, plan, expiresAt });
});

// ---------------- 后台：卡密管理 ----------------
app.get("/api/admin/redeems", auth, adminOnly, (req, res) => {
  res.json(RedeemCodes.listAll().map((r) => ({ ...r, usedByName: r.used_by ? (Users.findById(r.used_by)?.username ?? "") : "" })));
});
app.post("/api/admin/redeems", auth, adminOnly, (req, res) => {
  const count = Math.min(50, Math.max(1, Number(req.body?.count ?? 1) || 1));
  const type = req.body?.type === "lifetime" ? "lifetime" : "monthly";
  const days = Number(req.body?.days ?? 30) || 30;
  const created = [];
  for (let i = 0; i < count; i++) {
    const code = "R" + crypto.randomBytes(4).toString("hex").toUpperCase();
    RedeemCodes.create(code, type, days);
    created.push(code);
  }
  res.json({ created });
});
app.post("/api/admin/redeems/:code/toggle", auth, adminOnly, (req, res) => {
  const rc = RedeemCodes.find(req.params.code);
  if (!rc) return res.status(404).json({ error: "卡密不存在" });
  RedeemCodes.setEnabled(req.params.code, rc.enabled ? 0 : 1);
  res.json({ ok: true });
});
app.delete("/api/admin/redeems/:code", auth, adminOnly, (req, res) => { RedeemCodes.delete(req.params.code); res.json({ ok: true }); });

// ---------------- 管理员引导 ----------------
function ensureAdmin() {
  mkdirSync(path.join(ROOT, "data"), { recursive: true });
  if (Users.countAdmin() > 0) return;
  const username = "admin";
  const password = crypto.randomBytes(6).toString("hex");
  const existing = Users.findByUsername(username);
  const pwHash = hashPassword(password);
  if (existing) {
    Users.setPassword(existing.id, pwHash);
    Users.updateRole(existing.id, "admin");
  } else {
    Users.create({ id: genId(), username, passwordHash: pwHash, createdAt: Date.now(), role: "admin", status: "active", plan: "lifetime", planExpiresAt: 0, securityQuestion: "", securityAnswerHash: "" });
  }
  const msg = `管理员账号已创建/重置：用户名 admin，初始密码 ${password}（登录后请在「修改密码」中更换；可在日志中查看）`;
  console.log("⚠️ " + msg);
}
ensureAdmin();

// ---------------- 优雅关闭 ----------------
const ADMIN_KEY_FILE = path.join(ROOT, "data", "admin.key");
function loadAdminKey() {
  if (existsSync(ADMIN_KEY_FILE)) return readFileSync(ADMIN_KEY_FILE, "utf8").trim();
  const k = crypto.randomBytes(16).toString("hex");
  writeFileSync(ADMIN_KEY_FILE, k + "\n", "utf8");
  return k;
}
const ADMIN_KEY = loadAdminKey();
app.post("/api/admin/shutdown", (req, res) => {
  if (String(req.headers["x-admin-key"] ?? "") !== ADMIN_KEY) return res.status(403).json({ error: "拒绝访问" });
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

Bots.resetStatuses();

// ---------------- 启动（HTTP / HTTPS 自适应） ----------------
const certDir = path.join(ROOT, "data", "certs");
const keyFile = path.join(certDir, "server.key");
const crtFile = path.join(certDir, "server.crt");
const useHttps = existsSync(keyFile) && existsSync(crtFile);
function banner() {
  console.log("============================================");
  console.log("  QQ 机器人托管平台（付费版 v0.8）");
  console.log("============================================");
  console.log(useHttps ? `  HTTPS：https://localhost:${PORT}` : `  访问地址：http://localhost:${PORT}`);
  console.log("  存储：SQLite · 密钥 AES-256-GCM 加密");
  console.log("  按 Ctrl+C 停止");
  console.log("============================================");
}
if (useHttps) {
  https.createServer({ key: readFileSync(keyFile), cert: readFileSync(crtFile) }, app).listen(PORT, banner);
} else {
  app.listen(PORT, banner);
}
