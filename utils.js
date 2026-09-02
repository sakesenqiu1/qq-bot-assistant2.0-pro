/** 把长文本按 QQ 消息长度限制拆分，优先在换行处切。 */
export function splitLongText(text, max = 2000) {
  if (!text || text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= max * 0.4) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 解析 /命令 形式的消息；不是命令则返回 null。 */
export function parseCommand(text) {
  const m = /^[\/／]\s*([^\s]+)\s*([\s\S]*)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2] ?? "" };
}
