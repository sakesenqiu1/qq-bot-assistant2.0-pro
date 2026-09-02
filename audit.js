import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 群消息审计日志：按“群 + 日期”记录机器人收到的每条群消息，
 * 供「/查违规」命令调用 AI 审查并公示。
 */
export class GroupAuditLog {
  constructor(options = {}) {
    const { filePath = null, keepDays = 3, maxPerGroupPerDay = 2000, logger = null, nowFn = null } = options;
    this.filePath = filePath;
    this.keepDays = keepDays;
    this.maxPerGroupPerDay = maxPerGroupPerDay;
    this.logger = logger;
    this.nowFn = nowFn ?? (() => Date.now());
    this.groups = new Map(); // groupId -> { dayKey -> [entry] }
    this.dirty = false;
    this.saveTimer = null;

    if (this.filePath) {
      try {
        this.load();
      } catch (err) {
        this.logger?.warn?.(`读取群审计文件失败：${err?.message ?? err}`);
      }
    }
  }

  static dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  static timeKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  static hashId(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(4, "0").slice(0, 4);
  }

  static genId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /** 清洗消息文本：去 @ 标记、表情标签、多余空白，限长。 */
  static cleanContent(content) {
    let text = String(content ?? "")
      .replace(/<@[^>]*>/g, "")
      .replace(/<face[^>]*>/g, "")
      .replace(/\[<face[^>]*\/>\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 200) text = text.slice(0, 200) + "…";
    return text;
  }

  /** 记录一条群消息。返回是否真的记入（空内容/机器人消息会跳过）。 */
  record(groupId, { senderId, senderName, content, isAt = false, isBot = false }) {
    const text = GroupAuditLog.cleanContent(content);
    if (!text || isBot) return false;
    const now = this.nowFn();
    const day = GroupAuditLog.dayKey(now);
    let days = this.groups.get(groupId);
    if (!days) {
      days = new Map();
      this.groups.set(groupId, days);
    }
    let list = days.get(day);
    if (!list) {
      list = [];
      days.set(day, list);
    }
    const entry = {
      id: GroupAuditLog.genId(),
      t: GroupAuditLog.timeKey(now),
      ts: now,
      user: senderName || "匿名群友#" + GroupAuditLog.hashId(senderId),
      content: text,
      at: Boolean(isAt),
      uid: String(senderId ?? ""),
    };
    list.push(entry);
    if (list.length > this.maxPerGroupPerDay) list.splice(0, list.length - this.maxPerGroupPerDay);
    this.scheduleSave();
    return entry;
  }

  /** 取某群“今天”的消息记录（按时间排序）。 */
  getToday(groupId) {
    const days = this.groups.get(groupId);
    if (!days) return [];
    const today = GroupAuditLog.dayKey(this.nowFn());
    return days.get(today) ?? [];
  }

  /** 今天收录的消息里是否全部来自 @机器人（用于提示全量消息未开启）。 */
  todayAllAt(groupId) {
    const list = this.getToday(groupId);
    return list.length > 0 && list.every((e) => e.at);
  }

  prune() {
    const cutoff = GroupAuditLog.dayKey(this.nowFn() - this.keepDays * 24 * 60 * 60 * 1000);
    for (const [groupId, days] of this.groups) {
      for (const day of days.keys()) {
        if (day < cutoff) days.delete(day);
      }
      if (days.size === 0) this.groups.delete(groupId);
    }
  }

  scheduleSave() {
    if (!this.filePath) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1500);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.filePath || !this.dirty) return;
    this.prune();
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const obj = {};
      for (const [groupId, days] of this.groups) {
        const dayObj = {};
        for (const [day, list] of days) dayObj[day] = list;
        obj[groupId] = dayObj;
      }
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      this.logger?.warn?.(`保存群审计失败：${err?.message ?? err}`);
    }
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    let backfilled = false;
    for (const [groupId, dayObj] of Object.entries(raw)) {
      const days = new Map();
      for (const [day, list] of Object.entries(dayObj ?? {})) {
        if (!Array.isArray(list)) continue;
        // 兼容旧数据：补条目唯一 id（去重依赖它）
        for (const entry of list) {
          if (!entry || !entry.id) {
            if (entry) entry.id = GroupAuditLog.genId();
            backfilled = true;
          }
        }
        days.set(day, list);
      }
      if (days.size > 0) this.groups.set(groupId, days);
    }
    this.prune();
    if (backfilled) this.scheduleSave(); // 把补上的 id 写回磁盘
  }
}