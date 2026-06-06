const els = {
  configStatus: document.querySelector("#configStatus"),
  apiBaseUrl: document.querySelector("#adminApiBaseUrl"),
  apiKey: document.querySelector("#adminApiKey"),
  imageModel: document.querySelector("#adminImageModel"),
  llmModel: document.querySelector("#adminLlmModel"),
  saveConfig: document.querySelector("#saveAdminConfigBtn"),
  testConfig: document.querySelector("#testAdminConfigBtn"),
  newUsername: document.querySelector("#newUsername"),
  newPassword: document.querySelector("#newPassword"),
  newRole: document.querySelector("#newRole"),
  newLimitEdit: document.querySelector("#newLimitEdit"),
  newLimitMain: document.querySelector("#newLimitMain"),
  newLimitDevelop: document.querySelector("#newLimitDevelop"),
  newLimitClone: document.querySelector("#newLimitClone"),
  createUser: document.querySelector("#createUserBtn"),
  userFilter: document.querySelector("#userFilter"),
  applicationCount: document.querySelector("#applicationCount"),
  applicationsTable: document.querySelector("#applicationsTable"),
  usersTable: document.querySelector("#usersTable"),
  usageList: document.querySelector("#usageList"),
  securityNotice: document.querySelector("#securityNotice"),
  logout: document.querySelector("#adminLogoutBtn"),
  adminTabs: document.querySelectorAll("[data-admin-tab]"),
  adminPanels: document.querySelectorAll("[data-admin-panel]"),
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401) {
    location.href = "/login";
    return null;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const moduleDefs = [
  ["edit", "提示词做图"],
  ["main", "以图做图"],
  ["develop", "产品开发"],
  ["clone", "克隆详情"],
];

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatLimit(value) {
  const number = Number(value ?? -1);
  if (number < 0) return "不限";
  if (number === 0) return "禁用";
  return `${number} 次`;
}

function showAdminPanel(name) {
  els.adminTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.adminTab === name);
  });
  els.adminPanels.forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== name;
  });
}

function readNewLimits() {
  return {
    edit: Number(els.newLimitEdit.value || -1),
    main: Number(els.newLimitMain.value || -1),
    develop: Number(els.newLimitDevelop.value || -1),
    clone: Number(els.newLimitClone.value || -1),
  };
}

function renderLimitInputs(user) {
  const limits = user.limits || {};
  const used = user.usage?.modules || {};
  return `
    <div class="module-limit-grid inline-limits">
      ${moduleDefs.map(([key, label]) => `
        <label class="field">
          <span>${label} <em>已用 ${used[key] || 0}</em></span>
          <input type="number" min="-1" value="${Number(limits[key] ?? -1)}" data-limit-key="${key}" data-user-id="${user.id}">
        </label>
      `).join("")}
    </div>
    <p class="empty-note">-1 不限次，0 禁用，正数为可生成次数。</p>
  `;
}

function renderLimitCell(user, key) {
  const limit = Number(user.limits?.[key] ?? -1);
  const used = Number(user.usage?.modules?.[key] || 0);
  return `
    <label class="limit-cell">
      <span>${used}/${formatLimit(limit)}</span>
      <input type="number" min="-1" value="${limit}" data-limit-key="${key}" data-user-id="${user.id}">
    </label>
  `;
}

function updateUserFilter(users) {
  const current = els.userFilter.value || "all";
  els.userFilter.innerHTML = `<option value="all">全部用户</option>${users.map((user) => (
    `<option value="${user.id}">${escapeHtml(user.username)}</option>`
  )).join("")}`;
  els.userFilter.value = users.some((user) => String(user.id) === current) ? current : "all";
}

async function loadConfig() {
  const config = await api("/api/admin/config");
  if (!config) return;
  els.apiBaseUrl.value = config.apiBaseUrl || "";
  els.imageModel.value = config.imageModel || "";
  els.llmModel.value = config.llmModel || "";
  els.configStatus.textContent = config.hasApiKey ? `已配置 Key：${config.apiKeyMask}` : "未配置 Key";
}

async function saveConfig() {
  els.saveConfig.disabled = true;
  try {
    const config = await api("/api/admin/config", {
      method: "POST",
      body: JSON.stringify({
        apiBaseUrl: els.apiBaseUrl.value.trim(),
        apiKey: els.apiKey.value.trim(),
        imageModel: els.imageModel.value.trim(),
        llmModel: els.llmModel.value.trim(),
      }),
    });
    els.apiKey.value = "";
    els.configStatus.textContent = config.hasApiKey ? `已保存：${config.apiKeyMask}` : "未配置 Key";
    alert("API 配置已保存");
  } catch (error) {
    alert(error.message);
  } finally {
    els.saveConfig.disabled = false;
  }
}

async function testConfig() {
  els.testConfig.disabled = true;
  try {
    const result = await api("/api/test-openai");
    alert(`连接成功：${result.apiBaseUrl || ""}`);
  } catch (error) {
    alert(error.message);
  } finally {
    els.testConfig.disabled = false;
  }
}

