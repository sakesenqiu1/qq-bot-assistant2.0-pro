// 付费版全套流程测试（管理员由启动时自动创建，密码在 data/initial-admin.txt）
import { readFileSync } from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let token = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const log = (name, r) => console.log((r.status >= 200 && r.status < 300 ? "✔" : "✘"), name, "HTTP", r.status, JSON.stringify(r.data).slice(0, 100));

async function getCaptcha() {
  const d = await (await fetch(BASE + "/api/captcha")).json();
  const chars = [...d.svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join("");
  return { id: d.id, code: chars };
}

// 读自动管理员密码
const adminTxt = readFileSync("data/initial-admin.txt", "utf8");
const m = adminTxt.match(/初始密码 ([0-9a-f]+)/);
if (!m) throw new Error("未找到管理员初始密码");
const adminPass = m[1];
console.log("管理员: admin /", adminPass);

// 1) 管理员登录
let c = await getCaptcha();
let r = await call("POST", "/api/login", { username: "admin", password: adminPass, captchaId: c.id, captchaCode: c.code });
token = r.data.token;
log("管理员登录", r);

// 2) 生成邀请码
r = await call("POST", "/api/admin/invites", { count: 2, note: "测试" });
log("生成邀请码", r);
const inviteCode = r.data.created[0];

// 3) 普通用户注册（带邀请码+密保+验证码）
c = await getCaptcha();
const uname = "user" + Date.now().toString(36).slice(-3);
r = await call("POST", "/api/register", { username: uname, password: "pass1234", captchaId: c.id, captchaCode: c.code, securityQuestion: "你的出生城市是？", securityAnswer: "北京", inviteCode });
log("普通用户注册", r);

// 4) 普通用户登录 + 配额
c = await getCaptcha();
r = await call("POST", "/api/login", { username: uname, password: "pass1234", captchaId: c.id, captchaCode: c.code });
token = r.data.token;
log("普通用户登录", r);
r = await call("POST", "/api/bots", { name: "机器人1" });
log("免费版创建第1个机器人", r);
r = await call("POST", "/api/bots", { name: "机器人2" });
log("免费版创建第2个(应403配额)", r);

// 5) 管理员发月卡 + 统计
c = await getCaptcha();
r = await call("POST", "/api/login", { username: "admin", password: adminPass, captchaId: c.id, captchaCode: c.code });
token = r.data.token;
const uid = (await call("GET", "/api/admin/users")).data.find((u) => u.username === uname)?.id;
r = await call("POST", `/api/admin/users/${uid}/plan`, { plan: "monthly", days: 30 });
log("管理员发月卡", r);
r = await call("GET", "/api/admin/stats");
log("后台统计", r);

// 6) 找回密码
r = await call("POST", "/api/forgot/question", { username: uname });
log("找回-取密保问题", r);
r = await call("POST", "/api/forgot/reset", { username: uname, answer: "北京", newPassword: "newpass123" });
log("找回-重置密码", r);

// 7) 错误验证码应被拒
c = await getCaptcha();
r = await call("POST", "/api/login", { username: uname, password: "newpass123", captchaId: c.id, captchaCode: "ZZZZ" });
log("错误验证码登录(应400)", r);

console.log("=== 付费版测试完成 ===");
