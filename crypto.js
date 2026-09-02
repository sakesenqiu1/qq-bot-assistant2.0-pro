/**
 * 密钥加密模块：AES-256-GCM
 * - 主密钥保存在 data/master.key（首次运行自动生成，32 字节随机数）
 * - 用户的 AppSecret / API Key 入库前加密，取出时解密
 * - 加密格式：v1:<iv>:<authTag>:<密文>（全部 hex）
 * ⚠️ 若 master.key 丢失，已加密的数据将无法恢复（属预期安全行为）
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(ROOT, "data", "master.key");

function loadOrCreateKey() {
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
    console.warn("master.key 内容异常，将重新生成（旧的加密数据将无法解密）");
  }
  const key = crypto.randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("hex") + "\n", "utf8");
  return key;
}

const MASTER_KEY = loadOrCreateKey();

export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

export function decrypt(payload) {
  if (!payload) return "";
  const parts = String(payload).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return String(payload); // 兼容未加密旧数据
  const [, ivHex, tagHex, dataHex] = parts;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return ""; // 解密失败（密钥被换）时返回空，由上层报配置错误
  }
}
