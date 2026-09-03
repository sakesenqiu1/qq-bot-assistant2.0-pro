/**
 * 用户数据库（付费版 · SQLite，Node 内置 node:sqlite，需 Node 24+）
 * 新增：
 *  - 用户：角色(admin/user)、状态、会员计划(免费/月卡/买断)、密保问题/答案、注册时间
 *  - 邀请码：管理员生成，注册时校验并消耗
 *  - 兼容旧版 db.sqlite：启动时自动 ALTER 补列
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.sqlite");
const OLD_JSON = path.join(DATA_DIR, "db.json");

const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires_at INTEGER NOT NULL DEFAULT 0,
  security_question TEXT NOT NULL DEFAULT '',
  security_answer_hash TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'stopped',
  last_error TEXT NOT NULL DEFAULT '',
  app_id TEXT NOT NULL DEFAULT '',
  app_secret_enc TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  api_key_enc TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'deepseek-chat',
  temperature REAL NOT NULL DEFAULT 0.7,
  persona TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  special_words TEXT NOT NULL DEFAULT '[]',
  moderation TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  used_by TEXT NOT NULL DEFAULT '',
  used_at INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'monthly',
  days INTEGER NOT NULL DEFAULT 30,
  used_by TEXT NOT NULL DEFAULT '',
  used_at INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`);

// ---- 兼容旧库：补列 ----
for (const [col, def] of [
  ["role", "TEXT NOT NULL DEFAULT 'user'"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["plan", "TEXT NOT NULL DEFAULT 'free'"],
  ["plan_expires_at", "INTEGER NOT NULL DEFAULT 0"],
  ["security_question", "TEXT NOT NULL DEFAULT ''"],
  ["security_answer_hash", "TEXT NOT NULL DEFAULT ''"],
]) {
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
}

// ---- 旧 JSON 自动迁移 ----
migrateFromJson();

function migrateFromJson() {
  if (!existsSync(OLD_JSON)) return;
  try {
    const old = JSON.parse(readFileSync(OLD_JSON, "utf8"));
    const uc = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    const bc = db.prepare("SELECT COUNT(*) AS c FROM bots").get().c;
    if (uc === 0 && bc === 0 && (old.users?.length || old.bots?.length)) {
      const insU = db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)");
      for (const u of old.users ?? []) insU.run(u.id, u.username, u.passwordHash, u.createdAt ?? Date.now());
      const insB = db.prepare(`INSERT OR IGNORE INTO bots
        (id, owner_id, name, enabled, status, last_error, app_id, app_secret_enc, base_url, api_key_enc, model, temperature, persona, rules, special_words, moderation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const b of old.bots ?? []) {
        insB.run(
          b.id, b.ownerId, b.name ?? "我的机器人", b.enabled !== false ? 1 : 0,
          b.status ?? "stopped", b.lastError ?? "",
          b.qq?.appId ?? "", encrypt(b.qq?.appSecret ?? ""),
          b.llm?.baseUrl ?? "https://api.deepseek.com", encrypt(b.llm?.apiKey ?? ""),
          b.llm?.model ?? "deepseek-chat", Number(b.llm?.temperature ?? 0.7),
          b.persona ?? "", b.rules ?? "",
          JSON.stringify(b.specialWords ?? []), JSON.stringify(b.moderation ?? {}),
          b.createdAt ?? Date.now(), b.updatedAt ?? Date.now(),
        );
      }
    }
    renameSync(OLD_JSON, OLD_JSON + ".migrated");
  } catch (err) {
    console.warn("旧数据迁移失败（跳过）：" + err.message);
  }
}

// ---------------- 行映射 ----------------
function rowToBot(row) {
  if (!row) return null;
  let specialWords = [];
  try { specialWords = JSON.parse(row.special_words ?? "[]"); } catch {}
  let moderation = { enabled: true, autoRebuke: true, cooldownMinutes: 5, keywords: [], autoMute: { enabled: false, level: "light", scanIntervalMinutes: 10 } };
  try { moderation = { enabled: true, autoRebuke: true, cooldownMinutes: 5, keywords: [], autoMute: { enabled: false, level: "light", scanIntervalMinutes: 10 }, ...JSON.parse(row.moderation ?? "{}") }; } catch {}
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, enabled: Boolean(row.enabled),
    status: row.status, lastError: row.last_error,
    appId: row.app_id, appSecretEnc: row.app_secret_enc,
    baseUrl: row.base_url, apiKeyEnc: row.api_key_enc,
    model: row.model, temperature: row.temperature,
    persona: row.persona, rules: row.rules,
    specialWords, moderation,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ---------------- 密码 ----------------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
export function verifyPassword(pw, stored) {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(String(pw), salt, 32));
  } catch { return false; }
}
export function genId() { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }

// 会员计划定义
export const PLANS = {
  free: { name: "免费版", botQuota: 1 },
  monthly: { name: "月卡", botQuota: 5 },
  quarterly: { name: "季卡", botQuota: 5 },
  lifetime: { name: "买断", botQuota: 999 },
};

// ---------------- 用户 ----------------
export const Users = {
  findByUsername: (u) => db.prepare("SELECT * FROM users WHERE username = ?").get(u) ?? null,
  findById: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null,
  create: (u) => {
    db.prepare(`INSERT INTO users (id, username, password_hash, created_at, role, status, plan, plan_expires_at, security_question, security_answer_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, u.username, u.passwordHash, u.createdAt, u.role ?? "user", u.status ?? "active", u.plan ?? "free", u.planExpiresAt ?? 0, u.securityQuestion ?? "", u.securityAnswerHash ?? "");
    return Users.findByUsername(u.username);
  },
  count: () => db.prepare("SELECT COUNT(*) AS c FROM users").get().c,
  countAdmin: () => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c,
  listAll: () => db.prepare("SELECT * FROM users ORDER BY created_at DESC").all(),
  updateRole: (id, role) => db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id),
  updateStatus: (id, status) => db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id),
  setPlan: (id, plan, expiresAt) => db.prepare("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?").run(plan, expiresAt ?? 0, id),
  setPassword: (id, passwordHash) => db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id),
  updateUsername: (id, username) => db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, id),
  setSecurity: (id, question, answerHash) => db.prepare("UPDATE users SET security_question = ?, security_answer_hash = ? WHERE id = ?").run(question, answerHash, id),
};

// ---------------- 机器人 ----------------
export const Bots = {
  listByOwner: (ownerId) => db.prepare("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId).map(rowToBot),
  countByOwner: (ownerId) => db.prepare("SELECT COUNT(*) AS c FROM bots WHERE owner_id = ?").get(ownerId).c,
  find: (id) => rowToBot(db.prepare("SELECT * FROM bots WHERE id = ?").get(id)),
  findWithSecrets: (id) => {
    const b = Bots.find(id);
    if (!b) return null;
    return {
      id: b.id, ownerId: b.ownerId, name: b.name, enabled: b.enabled, status: b.status, lastError: b.lastError,
      qq: { appId: b.appId, appSecret: decrypt(b.appSecretEnc) },
      llm: { baseUrl: b.baseUrl, apiKey: decrypt(b.apiKeyEnc), model: b.model, temperature: b.temperature },
      persona: b.persona, rules: b.rules, specialWords: b.specialWords, moderation: b.moderation,
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
  },
  create: (record) => {
    const now = Date.now();
    db.prepare(`INSERT INTO bots
      (id, owner_id, name, enabled, status, last_error, app_id, app_secret_enc, base_url, api_key_enc, model, temperature, persona, rules, special_words, moderation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.ownerId, record.name, record.enabled !== false ? 1 : 0, record.status ?? "stopped", record.lastError ?? "",
        record.qq?.appId ?? "", encrypt(record.qq?.appSecret ?? ""),
        record.llm?.baseUrl ?? "https://api.deepseek.com", encrypt(record.llm?.apiKey ?? ""),
        record.llm?.model ?? "deepseek-chat", Number(record.llm?.temperature ?? 0.7),
        record.persona ?? "", record.rules ?? "", JSON.stringify(record.specialWords ?? []), JSON.stringify(record.moderation ?? {}),
        record.createdAt ?? now, record.updatedAt ?? now);
    return Bots.find(record.id);
  },
  update: (id, patch) => {
    const cur = Bots.find(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, qq: { ...cur.qq, ...(patch.qq ?? {}) }, llm: { ...cur.llm, ...(patch.llm ?? {}) }, updatedAt: Date.now() };
    db.prepare(`UPDATE bots SET name=?, enabled=?, status=?, last_error=?, app_id=?, app_secret_enc=?, base_url=?, api_key_enc=?, model=?, temperature=?, persona=?, rules=?, special_words=?, moderation=?, updated_at=? WHERE id=?`)
      .run(next.name, next.enabled !== false ? 1 : 0, next.status ?? "stopped", next.lastError ?? "",
        next.qq?.appId ?? cur.appId, next.qq?.appSecret ? encrypt(next.qq.appSecret) : cur.appSecretEnc,
        next.llm?.baseUrl ?? cur.baseUrl, next.llm?.apiKey ? encrypt(next.llm.apiKey) : cur.apiKeyEnc,
        next.llm?.model ?? cur.model, Number(next.llm?.temperature ?? cur.temperature),
        next.persona ?? cur.persona, next.rules ?? cur.rules, JSON.stringify(next.specialWords ?? cur.specialWords),
        JSON.stringify(next.moderation ?? cur.moderation), next.updatedAt, id);
    return Bots.find(id);
  },
  remove: (id) => { const r = db.prepare("DELETE FROM bots WHERE id = ?").run(id); return r.changes > 0; },
  all: () => db.prepare("SELECT * FROM bots ORDER BY created_at DESC").all().map(rowToBot),
  count: () => db.prepare("SELECT COUNT(*) AS c FROM bots").get().c,
  resetStatuses: () => db.prepare("UPDATE bots SET status='stopped', last_error='' WHERE status!='stopped'").run(),
};

// ---------------- 会话 ----------------
export const Sessions = {
  create: (userId) => {
    const token = crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
    return token;
  },
  find: (token) => db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) ?? null,
  remove: (token) => db.prepare("DELETE FROM sessions WHERE token = ?").run(token),
};

// ---------------- 邀请码 ----------------
export const Invites = {
  create: (code, note) => {
    db.prepare("INSERT OR IGNORE INTO invites (code, note, created_at) VALUES (?, ?, ?)").run(code, note ?? "", Date.now());
    return Invites.find(code);
  },
  find: (code) => db.prepare("SELECT * FROM invites WHERE code = ?").get(code) ?? null,
  listAll: () => db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all(),
  setEnabled: (code, enabled) => db.prepare("UPDATE invites SET enabled = ? WHERE code = ?").run(enabled ? 1 : 0, code),
  consume: (code, userId) => db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?").run(userId, Date.now(), code),
  delete: (code) => db.prepare("DELETE FROM invites WHERE code = ?").run(code),
};

// ---------------- 系统设置 ----------------
export const Settings = {
  get: (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "",
  set: (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)),
};

// ---------------- 充值卡密（自动开通会员） ----------------
export const RedeemCodes = {
  create: (code, type, days) => {
    db.prepare("INSERT OR IGNORE INTO redeem_codes (code, type, days, created_at) VALUES (?, ?, ?, ?)").run(code, type, days ?? 30, Date.now());
    return RedeemCodes.find(code);
  },
  find: (code) => db.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code) ?? null,
  listAll: () => db.prepare("SELECT * FROM redeem_codes ORDER BY created_at DESC").all(),
  setEnabled: (code, enabled) => db.prepare("UPDATE redeem_codes SET enabled = ? WHERE code = ?").run(enabled ? 1 : 0, code),
  consume: (code, userId) => db.prepare("UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ?").run(userId, Date.now(), code),
  delete: (code) => db.prepare("DELETE FROM redeem_codes WHERE code = ?").run(code),
};
