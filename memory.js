import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 会话记忆存储：
 * - 每个会话（私聊按用户；群聊按“群+用户”）保留最近 N 轮对话
 * - 超时自动过期，可选持久化到 data/memory.json
 */
export class MemoryStore {
  constructor(options = {}) {
    const {
      maxTurns = 12,
      ttlMs = 3 * 60 * 60 * 1000,
      persist = true,
      filePath = null,
      logger = null,
    } = options;
    this.maxTurns = maxTurns;
    this.ttlMs = ttlMs;
    this.persist = persist && Boolean(filePath);
    this.filePath = filePath;
    this.logger = logger;
    this.sessions = new Map();
    this.dirty = false;
    this.saveTimer = null;

    if (this.persist) {
      try {
        this.load();
      } catch (err) {
        this.logger?.warn?.(`读取记忆文件失败：${err?.message ?? err}`);
      }
    }
  }

  /** 生成会话键：私聊按用户，群聊按“群+用户”（互不串台）。 */
  static sessionKey(scope, targetId, senderId) {
    return scope === "c2c" ? `c2c:${senderId}` : `group:${targetId}:${senderId}`;
  }

  get(key) {
    const session = this.sessions.get(key);
    if (!session) return [];
    if (Date.now() - session.updatedAt > this.ttlMs) {
      this.sessions.delete(key);
      this.scheduleSave();
      return [];
    }
    return session.messages.map((m) => ({ ...m }));
  }

  push(key, role, content) {
    let session = this.sessions.get(key);
    if (!session) {
      session = { updatedAt: 0, messages: [] };
      this.sessions.set(key, session);
    }
    session.messages.push({ role, content });
    // 只保留最近 maxTurns 轮（一轮 = 用户 + 助手 两条）
    const maxMessages = Math.max(2, this.maxTurns * 2);
    if (session.messages.length > maxMessages) {
      session.messages = session.messages.slice(session.messages.length - maxMessages);
    }
    // 保证历史从“用户”消息开始（对话有头有尾）
    if (session.messages.length > 0 && session.messages[0].role !== "user") {
      session.messages = session.messages.slice(1);
    }
    session.updatedAt = Date.now();
    this.scheduleSave();
  }

  clear(key) {
    if (this.sessions.delete(key)) this.scheduleSave();
  }

  scheduleSave() {
    if (!this.persist) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1500);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.persist || !this.dirty) return;
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.sessions.delete(key);
    }
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const obj = {};
      for (const [key, session] of this.sessions) obj[key] = session;
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      this.logger?.warn?.(`保存记忆失败：${err?.message ?? err}`);
    }
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    const now = Date.now();
    for (const [key, value] of Object.entries(raw)) {
      if (!value || !Array.isArray(value.messages)) continue;
      if (now - (value.updatedAt ?? 0) > this.ttlMs) continue;
      this.sessions.set(key, {
        updatedAt: value.updatedAt ?? now,
        messages: value.messages.filter(
          (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
        ),
      });
    }
  }
}
