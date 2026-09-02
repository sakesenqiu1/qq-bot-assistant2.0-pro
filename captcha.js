/**
 * 图形验证码（SVG，无外部依赖）
 * - 生成 4 位字符（排除易混淆字符），5 分钟有效，一次性使用
 * - 接口：GET /api/captcha 返回 { id, svg }
 */
import crypto from "node:crypto";

const CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const store = new Map(); // id -> { code, exp }

function cleanup() {
  const now = Date.now();
  for (const [id, c] of store) {
    if (c.exp < now) store.delete(id);
  }
}

function renderSvg(code) {
  const chars = code.split("");
  const width = 130;
  const height = 42;
  let text = "";
  chars.forEach((ch, i) => {
    const x = 12 + i * 28;
    const y = 30 + (Math.random() * 4 - 2);
    const rotate = Math.random() * 20 - 10;
    const color = `hsl(${Math.floor(Math.random() * 360)}, 60%, 45%)`;
    text += `<text x="${x}" y="${y}" font-size="22" font-family="Arial" font-weight="bold" fill="${color}" transform="rotate(${rotate} ${x} ${y})">${ch}</text>`;
  });
  let noise = "";
  for (let i = 0; i < 5; i++) {
    const x1 = Math.random() * width;
    const y1 = Math.random() * height;
    const x2 = Math.random() * width;
    const y2 = Math.random() * height;
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cccccc" stroke-width="1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f5f7fa"/>${noise}${text}</svg>`;
}

export function generateCaptcha() {
  cleanup();
  const code = Array.from({ length: 4 }, () => CHARS[crypto.randomInt(0, CHARS.length)]).join("");
  const id = crypto.randomBytes(12).toString("hex");
  store.set(id, { code, exp: Date.now() + 5 * 60 * 1000 });
  return { id, svg: renderSvg(code) };
}

export function verifyCaptcha(id, input) {
  const c = store.get(id);
  if (!c) return false;
  store.delete(id); // 一次性
  return c.exp > Date.now() && String(input ?? "").trim().toUpperCase() === c.code;
}
