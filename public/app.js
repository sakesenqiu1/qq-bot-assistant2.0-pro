// 前端逻辑（付费版 v0.8）：登录/注册/找回 + 机器人管理 + 后台管理 + 使用说明
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const TOKEN_KEY = "qqbot_pro_token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let me = null;
let bots = [];
let editingId = null;
let captcha = { login: {}, reg: {} };
let adminTab = "users";
let currentView = "user";

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败(" + res.status + ")");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const PLAN_NAME = { free: "免费版", monthly: "月卡", lifetime: "买断" };
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN") : "—");

// ============ 验证码 ============
async function loadCaptcha(kind) {
  try {
    const r = await fetch("/api/captcha");
    const d = await r.json();
    captcha[kind] = { id: d.id };
    const img = $("#" + kind + "-captcha-img");
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(d.svg)));
  } catch {}
}
$("#login-captcha-img").onclick = () => loadCaptcha("login");
$("#reg-captcha-img").onclick = () => loadCaptcha("reg");

// ============ 视图切换 ============
function show(view) {
  $("#auth-view").classList.toggle("hidden", view !== "auth");
  $("#dashboard").classList.toggle("hidden", view !== "dash");
}
function setMsg(sel, text, ok = false) {
  const el = $(sel);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

$("#tab-login").onclick = () => switchTab(true);
$("#tab-register").onclick = () => switchTab(false);
function switchTab(isLogin) {
  $("#tab-login").classList.toggle("active", isLogin);
  $("#tab-register").classList.toggle("active", !isLogin);
  $("#login-form").classList.toggle("hidden", !isLogin);
  $("#register-form").classList.toggle("hidden", isLogin);
  setMsg("#auth-msg", "");
  loadCaptcha(isLogin ? "login" : "reg");
}

$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const d = await api("/api/login", { method: "POST", body: JSON.stringify({
      username: $("#login-username").value.trim(), password: $("#login-password").value,
      captchaId: captcha.login.id, captchaCode: $("#login-captcha").value,
    }) });
    token = d.token; localStorage.setItem(TOKEN_KEY, token);
    await enterDashboard();
  } catch (err) { setMsg("#auth-msg", err.message); loadCaptcha("login"); }
};

$("#register-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const d = await api("/api/register", { method: "POST", body: JSON.stringify({
      username: $("#reg-username").value.trim(), password: $("#reg-password").value,
      securityQuestion: $("#reg-question").value, securityAnswer: $("#reg-answer").value.trim(),
      inviteCode: $("#reg-invite").value.trim(),
      captchaId: captcha.reg.id, captchaCode: $("#reg-captcha").value,
    }) });
    token = d.token; localStorage.setItem(TOKEN_KEY, token);
    await enterDashboard();
  } catch (err) { setMsg("#auth-msg", err.message); loadCaptcha("reg"); }
};

// ============ 找回密码 ============
$("#btn-forgot").onclick = () => { $("#forgot-modal").classList.remove("hidden"); setMsg("#forgot-msg", ""); $("#forgot-step1").classList.remove("hidden"); $("#forgot-step2").classList.add("hidden"); };
$("#forgot-close").onclick = () => $("#forgot-modal").classList.add("hidden");
$("#f-next").onclick = async () => {
  try {
    const d = await api("/api/forgot/question", { method: "POST", body: JSON.stringify({ username: $("#f-username").value.trim() }) });
    $("#f-question").textContent = "密保问题：" + d.question;
    $("#forgot-step1").classList.add("hidden");
    $("#forgot-step2").classList.remove("hidden");
  } catch (err) { setMsg("#forgot-msg", err.message); }
};
$("#f-reset").onclick = async () => {
  try {
    await api("/api/forgot/reset", { method: "POST", body: JSON.stringify({ username: $("#f-username").value.trim(), answer: $("#f-answer").value.trim(), newPassword: $("#f-newpw").value }) });
    setMsg("#forgot-msg", "密码已重置，请登录", true);
    setTimeout(() => $("#forgot-modal").classList.add("hidden"), 1200);
  } catch (err) { setMsg("#forgot-msg", err.message); }
};