async function loadUsers() {
  const result = await api("/api/admin/users");
  if (!result) return;
  const allUsers = result.users || [];
  renderApplications(result.applications || []);
  updateUserFilter(allUsers);
  const selectedUserId = els.userFilter.value || "all";
  const users = selectedUserId === "all"
    ? allUsers
    : allUsers.filter((user) => String(user.id) === selectedUserId);
  els.usersTable.innerHTML = users.length ? `
    <div class="admin-user-table">
      <div class="admin-user-head">
        <span>账号</span>
        <span>角色 / 状态</span>
        <span>联系方式</span>
        <span>申请说明</span>
        <span>创建时间</span>
        <span>总用量</span>
        <span>提示词</span>
        <span>以图</span>
        <span>开发</span>
        <span>克隆</span>
        <span>操作</span>
      </div>
      ${users.map((user) => `
        <div class="admin-user-row">
          <div>
            <strong>${escapeHtml(user.username)}</strong>
            <small>ID ${escapeHtml(user.id)}</small>
            ${user.mustChangePassword ? "<em>需改默认密码</em>" : ""}
          </div>
          <div>
            <span>${escapeHtml(user.role === "admin" ? "管理员" : "普通用户")}</span>
            <small>${escapeHtml(user.status === "active" ? "启用" : "禁用")}</small>
          </div>
          <div>${escapeHtml(user.contact || "-")}</div>
          <div class="note-cell" title="${escapeHtml(user.note || "")}">${escapeHtml(user.note || "-")}</div>
          <div>${escapeHtml(formatDate(user.createdAt))}</div>
          <div>
            <span>分析 ${user.usage?.analyze || 0}</span>
            <small>生成 ${user.usage?.generate || 0}</small>
          </div>
          <div>${renderLimitCell(user, "edit")}</div>
          <div>${renderLimitCell(user, "main")}</div>
          <div>${renderLimitCell(user, "develop")}</div>
          <div>${renderLimitCell(user, "clone")}</div>
          <div class="row-actions compact-actions">
            <button type="button" data-action="toggle" data-id="${user.id}" data-status="${user.status}">${user.status === "active" ? "禁用" : "启用"}</button>
            <button type="button" data-action="role" data-id="${user.id}" data-role="${user.role}">${user.role === "admin" ? "设普通" : "设管理"}</button>
            <button type="button" data-action="limits" data-id="${user.id}">保存</button>
            <button type="button" data-action="password" data-id="${user.id}">密码</button>
            <button type="button" data-action="delete" data-id="${user.id}" class="danger">删除</button>
          </div>
        </div>
      `).join("")}
    </div>
  ` : "<p class=\"empty-note\">暂无用户</p>";
  els.securityNotice.hidden = !allUsers.some((user) => user.username === "admin" && user.mustChangePassword);
  els.usageList.innerHTML = result.usageLogs.length
    ? result.usageLogs.map((log) => `<div>${escapeHtml(log.createdAt)} · ${escapeHtml(log.username)} · ${escapeHtml(log.action)}</div>`).join("")
    : "<p>暂无记录</p>";
}

function renderApplications(applications) {
  els.applicationCount.textContent = `${applications.length} 个待审核`;
  if (!applications.length) {
    els.applicationsTable.innerHTML = "<p class=\"empty-note\">暂无账号申请</p>";
    return;
  }
  els.applicationsTable.innerHTML = applications.map((item) => `
    <div class="admin-row">
      <div>
        <strong>${escapeHtml(item.username)}</strong>
        <span>${escapeHtml(item.contact || "未填联系方式")} · ${escapeHtml(item.createdAt || "")}</span>
        ${item.note ? `<em>${escapeHtml(item.note)}</em>` : ""}
      </div>
      <div class="row-actions">
        <button type="button" data-application-action="approve" data-id="${escapeHtml(item.id)}">通过</button>
        <button type="button" data-application-action="reject" data-id="${escapeHtml(item.id)}" class="danger">拒绝</button>
      </div>
    </div>
  `).join("");
}

async function createUser() {
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: els.newUsername.value.trim(),
        password: els.newPassword.value,
        role: els.newRole.value,
        limits: readNewLimits(),
      }),
    });
    els.newUsername.value = "";
    els.newPassword.value = "";
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
}

els.usersTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  try {
    if (action === "delete") {
      if (!confirm("确定删除这个用户？")) return;
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
    } else if (action === "toggle") {
      await api(`/api/admin/users/${id}`, {
        method: "POST",
        body: JSON.stringify({ status: button.dataset.status === "active" ? "disabled" : "active" }),
      });
    } else if (action === "role") {
      await api(`/api/admin/users/${id}`, {
        method: "POST",
        body: JSON.stringify({ role: button.dataset.role === "admin" ? "user" : "admin" }),
      });
    } else if (action === "password") {
      const password = prompt("输入新密码，至少 6 位");
      if (!password) return;
      await api(`/api/admin/users/${id}`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
    } else if (action === "limits") {
      const row = button.closest(".admin-user-row");
      const limits = {};
      row.querySelectorAll("[data-limit-key]").forEach((input) => {
        limits[input.dataset.limitKey] = Number(input.value || -1);
      });
      await api(`/api/admin/users/${id}`, {
        method: "POST",
        body: JSON.stringify({ limits }),
      });
    }
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
});

els.applicationsTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-application-action]");
  if (!button) return;
  const action = button.dataset.applicationAction;
  if (action === "reject" && !confirm("确定拒绝这个账号申请？")) return;
  try {
    await api(`/api/admin/applications/${button.dataset.id}/${action}`, { method: "POST" });
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
});

els.saveConfig.addEventListener("click", saveConfig);
els.testConfig.addEventListener("click", testConfig);
els.createUser.addEventListener("click", createUser);
els.userFilter.addEventListener("change", loadUsers);
els.adminTabs.forEach((button) => {
  button.addEventListener("click", () => showAdminPanel(button.dataset.adminTab));
});
els.logout.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/login";
});

loadConfig();
loadUsers();
