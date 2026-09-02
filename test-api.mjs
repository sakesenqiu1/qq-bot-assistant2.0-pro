// 平台 API 冒烟测试：注册→登录→建→查→改→启动→停止→删（v0.3 含特殊词提示词/审查配置）
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let token = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const log = (name, r) =>
  console.log((r.status >= 200 && r.status < 300 ? "✔" : "✘"), name, JSON.stringify(r.data).slice(0, 120));

let r = await call("POST", "/api/register", { username: "测试用户" + Date.now().toString(36).slice(-4), password: "test123456" });
const sameUser = r.data.username;
token = r.data.token;
log("注册", r);

r = await call("POST", "/api/register", { username: sameUser, password: "test123456" });
log("重复注册(应409)", r);

r = await call("POST", "/api/login", { username: sameUser, password: "test123456" });
log("登录", r);

r = await call("GET", "/api/me");
log("当前用户", r);

r = await call("POST", "/api/bots", {
  name: "管理助手一号",
  qq: { appId: "123456789", appSecret: "dummysecret" },
  llm: { baseUrl: "https://api.deepseek.com", apiKey: "sk-dummy", model: "deepseek-chat" },
  persona: "你是一个严肃的管理机器人。",
  rules: "1. 禁止广告",
  specialWords: [
    { word: "群规", action: "reply", reply: "本群禁止广告、色情、刷屏。" },
    { word: "骂人", action: "ai", prompt: "用户可能涉及辱骂，请先判断其言论是否违规，若违规请严肃警告，否则正常回答。" },
  ],
  moderation: { autoRebuke: true, keywords: ["色情", "黄图", "约炮"], autoMute: { enabled: true, level: "medium", scanIntervalMinutes: 15 } },
});
const botId = r.data.id;
log("创建机器人(特殊词+审查)", r);
log("特殊词详情", { status: 200, data: r.data.specialWords });
log("审查配置", { status: 200, data: r.data.moderation });

r = await call("GET", "/api/bots");
log("机器人列表", r);

r = await call("PUT", "/api/bots/" + botId, {
  rules: "1. 禁止广告 2. 禁止辱骂",
  moderation: { autoRebuke: false, keywords: [], autoMute: { enabled: false, level: "heavy" } },
});
log("更新(关闭自动攻击)", r);

r = await call("POST", "/api/bots/" + botId + "/start");
log("启动(假凭证)", r);

r = await call("POST", "/api/bots/" + botId + "/stop");
log("停止", r);

r = await call("DELETE", "/api/bots/" + botId);
log("删除", r);

r = await call("GET", "/api/bots");
log("删除后列表", r);

const resNoAuth = await fetch(BASE + "/api/bots");
console.log("未登录访问(应401):", resNoAuth.status);
console.log("=== API 冒烟测试完成 ===");