// ============ 登出 ============
$("#btn-logout").onclick = async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  token = ""; localStorage.removeItem(TOKEN_KEY); me = null;
  show("auth"); switchTab(true);
};

// ============ 进入面板 ============
async function enterDashboard() {
  me = await api("/api/me");
  $("#who").textContent = "👤 " + me.username;
  $("#plan-badge").textContent = PLAN_NAME[me.plan] || "免费版";
  $("#plan-badge").className = "badge " + (me.plan === "free" ? "stopped" : "running");
  $("#btn-admin").classList.toggle("hidden", me.role !== "admin");
  show("dash");
  currentView = "user";
  $("#user-view").classList.remove("hidden");
  $("#admin-view").classList.add("hidden");
  await loadBots();
}

// ============ 机器人 ============
async function loadBots() {
  if (currentView !== "user") return;
  bots = await api("/api/bots");
  const list = $("#bot-list");
  if (bots.length === 0) { list.innerHTML = '<div class="empty">还没有机器人，点击右上角「＋ 新建机器人」开始</div>'; return; }
  list.innerHTML = bots.map(renderCard).join("");
  list.querySelectorAll("[data-act]").forEach((btn) => (btn.onclick = () => handleAction(btn.dataset.act, btn.dataset.id)));
}
function statusBadge(s) {
  const map = { stopped: ["已停止", "stopped"], starting: ["启动中", "starting"], running: ["运行中", "running"], error: ["出错", "error"] };
  const [t, c] = map[s] || [s, "stopped"];
  return `<span class="badge ${c}">${t}</span>`;
}
function renderCard(b) {
  const running = b.status === "running" || b.status === "starting";
  return `<div class="bot-card">
    <div class="top"><h4>${esc(b.name)}</h4>${statusBadge(b.status)}</div>
    <div class="meta">
      AppID：${esc(b.qq.appId || "未填写")}${b.qq.hasSecret || b.llm.hasKey ? " · 🔒密钥已加密" : ""}<br>
      AI 模型：${esc(b.llm.model || "未填写")} · ${esc(b.llm.baseUrl || "")}<br>
      特殊词：${b.specialWords?.length ?? 0} 条${b.moderation?.autoRebuke ? " · 🚨自动注意" : ""}${b.moderation?.autoMute?.enabled ? " · 🔇禁言开" : ""} · 更新于 ${fmtTime(b.updatedAt)}
    </div>
    ${b.lastError ? `<div class="err-line">⚠ ${esc(b.lastError)}</div>` : ""}
    <div class="actions">
      ${running ? `<button class="btn" data-act="stop" data-id="${b.id}">停止</button>` : `<button class="btn success" data-act="start" data-id="${b.id}">启动</button>`}
      <button class="btn" data-act="edit" data-id="${b.id}">编辑</button>
      <button class="btn danger" data-act="del" data-id="${b.id}">删除</button>
    </div>
  </div>`;
}
async function handleAction(act, id) {
  if (act === "start") { try { await api(`/api/bots/${id}/start`, { method: "POST" }); } catch (e) { alert(e.message); } await loadBots(); }
  else if (act === "stop") { try { await api(`/api/bots/${id}/stop`, { method: "POST" }); } catch {} await loadBots(); }
  else if (act === "edit") { openModal(bots.find((b) => b.id === id)); }
  else if (act === "del") { if (confirm("确定删除该机器人？")) { try { await api(`/api/bots/${id}`, { method: "DELETE" }); } catch (e) { alert(e.message); } await loadBots(); } }
}

// ============ 机器人弹窗 ============
$("#btn-new").onclick = () => openModal(null);
$("#modal-close").onclick = closeModal;
$("#modal-cancel").onclick = closeModal;
$("#modal").onclick = (e) => { if (e.target === $("#modal")) closeModal(); };
function closeModal() { $("#modal").classList.add("hidden"); }
function openModal(bot) {
  editingId = bot?.id ?? null;
  $("#modal-title").textContent = bot ? "编辑机器人：" + bot.name : "新建机器人";
  const f = $("#bot-form");
  f.reset();
  f.name.value = bot?.name ?? "";
  f.appId.value = bot?.qq.appId ?? "";
  f.appSecret.value = ""; f.appSecret.placeholder = bot?.qq?.hasSecret ? "已加密保存（留空保持不变）" : "未设置";
  f.baseUrl.value = bot?.llm.baseUrl ?? "https://api.deepseek.com";
  f.apiKey.value = ""; f.apiKey.placeholder = bot?.llm?.hasKey ? "已加密保存（留空保持不变）" : "sk-...";
  f.model.value = bot?.llm.model ?? "deepseek-chat";
  f.persona.value = bot?.persona ?? "";
  f.rules.value = bot?.rules ?? "";
  f.enabled.checked = bot ? bot.enabled : true;
  f.autoRebuke.checked = bot ? bot.moderation?.autoRebuke !== false : true;
  f.keywords.value = (bot?.moderation?.keywords ?? []).join(",");
  f.autoMuteEnabled.checked = bot?.moderation?.autoMute?.enabled === true;
  f.muteLevel.value = bot?.moderation?.autoMute?.level ?? "light";
  f.scanInterval.value = bot?.moderation?.autoMute?.scanIntervalMinutes ?? 10;
  renderWords(bot?.specialWords ?? []);
  $("#modal").classList.remove("hidden");
}
function renderWords(words) {
  const list = $("#words-list");
  list.innerHTML = "";
  (words.length ? words : [{}]).forEach((w) => list.appendChild(wordRow(w)));
}
function wordRow(w = {}) {
  const div = document.createElement("div");
  div.className = "word-row";
  div.innerHTML = `<input class="w-word" placeholder="触发词，如：群规" value="${esc(w.word ?? "")}">
    <select class="w-action">
      <option value="reply" ${w.action === "reply" ? "selected" : ""}>固定回复</option>
      <option value="ai" ${w.action === "ai" ? "selected" : ""}>交给AI判断</option>
      <option value="ignore" ${w.action === "ignore" ? "selected" : ""}>忽略该消息</option>
    </select>
    <input class="w-value" value="${esc(w.action === "ai" ? (w.prompt ?? "") : (w.reply ?? ""))}">
    <button type="button" class="btn ghost" onclick="this.parentElement.remove()">✕</button>`;
  const sel = div.querySelector(".w-action"), input = div.querySelector(".w-value");
  const apply = () => {
    if (sel.value === "ai") { input.placeholder = "给 AI 的提示词"; input.disabled = false; }
    else if (sel.value === "reply") { input.placeholder = "固定回复内容"; input.disabled = false; }
    else { input.placeholder = "（忽略，无需填写）"; input.disabled = true; }
  };
  sel.onchange = apply; apply();
  return div;
}
$("#btn-add-word").onclick = () => $("#words-list").appendChild(wordRow());
$("#bot-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const qq = { appId: f.appId.value.trim(), appSecret: f.appSecret.value.trim() };
  const llm = { baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim(), model: f.model.value.trim() };
  const specialWords = [...$$(".word-row")].map((row) => {
    const action = row.querySelector(".w-action").value;
    const value = row.querySelector(".w-value").value.trim();
    return { word: row.querySelector(".w-word").value.trim(), action, reply: action === "reply" ? value : "", prompt: action === "ai" ? value : "" };
  }).filter((w) => w.word);
  const body = {
    name: f.name.value.trim(),
    qq: Object.fromEntries(Object.entries(qq).filter(([, v]) => v !== "")),
    llm: Object.fromEntries(Object.entries(llm).filter(([, v]) => v !== "")),
    persona: f.persona.value, rules: f.rules.value, specialWords,
    moderation: { autoRebuke: f.autoRebuke.checked, keywords: f.keywords.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean), autoMute: { enabled: f.autoMuteEnabled.checked, level: f.muteLevel.value, scanIntervalMinutes: Number(f.scanInterval.value) || 10 } },
    enabled: f.enabled.checked,
  };
  try {
    if (editingId) await api(`/api/bots/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/api/bots", { method: "POST", body: JSON.stringify(body) });
    closeModal(); await loadBots();
  } catch (err) { alert(err.message); }
};

// ============ 使用说明 ============
$("#btn-help").onclick = () => $("#help-modal").classList.remove("hidden");
$("#help-close").onclick = () => $("#help-modal").classList.add("hidden");

// ============ 会员中心 ============
$("#btn-member").onclick = async () => {
  $("#member-modal").classList.remove("hidden");
  setMsg("#m-msg", "");
  const m = await api("/api/me");
  $("#m-plan").textContent = PLAN_NAME[m.plan] || "免费版";
  $("#m-expire").textContent = m.plan === "monthly" ? "到期时间：" + fmtTime(m.planExpiresAt) : "";
};
$("#member-close").onclick = () => $("#member-modal").classList.add("hidden");
$("#m-redeem").onclick = async () => {
  try {
    const d = await api("/api/redeem", { method: "POST", body: JSON.stringify({ code: $("#m-code").value.trim() }) });
    setMsg("#m-msg", "开通成功！当前会员：" + PLAN_NAME[d.plan], true);
    $("#m-code").value = "";
    await enterDashboard();
  } catch (e) { setMsg("#m-msg", e.message); }
};

// ============ 修改密码 ============
$("#btn-pwd").onclick = () => { $("#pwd-modal").classList.remove("hidden"); setMsg("#pwd-msg", ""); $("#acc-username").value = me?.username || ""; };
$("#pwd-close").onclick = () => $("#pwd-modal").classList.add("hidden");
$("#acc-username-save").onclick = async () => {
  try {
    const d = await api("/api/change-username", { method: "POST", body: JSON.stringify({ username: $("#acc-username").value.trim() }) });
    setMsg("#pwd-msg", "用户名已更新为 " + d.username, true);
    $("#who").textContent = "👤 " + d.username;
  } catch (e) { setMsg("#pwd-msg", e.message); }
};
$("#acc-sec-save").onclick = async () => {
  try {
    await api("/api/change-security", { method: "POST", body: JSON.stringify({ question: $("#acc-question").value, answer: $("#acc-answer").value.trim() }) });
    setMsg("#pwd-msg", "密保已更新", true);
    $("#acc-answer").value = "";
  } catch (e) { setMsg("#pwd-msg", e.message); }
};
$("#pwd-save").onclick = async () => {
  try {
    await api("/api/change-password", { method: "POST", body: JSON.stringify({ oldPassword: $("#pwd-old").value, newPassword: $("#pwd-new").value }) });
    setMsg("#pwd-msg", "密码已修改", true);
    $("#pwd-old").value = ""; $("#pwd-new").value = "";
  } catch (e) { setMsg("#pwd-msg", e.message); }
};

// ============ 邀请码开关（注册页） ============
async function refreshRequireInvite() {
  try {
    const d = await (await fetch("/api/settings/public")).json();
    $("#invite-row").classList.toggle("hidden", !d.requireInvite);
    $("#reg-invite").required = d.requireInvite;
  } catch {}
}

// ============ 后台管理 ============
$("#btn-admin").onclick = () => { currentView = "admin"; $("#user-view").classList.add("hidden"); $("#admin-view").classList.remove("hidden"); $("#admin-table").innerHTML = '<div class="empty">加载中…</div>'; loadAdmin(); };
$$(".atab").forEach((t) => (t.onclick = () => { adminTab = t.dataset.v; $$(".atab").forEach((x) => x.classList.toggle("active", x === t)); loadAdmin(); }));

async function loadAdmin() {
  if (adminTab === "users") return loadAdminUsers();
  if (adminTab === "bots") return loadAdminBots();
  if (adminTab === "invites") return loadAdminInvites();
  if (adminTab === "redeems") return loadAdminRedeems();
  if (adminTab === "settings") return loadAdminSettings();
}
async function loadAdminStats() {
  const s = await api("/api/admin/stats");
  $("#stat-cards").innerHTML = `
    <div class="stat"><b>${s.users}</b><span>注册用户</span></div>
    <div class="stat"><b>${s.bots}</b><span>机器人总数</span></div>
    <div class="stat"><b>${s.runningBots}</b><span>运行中</span></div>
    <div class="stat"><b>${s.unusedInvites}</b><span>可用邀请码</span></div>`;
}
async function loadAdminUsers() {
  await loadAdminStats();
  const users = await api("/api/admin/users");
  $("#admin-table").innerHTML = `<table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>会员</th><th>机器人</th><th>注册时间</th><th>操作</th></tr></thead><tbody>
    ${users.map((u) => `<tr>
      <td>${esc(u.username)}</td>
      <td>${u.role === "admin" ? "管理员" : "用户"}</td>
      <td>${u.status === "active" ? "正常" : "禁用"}</td>
      <td>${PLAN_NAME[u.plan] || "免费版"}${u.plan === "monthly" ? "（至" + fmtTime(u.planExpiresAt) + "）" : ""}</td>
      <td>${u.botCount}</td>
      <td>${fmtTime(u.createdAt)}</td>
      <td class="opts">
        <button class="btn" onclick="adminPlan('${u.id}','monthly')">发月卡</button>
        <button class="btn" onclick="adminPlan('${u.id}','lifetime')">发买断</button>
        <button class="btn" onclick="adminPlan('${u.id}','free')">回收会员</button>
        <button class="btn ${u.status === "active" ? "danger" : "success"}" onclick="adminStatus('${u.id}','${u.status === "active" ? "disabled" : "active"}')">${u.status === "active" ? "禁用" : "启用"}</button>
      </td></tr>`).join("")}</tbody></table>`;
}
async function loadAdminBots() {
  await loadAdminStats();
  const list = await api("/api/admin/bots");
  $("#admin-table").innerHTML = `<table><thead><tr><th>机器人</th><th>所属用户</th><th>状态</th><th>模型</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
    ${list.map((b) => `<tr>
      <td>${esc(b.name)}</td><td>${esc(b.ownerName)}</td><td>${statusBadge(b.status)}</td>
      <td>${esc(b.llm.model || "")}</td><td>${fmtTime(b.updatedAt)}</td>
      <td class="opts"><button class="btn danger" onclick="adminDelBot('${b.id}','${esc(b.name)}')">删除</button></td>
      </tr>`).join("")}</tbody></table>`;
}
async function loadAdminInvites() {
  await loadAdminStats();
  const invites = await api("/api/admin/invites");
  $("#admin-table").innerHTML = `
    <div class="invite-gen">
      <input id="inv-count" type="number" value="5" min="1" max="50"> 个
      <input id="inv-note" type="text" placeholder="备注（可选）">
      <button class="btn primary" id="inv-gen-btn">生成邀请码</button>
    </div>
    <table><thead><tr><th>邀请码</th><th>备注</th><th>状态</th><th>使用者</th><th>使用时间</th><th>操作</th></tr></thead><tbody>
    ${invites.map((i) => `<tr>
      <td><code>${esc(i.code)}</code></td><td>${esc(i.note)}</td>
      <td>${i.enabled ? (i.used_at ? "已使用" : "可用") : "已禁用"}</td>
      <td>${esc(i.usedByName || "")}</td><td>${i.used_at ? fmtTime(i.used_at) : "—"}</td>
      <td class="opts">
        <button class="btn" onclick="adminToggleInvite('${i.code}')">${i.enabled ? "禁用" : "启用"}</button>
        <button class="btn danger" onclick="adminDelInvite('${i.code}')">删除</button>
      </td></tr>`).join("")}</tbody></table>`;
  $("#inv-gen-btn").onclick = async () => {
    try {
      const d = await api("/api/admin/invites", { method: "POST", body: JSON.stringify({ count: Number($("#inv-count").value) || 1, note: $("#inv-note").value }) });
      alert("已生成邀请码：\n" + d.created.join("\n"));
      loadAdminInvites();
    } catch (e) { alert(e.message); }
  };
}
window.adminPlan = async (id, plan) => {
  try {
    let days = 30;
    if (plan === "monthly") { days = Number(prompt("月卡天数（默认30）：", "30")) || 30; }
    await api(`/api/admin/users/${id}/plan`, { method: "POST", body: JSON.stringify({ plan, days }) });
    loadAdminUsers();
  } catch (e) { alert(e.message); }
};
window.adminStatus = async (id, status) => { try { await api(`/api/admin/users/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); loadAdminUsers(); } catch (e) { alert(e.message); } };
window.adminToggleInvite = async (code) => { try { await api(`/api/admin/invites/${code}/toggle`, { method: "POST" }); loadAdminInvites(); } catch (e) { alert(e.message); } };
window.adminDelInvite = async (code) => { if (confirm("删除该邀请码？")) { try { await api(`/api/admin/invites/${code}`, { method: "DELETE" }); loadAdminInvites(); } catch (e) { alert(e.message); } } };
async function loadAdminRedeems() {
  await loadAdminStats();
  const list = await api("/api/admin/redeems");
  $("#admin-table").innerHTML = `
    <div class="invite-gen">
      <input id="rc-count" type="number" value="5" min="1" max="50"> 个
      <select id="rc-type"><option value="monthly">月卡</option><option value="lifetime">买断</option></select>
      <input id="rc-days" type="number" value="30" min="1"> 天（月卡有效）
      <button class="btn primary" id="rc-gen-btn">生成卡密</button>
    </div>
    <table><thead><tr><th>卡密</th><th>类型</th><th>天数</th><th>状态</th><th>使用者</th><th>使用时间</th><th>操作</th></tr></thead><tbody>
    ${list.map((r) => `<tr>
      <td><code>${esc(r.code)}</code></td>
      <td>${r.type === "lifetime" ? "买断" : "月卡"}</td>
      <td>${r.type === "lifetime" ? "—" : r.days}</td>
      <td>${r.enabled ? (r.used_at ? "已使用" : "可用") : "已禁用"}</td>
      <td>${esc(r.usedByName || "")}</td><td>${r.used_at ? fmtTime(r.used_at) : "—"}</td>
      <td class="opts">
        <button class="btn" onclick="adminToggleRedeem('${r.code}')">${r.enabled ? "禁用" : "启用"}</button>
        <button class="btn danger" onclick="adminDelRedeem('${r.code}')">删除</button>
      </td></tr>`).join("")}</tbody></table>`;
  $("#rc-gen-btn").onclick = async () => {
    try {
      const d = await api("/api/admin/redeems", { method: "POST", body: JSON.stringify({ count: Number($("#rc-count").value) || 1, type: $("#rc-type").value, days: Number($("#rc-days").value) || 30 }) });
      alert("已生成充值卡密：\n" + d.created.join("\n"));
      loadAdminRedeems();
    } catch (e) { alert(e.message); }
  };
}
async function loadAdminSettings() {
  await loadAdminStats();
  const d = await api("/api/admin/settings");
  $("#admin-table").innerHTML = `
    <div class="setting-row"><span>强制邀请码注册（关闭则注册无需邀请码）</span>
      <input type="checkbox" id="set-invite" ${d.requireInvite ? "checked" : ""}>
      <button class="btn primary" id="set-save">保存</button></div>`;
  $("#set-save").onclick = async () => {
    try { await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ requireInvite: $("#set-invite").checked }) }); alert("已保存"); loadAdminSettings(); } catch (e) { alert(e.message); }
  };
}
window.adminToggleRedeem = async (code) => { try { await api(`/api/admin/redeems/${code}/toggle`, { method: "POST" }); loadAdminRedeems(); } catch (e) { alert(e.message); } };
window.adminDelRedeem = async (code) => { if (confirm("删除该卡密？")) { try { await api(`/api/admin/redeems/${code}`, { method: "DELETE" }); loadAdminRedeems(); } catch (e) { alert(e.message); } } };

window.adminDelBot = async (id, name) => { if (confirm("删除机器人「" + name + "」？")) { try { await api(`/api/bots/${id}`, { method: "DELETE" }); loadAdminBots(); } catch (e) { alert(e.message); } } };

// ============ 启动 ============
(async () => {
  await Promise.all([loadCaptcha("login"), loadCaptcha("reg")]);
  await refreshRequireInvite();
  if (token) { try { await enterDashboard(); return; } catch { token = ""; localStorage.removeItem(TOKEN_KEY); } }
  show("auth"); switchTab(true);
})();
