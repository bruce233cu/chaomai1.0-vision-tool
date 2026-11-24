const http = require("http");
const https = require("https");
const tls = require("tls");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createHeroApi } = require("./hero-api");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const rootWithSep = path.resolve(root) + path.sep;
const configPath = path.join(root, "api-config.local.json");
const authPath = path.join(root, "auth.local.json");
const historyPath = path.join(root, "history.local.json");
const historyAssetsDir = path.join(root, "history-assets");
const lastResponsePath = path.join(root, "last-api-response.json");
const explicitProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.OPENAI_PROXY || "";
const savedConfig = loadSavedConfig();
const apiConfig = {
  apiKey: normalizeSavedApiKey(process.env.OPENAI_API_KEY || savedConfig.apiKey || ""),
  apiBaseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || savedConfig.apiBaseUrl || "https://api.openai.com/v1"),
  imageModel: process.env.OPENAI_IMAGE_MODEL || savedConfig.imageModel || "gpt-image-1.5",
  llmModel: process.env.OPENAI_LLM_MODEL || savedConfig.llmModel || "",
};
const heroApi = createHeroApi({ apiConfig, proxyFetch, readApiResult, extractTextResult });
const heroRenders = new Set();
const MODULE_KEYS = ["edit", "main", "develop", "clone"];
const MODULE_LABELS = {
  edit: "提示词做图",
  main: "以图做图",
  develop: "产品开发",
  clone: "克隆详情",
};
const authStore = loadAuthStore();
const historyStore = loadHistoryStore();
const sessions = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const publicStaticFiles = new Set([
  "index.html",
  "login.html",
  "admin.html",
  "styles.css",
  "app.js",
  "admin.js",
  "hero.html",
  "hero-core.js",
  "hero.js",
  "hero.css",
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function loadAuthStore() {
  try {
    if (fs.existsSync(authPath)) {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (Array.isArray(parsed.users)) {
        parsed.users = parsed.users.map(normalizeUserRecord);
        parsed.pendingApplications = Array.isArray(parsed.pendingApplications) ? parsed.pendingApplications : [];
        parsed.usageLogs = Array.isArray(parsed.usageLogs) ? parsed.usageLogs : [];
        parsed.nextUserId = Number(parsed.nextUserId || 2);
        return parsed;
      }
    }
  } catch (error) {
    // Fall through and recreate a usable auth file.
  }
  const now = new Date().toISOString();
  const store = {
    nextUserId: 2,
    users: [{
      id: 1,
      username: "admin",
      passwordHash: hashPassword("admin123"),
      role: "admin",
      status: "active",
      mustChangePassword: true,
      limits: defaultModuleLimits(),
      createdAt: now,
    }],
    pendingApplications: [],
    usageLogs: [],
  };
  saveAuthStore(store);
  console.log("Default admin created: admin / admin123. Please change it after login.");
  return store;
}

function saveAuthStore(store = authStore) {
  fs.writeFileSync(authPath, JSON.stringify(store, null, 2), "utf8");
}

function createEmptyHistoryBuckets() {
  return { edit: [], main: [], develop: [], clone: [] };
}

function loadHistoryStore() {
  try {
    if (!fs.existsSync(historyPath)) {
      return { users: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    const users = parsed && typeof parsed === "object" ? parsed.users || {} : {};
    const normalizedUsers = {};
    Object.entries(users).forEach(([userId, modes]) => {
      normalizedUsers[String(userId)] = normalizeHistoryBuckets(modes);
    });
    return { users: normalizedUsers };
  } catch (error) {
    return { users: {} };
  }
}

function saveHistoryStore(store = historyStore) {
  fs.writeFileSync(historyPath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeHistoryBuckets(input = {}) {
  const buckets = createEmptyHistoryBuckets();
  MODULE_KEYS.forEach((mode) => {
    const items = Array.isArray(input[mode]) ? input[mode] : [];
    buckets[mode] = items
      .map((item) => normalizeHistoryEntry(item, mode))
      .filter(Boolean)
      .slice(0, 12);
  });
  return buckets;
}

function normalizeHistoryEntry(item, mode) {
  if (!item || typeof item !== "object") return null;
  if (!item.id || !item.fileName) return null;
  return {
    id: String(item.id),
    label: String(item.label || MODULE_LABELS[mode] || "最新"),
    fileName: String(item.fileName),
    mimeType: String(item.mimeType || "image/png"),
    createdAt: String(item.createdAt || new Date().toISOString()),
  };
}

function getUserHistoryBuckets(userId) {
  const key = String(userId);
  if (!historyStore.users[key]) {
    historyStore.users[key] = createEmptyHistoryBuckets();
  }
  return historyStore.users[key];
}

function historyAssetUrl(userId, fileName) {
  return `/api/history/assets/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(fileName))}`;
}

function getUserHistoryPayload(user) {
  const buckets = normalizeHistoryBuckets(getUserHistoryBuckets(user.id));
  const payload = {};
  MODULE_KEYS.forEach((mode) => {
    payload[mode] = buckets[mode].map((item) => ({
      id: item.id,
      label: item.label,
      mode,
      time: item.createdAt,
      src: historyAssetUrl(user.id, item.fileName),
    }));
  });
  return payload;
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    // Ignore cleanup failures.
  }
}

function persistHistoryImage(user, mode, imageSrc, label) {
  const image = parseDataUrl(imageSrc);
  const userDir = path.join(historyAssetsDir, String(user.id));
  fs.mkdirSync(userDir, { recursive: true });
  const extension = image.fileName.split(".").pop() || "png";
  const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(userDir, fileName), image.buffer);

  const buckets = getUserHistoryBuckets(user.id);
  const bucket = buckets[mode] || (buckets[mode] = []);
  bucket.unshift({
    id: crypto.randomUUID(),
    label: String(label || MODULE_LABELS[mode] || "最新"),
    fileName,
    mimeType: image.mimeType,
    createdAt: new Date().toISOString(),
  });

  while (bucket.length > 12) {
    const removed = bucket.pop();
    if (removed?.fileName) {
      safeUnlink(path.join(userDir, removed.fileName));
    }
  }

  saveHistoryStore();
}

function clearHistoryForUser(user, mode) {
  const buckets = getUserHistoryBuckets(user.id);
  const modes = mode ? [mode] : MODULE_KEYS;
  const userDir = path.join(historyAssetsDir, String(user.id));
  modes.forEach((key) => {
    const bucket = Array.isArray(buckets[key]) ? buckets[key] : [];
    bucket.forEach((item) => {
      if (item?.fileName) safeUnlink(path.join(userDir, item.fileName));
    });
    buckets[key] = [];
  });
  saveHistoryStore();
}

function resolveHistoryAssetPath(ownerId, fileName) {
  const safeOwner = String(ownerId || "").trim();
  const safeFileName = path.basename(String(fileName || "").trim());
  if (!safeOwner || !safeFileName) return "";
  const assetPath = path.resolve(historyAssetsDir, safeOwner, safeFileName);
  const ownerDir = path.resolve(historyAssetsDir, safeOwner) + path.sep;
  return assetPath.startsWith(ownerDir) ? assetPath : "";
}

function defaultModuleLimits() {
  return { edit: -1, main: -1, develop: -1, clone: -1 };
}

function normalizeModuleLimits(input = {}) {
  const limits = defaultModuleLimits();
  MODULE_KEYS.forEach((key) => {
    if (input[key] === undefined || input[key] === null || input[key] === "") return;
    const value = Number(input[key]);
    limits[key] = Number.isFinite(value) ? Math.max(-1, Math.floor(value)) : -1;
  });
  return limits;
}

function normalizeUserRecord(user) {
  user.limits = normalizeModuleLimits(user.limits);
  return user;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  const input = crypto.scryptSync(String(password || ""), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), input);
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index === -1) return cookies;
      cookies[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
      return cookies;
    }, {});
}

function createSession(user, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  sessions.set(token, { userId: user.id, expiresAt });
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`);
}

function clearSession(req, res) {
  const token = parseCookies(req).session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function getCurrentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = authStore.users.find((item) => item.id === session.userId && item.status === "active");
  return user || null;
}

function publicUser(user) {
  if (!user) return null;
  const usage = getUserUsage(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    limits: normalizeModuleLimits(user.limits),
    usage,
    contact: user.contact || "",
    note: user.note || "",
    createdAt: user.createdAt,
  };
}

function getUserUsage(userId) {
  return authStore.usageLogs.reduce((stats, log) => {
    if (log.userId !== userId) return stats;
    stats.total += 1;
    if (log.action === "analyze") stats.analyze += 1;
    if (log.action === "generate") stats.generate += 1;
    if (log.action === "generate" && MODULE_KEYS.includes(log.mode)) {
      stats.modules[log.mode] += 1;
    }
    return stats;
  }, { total: 0, analyze: 0, generate: 0, modules: { edit: 0, main: 0, develop: 0, clone: 0 } });
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录" });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "需要管理员权限" });
    return null;
  }
  return user;
}

function logUsage(user, action, mode = "") {
  authStore.usageLogs.unshift({
    id: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    action,
    mode,
    moduleLabel: MODULE_LABELS[mode] || "",
    createdAt: new Date().toISOString(),
  });
  authStore.usageLogs = authStore.usageLogs.slice(0, 500);
  saveAuthStore();
}

function normalizeTaskMode(mode) {
  return MODULE_KEYS.includes(mode) ? mode : "main";
}

function assertCanGenerate(user, mode) {
  if (user.role === "admin") return;
  const taskMode = normalizeTaskMode(mode);
  const limits = normalizeModuleLimits(user.limits);
  const limit = limits[taskMode];
  if (limit < 0) return;
  const used = getUserUsage(user.id).modules[taskMode] || 0;
  if (used >= limit) {
    throw new Error(`${MODULE_LABELS[taskMode]} 可用次数已用完，请联系管理员调整额度`);
  }
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(dataUrl || "");
  if (!match) {
    throw new Error("图片格式不正确，请上传 png、jpg 或 webp");
  }
  const mimeType = match[1].replace("image/jpg", "image/jpeg");
  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  return {
    buffer: Buffer.from(match[2], "base64"),
    mimeType,
    fileName: `product.${ext}`,
  };
}

function ensureApiReady() {
  if (!apiConfig.apiKey) {
    throw new Error("缺少 API Key，请先在页面的 API 配置里保存中转站 Key");
  }
}

function resolveImageSize(aspectRatio) {
  const ratio = String(aspectRatio || "1:1").trim();
  const sizeMap = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
    "9:16": "1024x1536",
    "16:9": "1536x1024",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
    "21:9": "1536x1024",
  };
  return sizeMap[ratio] || "1024x1024";
}

function buildUserControlLines(payload) {
  const styleLabels = {
    clean: "高点击清爽版",
    premium: "高级质感版",
    functional: "卖点强化版",
    scene: "真实场景版",
  };
  const modelLabels = {
    auto: "根据竞品自动建议",
    none: "无模特，仅产品",
    partial: "局部手持/半身辅助",
    full: "完整人物场景",
  };
  const angleLabels = {
    auto: "根据竞品自动建议",
    front: "正面主视角",
    side: "侧面/斜侧角度",
    close: "材质细节特写",
    combo: "多角度组合",
  };
  const bgLabels = {
    auto: "根据竞品自动建议",
    plain: "干净纯色/浅色空间",
    scene: "真实生活场景",
    premium: "高级质感棚拍",
    functional: "功能卖点场景",
  };
  return [
    `画幅比例：${payload.aspectRatio || "1:1"}`,
    `优化风格：${styleLabels[payload.styleMode] || payload.styleMode || "根据竞品自动建议"}`,
    `模特/人物：${modelLabels[payload.modelMode] || payload.modelMode || "根据竞品自动建议"}`,
    `产品角度：${angleLabels[payload.angleMode] || payload.angleMode || "根据竞品自动建议"}`,
    `背景场景：${bgLabels[payload.backgroundMode] || payload.backgroundMode || "根据竞品自动建议"}`,
  ];
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim() || "https://api.openai.com/v1";
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "") {
    url.pathname = "/v1";
  } else if (!url.pathname.endsWith("/v1")) {
    url.pathname = `${url.pathname}/v1`;
  }
  return url.toString().replace(/\/$/, "");
}

function loadSavedConfig() {
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return {};
  }
}

function normalizeSavedApiKey(value) {
  const key = String(value || "").trim();
  return /^https?:\/\//i.test(key) ? "" : key;
}

function saveConfig() {
  const content = JSON.stringify({
    apiKey: apiConfig.apiKey,
    apiBaseUrl: apiConfig.apiBaseUrl,
    imageModel: apiConfig.imageModel,
    llmModel: apiConfig.llmModel,
  }, null, 2);
  fs.writeFileSync(configPath, content, "utf8");
}

function getProxyForUrl(url) {
  if (explicitProxyUrl) return explicitProxyUrl;
  const host = new URL(url).hostname;
  return /(^|\.)openai\.com$/i.test(host) ? "http://127.0.0.1:7892" : "";
}

function getPublicConfig() {
  return {
    hasApiKey: Boolean(apiConfig.apiKey),
    apiBaseUrl: apiConfig.apiBaseUrl,
    imageModel: apiConfig.imageModel,
    llmModel: apiConfig.llmModel,
    apiKeyMask: maskApiKey(apiConfig.apiKey),
  };
}

function maskApiKey(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return "疑似填错：当前是网址";
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

function isValidUsername(username) {
  return /^[\p{L}\p{N}_-]{2,32}$/u.test(String(username || ""));
}

function validateApiConfigInput(payload) {
  const nextKey = String(payload.apiKey || "").trim();
  const nextBaseUrl = String(payload.apiBaseUrl || "").trim();
  if (nextKey && /^https?:\/\//i.test(nextKey)) {
    throw new Error("API Key 不能是网址。请把中转站给你的 Key 填到 API Key，把 https://... 填到 API 地址。");
  }
  if (nextBaseUrl && !/^https?:\/\//i.test(nextBaseUrl)) {
    throw new Error("API 地址必须以 http:// 或 https:// 开头。");
  }
}

function getOwnImageSet(payload, limit = 4) {
  const images = [];
  const primary = String(payload.ownImage || "").trim();
  if (primary) {
    images.push(primary);
  }
  if (Array.isArray(payload.ownImages)) {
    payload.ownImages.forEach((src) => {
      const normalized = String(src || "").trim();
      if (normalized && !images.includes(normalized)) {
        images.push(normalized);
      }
    });
  }
  return images.slice(0, limit);
}

async function generateImage(payload) {
  ensureApiReady();
  const imageSize = resolveImageSize(payload.aspectRatio);
  const strictReplacementMode = payload.sourceMode === "two-image-replacement";
  const ownImages = getOwnImageSet(payload, 4);
  const primaryOwnImage = ownImages[0] || "";

  if (!primaryOwnImage) {
    const response = await proxyFetch(`${apiConfig.apiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: apiConfig.imageModel,
        prompt: payload.prompt,
        size: imageSize,
        quality: "high",
        n: 1,
      }),
    });
    const result = await readApiResult(response);
    if (!response.ok) {
      const message = result.error?.message || result.error || `OpenAI API 请求失败：${response.status}`;
      throw new Error(message);
    }
    saveLastApiResponse(result);
    const imageResult = await finalizeImageResult(extractImageResult(result));
    if (imageResult) return imageResult;
    throw new Error(`API 没有返回可识别的图片数据。返回字段：${summarizeApiShape(result)}`);
  }

  const image = parseDataUrl(primaryOwnImage);
  const form = new FormData();
  form.append("model", apiConfig.imageModel);
  form.append("size", imageSize);
  form.append("quality", "high");
  form.append("n", "1");
  form.append("prompt", payload.prompt);
  form.append("image", new Blob([image.buffer], { type: image.mimeType }), image.fileName);
  ownImages.slice(1).forEach((src, index) => {
    if (!src) return;
    const ref = parseDataUrl(src);
    form.append("image", new Blob([ref.buffer], { type: ref.mimeType }), `product-view-${index + 2}.${ref.fileName.split(".").pop() || "png"}`);
  });
  if (Array.isArray(payload.referenceImages)) {
    payload.referenceImages.slice(0, 4).forEach((src, index) => {
      if (!src) return;
      const ref = parseDataUrl(src);
      form.append("image", new Blob([ref.buffer], { type: ref.mimeType }), `reference-${index + 1}.${ref.fileName.split(".").pop() || "png"}`);
    });
  }

  let response;
  try {
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      body: form,
    });
  } catch (error) {
    throw new Error(`连接 OpenAI API 失败。通常是网络、代理或防火墙问题。原始错误：${error.message}`);
  }

  let result = await readApiResult(response);
  if (!strictReplacementMode && ownImages.length <= 1 && !response.ok && shouldFallbackToGeneration(result)) {
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: apiConfig.imageModel,
        prompt: `${payload.prompt}\n\n参考用户上传的原始商品图，生成同款商品的真实商业摄影主图。`,
        size: imageSize,
        quality: "high",
        n: 1,
      }),
    });
    result = await readApiResult(response);
  }

  if (!response.ok) {
    const message = result.error?.message || result.error || `OpenAI API 请求失败：${response.status}`;
    throw new Error(message);
  }

  saveLastApiResponse(result);
  const imageResult = await finalizeImageResult(extractImageResult(result));
  if (imageResult) return imageResult;

  if (typeof result.error === "string") {
    throw new Error(`API 返回错误：${result.error}`);
  }

  throw new Error(`API 没有返回可识别的图片数据。返回字段：${summarizeApiShape(result)}`);
}

async function analyzeImages(payload) {
  ensureApiReady();
  if (!apiConfig.llmModel) {
    throw new Error("缺少 LLM 模型，请在设置里填写支持视觉分析的 LLM 模型");
  }
  const ownImages = getOwnImageSet(payload, 4);
  if (!ownImages.length || !Array.isArray(payload.competitorImages) || payload.competitorImages.length === 0) {
    throw new Error("请上传自己的主图和至少 1 张竞品图");
  }

  const ownProductParts = ownImages.flatMap((src, index) => ([
    { type: "text", text: index === 0 ? "用户自己的当前产品图（主视角）" : `同一产品的补充角度 ${index + 1}` },
    { type: "image_url", image_url: { url: src } },
  ]));

  const competitorParts = payload.competitorImages.slice(0, 9).flatMap((src, index) => ([
    { type: "text", text: `竞品主图 ${index + 1}` },
    { type: "image_url", image_url: { url: src } },
  ]));

  const requestBody = {
    model: apiConfig.llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "你是资深电商视觉策略专家，擅长分析淘宝/电商搜索流主图。只输出 JSON，不要输出 Markdown。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildAnalysisInstruction(payload),
          },
          ...ownProductParts,
          ...competitorParts,
        ],
      },
    ],
  };

  let response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  let result = await readApiResult(response);
  if (!response.ok && shouldRetryAnalysis(result)) {
    await sleep(1400);
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    result = await readApiResult(response);
  }
  if (!response.ok) {
    const message = result.error?.message || result.error || `视觉分析 API 请求失败：${response.status}`;
    throw new Error(message);
  }

  const content = extractTextResult(result);
  const analysis = parseJsonOrPromptPayload(content);
  return normalizeAnalysisResult(analysis, payload);
}

async function analyzeEditReference(payload) {
  ensureApiReady();
  if (!apiConfig.llmModel) {
    throw new Error("缺少 LLM 模型，请在设置里填写支持视觉分析的 LLM 模型");
  }
  const inspirationImages = Array.isArray(payload.referenceImages)
    ? payload.referenceImages.filter(Boolean).slice(0, 4)
    : payload.referenceImage
      ? [payload.referenceImage]
      : [];

  const requestBody = {
    model: apiConfig.llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "你是资深电商广告 Prompt 编译总监兼高级提示词架构师，擅长把简短用户需求、产品图和参考图优点，编译成高完成度的英文电商广告 Prompt。只输出 JSON，不要输出 Markdown。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildEditPlanInstruction(payload),
          },
          ...(payload.productImage ? [
            { type: "text", text: "锁定产品图（最终出图必须保持该产品绝对不变形）" },
            { type: "image_url", image_url: { url: payload.productImage } },
          ] : []),
          ...inspirationImages.flatMap((url, index) => ([
            { type: "text", text: `灵感参考图 ${index + 1}` },
            { type: "image_url", image_url: { url } },
          ])),
        ],
      },
    ],
  };

  let response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  let result = await readApiResult(response);
  if (!response.ok && shouldRetryAnalysis(result)) {
    await sleep(1400);
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    result = await readApiResult(response);
  }
  if (!response.ok) {
    const message = result.error?.message || result.error || `视觉分析 API 请求失败：${response.status}`;
    throw new Error(message);
  }

  const content = extractTextResult(result);
  if (!content) {
    return normalizeEditPlan({}, payload);
  }

  try {
    const plan = parseJsonFromText(content);
    return normalizeEditPlan(plan, payload);
  } catch (error) {
    return normalizeEditPlan({}, payload);
  }
}

async function analyzeReplacementTask(payload) {
  ensureApiReady();
  if (!apiConfig.llmModel) {
    throw new Error("Missing LLM model for replacement planning");
  }
  if (!payload.templateImage || !payload.replacementImage) {
    throw new Error("Double-image replacement requires both a template image and a replacement product image");
  }

  const requestBody = {
    model: apiConfig.llmModel,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You are a senior commercial image replacement planner. Your task is to inspect the template scene and the replacement product image, then compile one strict English GPT-Image edit prompt that replaces only the target product while preserving the rest of the scene.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildReplacementPlanInstruction(payload),
          },
          { type: "text", text: `User-designated locked template scene (uploaded image ${payload.templateIndex || 1})` },
          { type: "image_url", image_url: { url: payload.templateImage } },
          { type: "text", text: `User-designated replacement product source (uploaded image ${payload.replacementIndex || 2})` },
          { type: "image_url", image_url: { url: payload.replacementImage } },
        ],
      },
    ],
  };

  let response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  let result = await readApiResult(response);
  if (!response.ok && shouldRetryAnalysis(result)) {
    await sleep(1400);
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    result = await readApiResult(response);
  }
  if (!response.ok) {
    const message = result.error?.message || result.error || `Replacement planning failed: ${response.status}`;
    throw new Error(message);
  }

  const content = extractTextResult(result);
  if (!content) {
    return normalizeReplacementPlan({}, payload);
  }

  try {
    const plan = parseJsonFromText(content);
    return normalizeReplacementPlan(plan, payload);
  } catch (error) {
    return normalizeReplacementPlan({}, payload);
  }
}

function buildAnalysisInstruction(payload) {
  const isDevelop = payload.taskMode === "develop";
  if (isDevelop) {
    return [
      `?????${payload.productName || "???"}` ,
      `??? / ???${payload.keywords || "???"}` ,
      `??????????${payload.aspectRatio || "1:1"}` ,
      "??????????????? generationPrompt???????????",
      "",
      "??????????????????????????????????????????????",
      "?????????????????????????????????????????????",
      "???? JSON??????",
      "{",
      "  \"scores\": {\"overall\": number, \"background\": number, \"focus\": number},",
      "  \"competitorAdvantages\": [\"??????????????/??/??/??/??/??/????\"],",
      "  \"competitorWeaknesses\": [\"??????????????????\"],",
      "  \"commonPatterns\": [\"?????????????????????????????????\"],",
      "  \"ownGaps\": [\"???????????????????????????\"],",
      "  \"strategy\": [\"????????????????\"],",
      "  \"creative\": {\"model\": \"???????????\", \"angle\": \"????????\", \"background\": \"????????\", \"subjectRatio\": \"????????\"},",
      "  \"promptVariants\": [{\"title\": \"?????????????\", \"focus\": \"?????????????\", \"prompt\": \"?????????/??????????????????????\"}],",
      "  \"generationPrompt\": \"?????/???????????????????????????????????????????????????\"",
      "}",
      "????????????????? 2-3 ? promptVariants?promptVariants ????????????????????????????????/???????????????????????????????????????????????",
    ].join("\n");
  }

  return [
    "You are a top-tier e-commerce visual director with elite commercial taste, blockbuster main-image deconstruction ability, and expert prompt engineering skills for GPT-Image, Midjourney, and Stable Diffusion.",
    "",
    "I will give you:",
    "1. one or more images of the user's own product / current product, which may include multiple angles of the same exact product",
    "2. one or more competitor reference images",
    "",
    "Your task is not to copy the competitor image. Your task is to deeply deconstruct the real commercial strengths behind the competitor reference image, then translate those strengths into one high-finish English generationPrompt that can be used directly in GPT-Image to upgrade the user's own product image.",
    "",
    "Your final goal is not to make the result look identical to the reference image. Your final goal is to keep the user's product identity and key details correct, while absorbing the reference image's product proportion, human-product-scene relationship, composition, lighting, camera language, layout rhythm, premium mood, and click-through logic, so the final output feels more like a mature branded marketplace advertisement.",
    "",
    "You must strictly follow the rules below.",
    "",
    "Section 1: about the user's own product (highest priority)",
    "1. The user's product must be treated as a locked proprietary product layer / fixed product identity.",
    "2. The product's exact silhouette, exact structure, exact proportions, exact material segmentation, exact color blocking, exact zipper placement, exact straps, exact pockets, exact hardware, exact tags, exact seams, exact outline, and all product-defining identity details must remain consistent.",
    "2.5. If multiple own product images are provided, they are different angles of the same exact product. You must fuse them into one single locked product identity and use them together to preserve cross-view consistency in the final result.",
    "3. You must never turn the user's product into another product, and you must never alter the product-defining identity.",
    "4. However, you must understand this clearly: the product identity is locked, but the presentation relationship may be rebuilt according to the reference image logic.",
    "5. That means if the reference image shows the product on a model's back, in a hand, on a tabletop, on a display platform, in an outdoor travel context, or in a lifestyle scene, then the final generationPrompt may allow the user's own product to enter the same type of commercial relationship naturally.",
    "6. In other words: product identity must stay locked, but the display method, product proportion, composition relationship, model relationship, lighting relationship, and camera relationship should follow the deconstructed logic of the reference image.",
    "",
    "Section 2: about the competitor reference image",
    "1. The competitor reference image is for deconstruction only and must never be copied directly.",
    "2. You are not allowed to copy brand names, logos, original copywriting, prices, campaign texts, watermarks, QR codes, store information, or trademark-like typography from the reference image.",
    "3. You are allowed to absorb:",
    "- product proportion in frame",
    "- product-to-model scale relationship",
    "- product-to-camera distance relationship",
    "- product-to-background and product-to-layout-zone relationship",
    "- composition structure and visual flow",
    "- lighting logic and camera language",
    "- depth, background layering, and blur handling",
    "- rhythm of headline area, feature area, badge area, promo area, CTA area, and negative space",
    "- commercial mood, lifestyle projection, marketplace click appeal, and thumbnail readability",
    "",
    "Section 3: you must deeply deconstruct the reference image across these dimensions",
    "1. sceneTone",
    "- what kind of commercial scene this is",
    "- what consumer imagination it builds",
    "- why it feels premium, attractive, trustworthy, lightweight, aspirational, or worth clicking",
    "- how the scene supports product selling points instead of stealing attention",
    "",
    "2. hierarchy",
    "- how headline, feature, icon, promo, CTA, and empty space are organized",
    "- why the information can be understood at first glance",
    "- which areas attract attention first and which areas support the sales message",
    "- why the product still remains the hero instead of being overwhelmed by layout elements",
    "",
    "3. composition",
    "- relationship among product, model, background, selling-point zones, and negative space",
    "- first visual landing point, second landing point, third landing point",
    "- how the eye flows through the image",
    "- why this structure is beneficial for click-through and conversion",
    "- why the product feels dominant in the composition",
    "",
    "4. marketing",
    "- how the image creates desire, quality perception, lifestyle immersion, price justification, and purchase impulse",
    "- why it feels like a mature branded advertisement instead of an ordinary product image",
    "",
    "5. productFocus (critical)",
    "- the product's scale in frame",
    "- the product-to-model scale relationship",
    "- the product's dominance relative to background and layout zones",
    "- why the product becomes the first visual hero",
    "- you must clearly extract this because the later generationPrompt must imitate the reference image's product proportion, product dominance, and product visual weight at a one-to-one logic level",
    "",
    "6. modelSupport (critical)",
    "- whether the model is hero or support",
    "- how the model's pose serves the product",
    "- how the model helps place the product naturally into a commercial scene",
    "- if the reference image contains a person, you must deconstruct the human-product-scene relationship rather than merely saying there is a model",
    "- if the product in the reference image is worn, carried, held, displayed, or supported in a specific way, the later generationPrompt must allow the user's own product to enter the same type of display logic while keeping the product itself unchanged",
    "",
    "7. lightingCamera (critical)",
    "You must deconstruct this like a visual master. Do not use vague phrases like premium lighting or premium angle only.",
    "You must clearly analyze:",
    "- key light direction",
    "- fill light relationship",
    "- rim light presence or absence",
    "- contact shadow and cast shadow direction",
    "- reflected light source",
    "- color temperature",
    "- depth of field and background blur handling",
    "- camera angle",
    "- camera height",
    "- product orientation",
    "- spatial layering between product and background",
    "- why this lighting and camera setup makes the product feel more premium and more clickable",
    "",
    "Section 4: rules for generating the final generationPrompt",
    "1. generationPrompt must be one complete, single-paragraph, pure-English prompt that can be copied directly into GPT-Image.",
    "2. No markdown, no explanations, no multiple versions, no Chinese prompt.",
    "3. generationPrompt is not an analysis report. It is a final image-directing prompt.",
    "4. generationPrompt must first make clear that the uploaded product is a locked proprietary product layer / fixed product identity.",
    "5. It must explicitly state that the exact silhouette, exact structure, exact proportions, exact material segmentation, exact color blocking, exact zippers, exact straps, exact pockets, exact hardware, exact tags, exact seams, exact outline, and exact product-defining details must remain unchanged.",
    "5.5. If multiple own product images are provided, generationPrompt must explicitly treat them as multi-view references of the same proprietary product and preserve consistency across all visible and inferred angles.",
    "6. It must explicitly include language equivalent to: do not deform, redesign, simplify, repaint, recolor, resize, rotate, replace, or alter product-defining features.",
    "7. generationPrompt must also explicitly state that the product identity is locked, but the presentation relationship may imitate the commercial expression logic deconstructed from the reference image.",
    "8. If the reference image shows the product on a model, in a hand, on a table, or in a specific contextual scene, then the user's own product may enter the same type of relationship naturally, while the product itself remains unchanged.",
    "9. generationPrompt must imitate the reference image's product proportion and hierarchy logic, including:",
    "- product scale in frame",
    "- product-to-model scale relationship",
    "- product placement in layout",
    "- relationship with selling-point zones, negative space, and background",
    "- first-screen visual focal order and flow",
    "10. generationPrompt must imitate the deconstructed lighting and camera logic, including:",
    "- key light direction",
    "- fill light relationship",
    "- rim light logic",
    "- contact shadow",
    "- cast shadow direction",
    "- reflected light source",
    "- background blur handling",
    "- depth relationship",
    "- camera angle",
    "- camera height",
    "- product orientation",
    "- spatial layering between product and background",
    "11. generationPrompt must read like a true commercial visual director's brief, and must demonstrate:",
    "- art direction",
    "- composition hierarchy",
    "- product dominance",
    "- product-to-model relationship",
    "- product-to-camera scale relationship",
    "- thumbnail readability",
    "- lighting choreography",
    "- contact shadow logic",
    "- reflected light logic",
    "- material rendering",
    "- atmospheric depth",
    "- breathable negative space",
    "- premium ad-retouching finish",
    "- high-end marketplace hero quality",
    "- strong click-through appeal",
    "12. generationPrompt may retain generic commercial layout structure, but must not copy real brand assets from the reference image.",
    "It may describe:",
    "- generic headline zone",
    "- generic feature badge zone",
    "- generic promo block",
    "- generic CTA-ready area",
    "- copy-safe negative space",
    "These layout zones must remain blank or unreadable placeholder structures only, and must not reproduce real brand names, logos, slogans, prices, event texts, watermarks, or QR codes from the reference image.",
    "13. generationPrompt must absorb the true source of premium quality from the reference image, and must not stay at abstract adjectives only. Translate that quality into executable visual language such as:",
    "- product-first commercial hierarchy",
    "- elegant tonal separation",
    "- high-contrast thumbnail readability",
    "- clean subject-to-background separation",
    "- realistic contact shadows at the base",
    "- subtle reflected light on the shadow side",
    "- refined highlight control on materials",
    "- restrained lifestyle support",
    "- breathable layout rhythm",
    "- polished marketplace retouching feel",
    "14. The final generationPrompt should drive an image where:",
    "- the user's product identity and details remain correct",
    "- the product may naturally enter the same display relationship as the reference image",
    "- the product proportion, composition, model relationship, lighting relationship, and camera logic feel as mature as the reference image",
    "- the result feels like a premium branded marketplace advertisement",
    "- the thumbnail has strong first-glance pull",
    "- the product remains the undeniable hero",
    "- the commercial atmosphere is strong",
    "- the premium feeling is strong",
    "- the platform click-through logic is valid",
    "",
    `Product name: ${payload.productName || "not provided"}`,
    `Keywords: ${payload.keywords || "not provided"}`,
    `Canvas aspect ratio: ${payload.aspectRatio || "1:1"}`,
    "",
    "Return JSON only, no markdown, no explanations:",
    "{",
    "  \"visualDimensions\": {",
    "    \"sceneTone\": \"Chinese string\",",
    "    \"hierarchy\": \"Chinese string\",",
    "    \"composition\": \"Chinese string\",",
    "    \"marketing\": \"Chinese string\",",
    "    \"productFocus\": \"Chinese string\",",
    "    \"modelSupport\": \"Chinese string\",",
    "    \"lightingCamera\": \"Chinese string\"",
    "  },",
    "  \"competitorAdvantages\": [\"Chinese string\", \"Chinese string\"],",
    "  \"commonPatterns\": [\"Chinese string\", \"Chinese string\"],",
    "  \"strategy\": [\"Chinese string\", \"Chinese string\"],",
    "  \"creative\": {",
    "    \"model\": \"Chinese string\",",
    "    \"angle\": \"Chinese string\",",
    "    \"background\": \"Chinese string\",",
    "    \"subjectRatio\": \"Chinese string\",",
    "    \"lighting\": \"Chinese string\"",
    "  },",
    "  \"generationPrompt\": \"one complete English commercial prompt for GPT-Image\"",
    "}",
  ].join("\n");
}

function inferCommercialCategory(promptText = "", productName = "") {
  const text = `${productName} ${promptText}`.toLowerCase();
  if (/(吹风机|电吹风|hair\s*dryer|dryer|styler|straightener|curling|卷发棒|夹板)/i.test(text)) return "haircare";
  if (/(背包|双肩包|书包|包包|backpack|bag|tote|luggage|travel bag|satchel)/i.test(text)) return "bag";
  if (/(水杯|保温杯|杯子|马克杯|bottle|flask|tumbler|mug|cup)/i.test(text)) return "drinkware";
  if (/(口红|粉底|护肤|面霜|精华|香水|彩妆|cosmetic|skincare|makeup|serum|cream|perfume|lipstick)/i.test(text)) return "beauty";
  if (/(礼盒|月饼|糕点|食品|零食|gift box|hamper|snack|pastry|festival box|mooncake)/i.test(text)) return "gift";
  if (/(耳机|音箱|手机壳|数据线|充电器|数码|headphone|earbud|speaker|phone case|charger|cable)/i.test(text)) return "electronics";
  if (/(首饰|项链|手表|戒指|耳环|jewelry|necklace|watch|ring|earring)/i.test(text)) return "jewelry";
  return "generic";
}

function promptHasSignal(promptText, dimension) {
  const text = String(promptText || "");
  const map = {
    material: /(材质|金属|哑光|磨砂|皮革|织物|尼龙|玻璃|陶瓷|木纹|matte|glossy|metal|fabric|nylon|leather|glass|ceramic|woodgrain|brushed)/i,
    lighting: /(光|光影|逆光|柔光|阴影|侧光|窗光|日光|打光|lighting|sunlight|shadow|rim light|softbox|window light|backlight|warm light)/i,
    camera: /(镜头|景深|虚化|特写|构图|广角|85mm|50mm|微距|bokeh|depth of field|close-up|macro|cropped|telephoto)/i,
    scene: /(背景|场景|桌面|台面|窗边|浴室|海边|户外|室内|卧室|客厅|厨房|梳妆台|background|scene|interior|bathroom|vanity|tabletop|outdoor|coastal|kitchen|bedroom|studio)/i,
  };
  return map[dimension]?.test(text) || false;
}

function getCommercialBlueprint(category) {
  const shared = {
    finish: "Final finish: premium e-commerce hero quality, cinematic commercial polish, clean visual hierarchy, believable material separation, atmospheric depth, refined retouching, and strong click-through appeal.",
    exclusions: "Negative exclusions: no copied brand names, logos, slogans, prices, watermarks, QR codes, random text, garbled typography, cheap collage feeling, low-resolution artifacts, or blurry hero-subject edges.",
  };
  const map = {
    haircare: {
      materialFree: "Material direction: refined matte or satin-touch body finish, fingerprint-resistant surface feel, precise parting lines, subtle premium trim control, and clean high-end appliance detailing.",
      materialLocked: "Read the uploaded product's observed material truthfully: preserve the exact body finish, trim logic, buttons, vents, nozzle form, seams, and surface texture; only elevate how those details are lit and rendered.",
      lighting: "Lighting direction: studio-grade softbox key light blended with gentle window-side daylight, soft warm highlights, controlled rim light around the silhouette, and flattering beauty-ad tonal balance.",
      camera: "Camera direction: premium 85mm commercial product-and-beauty lens look, shallow depth of field, clean bokeh falloff, crisp hero focus, and ultra-clear ad-grade sharpness.",
      scene: "Scene direction: a refined warm home-care environment such as a modern vanity, airy cream-toned wash area, or softly sunlit tabletop with calm premium styling.",
      composition: "Composition direction: keep the hero product or the product-with-model relationship as the first visual focal point, with generous breathable negative space and a high-conversion ad layout rhythm.",
      support: "If a lifestyle model is used, keep the pose elegant and supportive, with natural hand interaction and believable beauty-ad posture rather than theatrical fashion posing.",
    },
    bag: {
      materialFree: "Material direction: structured woven fabric or coated textile feel, crisp seam definition, subtle micro-wrinkles, restrained hardware sheen, and premium everyday durability cues.",
      materialLocked: "Read the uploaded bag exactly as photographed: preserve its true fabric family, seams, pockets, zipper path, strap thickness, hardware placement, labels, printed details, and color-block structure; only improve lighting, edge clarity, and material depth.",
      lighting: "Lighting direction: bright commercial daylight with soft directional fill, believable side sunlight, delicate rim separation, realistic contact shadows, and clean atmospheric depth.",
      camera: "Camera direction: premium 85mm marketplace ad lens look with shallow background blur, crisp edge definition on the bag, realistic depth compression, and polished hero-subject sharpness.",
      scene: "Scene direction: a clean outdoor-travel or commute-lifestyle environment such as a coastal path, modern transit setting, or bright airy travel platform without visual clutter.",
      composition: "Composition direction: make the bag the dominant hero subject with strong silhouette readability, clear scale hierarchy, and an ad-friendly balance between product, background depth, and optional info layout zones.",
      support: "If a model is used, the bag may be naturally worn or held, but the product must remain the commercial hero rather than becoming a background accessory.",
    },
    drinkware: {
      materialFree: "Material direction: premium metal, coated ceramic, or clean engineered plastic rendering with restrained specular control, refined edge highlights, and premium tactile finish.",
      materialLocked: "Read the uploaded drinkware exactly as it appears: preserve the true body proportions, lid structure, handle logic, spout details, surface finish, material zones, and printed elements; only elevate realism through lighting and micro-contrast.",
      lighting: "Lighting direction: soft premium tabletop light with controlled highlights, realistic reflections, gentle side illumination, and polished catalog-grade contrast.",
      camera: "Camera direction: clean 85mm or short-tele commercial still-life lens look, shallow depth of field, crisp focal plane on the hero product, and extremely clean product photography sharpness.",
      scene: "Scene direction: a refined tabletop, breakfast nook, or calm hospitality-inspired lifestyle setting with soft premium restraint.",
      composition: "Composition direction: keep the product centered in a calm, premium still-life composition with strong material readability and elegant negative space.",
      support: "Use supporting props only if they feel restrained, relevant, and secondary to the product.",
    },
    beauty: {
      materialFree: "Material direction: luxe beauty-pack finish, refined matte or glossy surface control, crisp label area handling, subtle metallic accents, and delicate tactile realism.",
      materialLocked: "Read the uploaded beauty product faithfully: preserve its bottle, cap, pump, label area, finish, proportions, and decorative details exactly, while only upgrading material realism and surface lighting.",
      lighting: "Lighting direction: soft beauty-campaign illumination with diffused glow, graceful highlight rolloff, fine edge light, and elegant skin-or-surface flattering warmth.",
      camera: "Camera direction: premium beauty still-life photography, 85mm commercial lens look, shallow depth of field, subtle bokeh, and pristine high-resolution finish.",
      scene: "Scene direction: a refined vanity, marble or cream-toned tabletop, softly sunlit beauty corner, or elegant editorial home-care environment.",
      composition: "Composition direction: keep the product dominant while surrounding it with beauty-campaign atmosphere, clean negative space, and polished conversion-ready hierarchy.",
      support: "If a model or hand is present, it should feel elegant, restrained, and naturally supportive of the hero product.",
    },
    gift: {
      materialFree: "Material direction: premium paperboard, embossed patterning, fabric or ribbon accents, lacquer-like color richness, and ceremonial packaging craftsmanship.",
      materialLocked: "Read the uploaded gift packaging exactly: preserve the box structure, handle logic, embossed or printed pattern zones, trim, tassels, ribbons, and material layering while only elevating depth, shadow, and surface richness.",
      lighting: "Lighting direction: luxurious directional studio light with controlled festive warmth, dimensional highlight placement, soft shadow transitions, and premium ceremonial atmosphere.",
      camera: "Camera direction: high-end commercial packaging photography with crisp hero focus, elegant depth separation, and polished premium advertising sharpness.",
      scene: "Scene direction: a refined festive display environment with tasteful wood, fabric, lacquer, or ceremonial tabletop cues, while keeping the packaging dominant.",
      composition: "Composition direction: build a premium presentation with strong frontal readability, rich but controlled atmosphere, and clear premium gift-value storytelling.",
      support: "Hands or wardrobe support may appear if needed, but they must serve the packaging hero and preserve premium ceremony cues.",
    },
    electronics: {
      materialFree: "Material direction: refined engineered surfaces, anti-smudge finish, precise seam control, subtle metallic or glass accents, and premium consumer-tech detailing.",
      materialLocked: "Read the uploaded device faithfully: preserve its exact housing geometry, buttons, ports, trims, textures, and material segmentation while only improving light behavior and tactile realism.",
      lighting: "Lighting direction: premium commercial studio lighting with controlled contrast, soft reflections, subtle rim separation, and elegant high-tech polish without harsh glare.",
      camera: "Camera direction: premium commercial product-photography lens look, shallow depth of field when useful, tack-sharp device edges, and crisp tech-ad clarity.",
      scene: "Scene direction: a restrained modern environment such as a clean desk, minimal lifestyle interior, or softly lit premium tech setup with low clutter.",
      composition: "Composition direction: emphasize clarity, precision, and premium object presence with clean geometry and strong visual hierarchy.",
      support: "Lifestyle support should feel minimal, modern, and secondary to the product's form and usability cues.",
    },
    jewelry: {
      materialFree: "Material direction: high-fidelity precious-metal rendering, elegant highlight control, refined gemstone sparkle, and luxurious surface polish.",
      materialLocked: "Read the uploaded jewelry faithfully: preserve its exact form, setting, proportions, clasp or band logic, surface detailing, and stone placement while only enhancing shine, depth, and realism.",
      lighting: "Lighting direction: elegant luxury-product lighting with pinpoint sparkle control, soft fill, premium edge highlights, and refined depth.",
      camera: "Camera direction: macro-luxury commercial lens feel, shallow depth of field, crisp subject plane, and ultra-clean high-end advertising sharpness.",
      scene: "Scene direction: a restrained premium jewelry environment such as velvet, stone, or soft editorial tabletop styling with elegant negative space.",
      composition: "Composition direction: keep the jewelry visually precious, isolated, and dominant, with luxurious material contrast and uncluttered sophistication.",
      support: "If hands or model cues appear, they must remain understated and premium.",
    },
    generic: {
      materialFree: "Material direction: premium matte-to-satin finish control, clear edge definition, refined tactile realism, and believable commercial-grade surface treatment.",
      materialLocked: "Read the uploaded product faithfully from the source image: preserve its true structure, materials, edges, seams, prints, hardware, and finish while only upgrading lighting response and realism.",
      lighting: "Lighting direction: studio-grade soft directional lighting with refined fill, subtle rim separation, believable highlights, controlled shadows, and premium commercial depth.",
      camera: "Camera direction: premium 85mm commercial hero-shot lens feel, shallow depth of field where useful, crisp focal priority on the hero product, and ultra-clean ad-grade clarity.",
      scene: "Scene direction: a tasteful premium lifestyle or tabletop setting that fits the product naturally, with clean negative space and restrained styling.",
      composition: "Composition direction: maintain strong hero-subject dominance, balanced breathing room, polished marketplace hierarchy, and believable commercial staging.",
      support: "Lifestyle support is allowed only when it strengthens the product story without stealing attention from the hero subject.",
    },
  };
  return {
    ...shared,
    ...(map[category] || map.generic),
  };
}

function getStyleDirective(payload) {
  const styleMode = String(payload.styleMode || "clean");
  const map = {
    clean: "Art direction: clean, high-click, marketplace-friendly hero image with polished simplicity.",
    premium: "Art direction: premium, refined, upscale marketplace hero image with elevated material feel.",
    functional: "Art direction: feature-forward, conversion-focused marketplace hero image with strong clarity and selling-point readability.",
    scene: "Art direction: scene-rich, lifestyle-driven marketplace hero image with commercial polish and atmospheric storytelling.",
  };
  return map[styleMode] || map.clean;
}

function getModelDirective(payload) {
  const modelMode = String(payload.modelMode || "auto");
  const map = {
    auto: "Model support: allow tasteful lifestyle support only if it improves the ad finish while keeping the product dominant.",
    hand: "Model support: if useful, include subtle hand-held or hand-interaction support that feels naturally photographed.",
    half: "Model support: if useful, include a tasteful half-body lifestyle model while keeping the product as the hero.",
    none: "Model support: do not include a visible person; keep the scene product-focused.",
  };
  return map[modelMode] || map.auto;
}

function getAngleDirective(payload) {
  const angleMode = String(payload.angleMode || "auto");
  const map = {
    auto: "",
    front: "Angle direction: prefer a confident front-facing hero angle with clear silhouette readability.",
    angle45: "Angle direction: prefer a refined 45-degree hero angle that adds depth without losing recognizability.",
    combo: "Angle direction: allow one main hero angle with subtle secondary-angle support only if it improves the commercial finish.",
  };
  return map[angleMode] || "";
}

function getBackgroundDirective(payload, promptText, blueprint) {
  const backgroundMode = String(payload.backgroundMode || "auto");
  const map = {
    bathroom: "Scene direction: use a bright, clean, realistic lifestyle wash-area or bathroom environment only if it fits the product and intent.",
    vanity: "Scene direction: use a polished tabletop or vanity-like lifestyle environment only if it fits the product and intent.",
    hotel: "Scene direction: use a refined hospitality-style environment with premium restraint only if it fits the product and intent.",
    plain: "Scene direction: keep the background clean, high-conversion, and minimally distracting.",
  };
  if (backgroundMode !== "auto") return map[backgroundMode] || blueprint.scene;
  if (promptHasSignal(promptText, "scene")) return "";
  return blueprint.scene;
}

function buildEditMasterPrompt(payload, coreDirection = "") {
  const ownImages = getOwnImageSet(payload, 4);
  const hasProductImage = ownImages.length > 0 || Boolean(payload.productImage);
  const referenceImages = Array.isArray(payload.referenceImages)
    ? payload.referenceImages.filter(Boolean)
    : payload.referenceImage ? [payload.referenceImage] : [];
  const productName = String(payload.productName || "").trim();
  const normalizedCoreDirection = String(coreDirection || payload.userPrompt || "upgrade the product visual appeal into a premium marketplace hero image")
    .replace(/\s+/g, " ")
    .trim();
  const promptContext = `${productName} ${normalizedCoreDirection}`.trim();
  const blueprint = getCommercialBlueprint(inferCommercialCategory(promptContext, productName));
  const ownImageCount = ownImages.length || Number(payload.productImageCount || 0) || (hasProductImage ? 1 : 0);
  const clauses = [
    `Core creative direction: ${normalizedCoreDirection}.`,
    `Canvas aspect ratio: ${payload.aspectRatio || "1:1"}.`,
    getStyleDirective(payload),
    getModelDirective(payload),
    getAngleDirective(payload),
    getBackgroundDirective(payload, promptContext, blueprint),
    !promptHasSignal(promptContext, "material")
      ? (hasProductImage ? blueprint.materialLocked : blueprint.materialFree)
      : (hasProductImage ? "Respect the observed product material truth from the uploaded source image; do not invent new decorative trims, hardware, or structural material changes." : ""),
    !promptHasSignal(promptContext, "lighting") ? blueprint.lighting : "",
    !promptHasSignal(promptContext, "camera") ? blueprint.camera : "",
    blueprint.composition,
    blueprint.support,
    hasProductImage
      ? `Use the uploaded product image${ownImageCount > 1 ? " set" : ""} as the proprietary product layer and preserve it with 100% fidelity${ownImageCount > 1 ? ", using all uploaded views as the same locked product identity reference" : ""}.`
      : "",
    hasProductImage
      ? "Immutable identity: preserve the exact product category, silhouette, proportions, seams, hardware, trims, pocket layout, zipper path, printed details, and color-block relationships."
      : "",
    hasProductImage
      ? "Adaptable fit is allowed only for believable perspective placement, contact shadows, reflected light, edge highlights, and natural model/body interaction if the scene requires it."
      : "",
    hasProductImage
      ? "Forbidden fabrication: do not redesign, repaint, add new attachments, invent extra structure, replace the item with another product, or erase recognizable product details."
      : "",
    referenceImages.length
      ? "If reference images are provided, absorb only their useful strengths at the principle level such as scene tone, composition rhythm, lifestyle mood, product scale, and commercial atmosphere; do not copy their brands, slogans, exact text, prices, or trademark layout."
      : "",
    "You may create clean generic headline areas, feature badge areas, promo ribbon areas, or info blocks only when they improve the ad finish, but do not copy any real brand names, slogans, logos, prices, or exact reference wording.",
    blueprint.finish,
    blueprint.exclusions,
  ];
  return clauses.filter(Boolean).join(" ");
}

function normalizeDirectPromptText(text) {
  return String(text || "")
    .replace(/```json|```/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countCjkChars(text) {
  const matches = String(text || "").match(/[\u3400-\u9fff]/g);
  return matches ? matches.length : 0;
}

function looksLikeCompiledEnglishPrompt(text) {
  const normalized = normalizeDirectPromptText(text);
  if (normalized.length < 120) return false;
  const alphaCount = (normalized.match(/[A-Za-z]/g) || []).length;
  const cjkCount = countCjkChars(normalized);
  if (!alphaCount) return false;
  if (cjkCount > Math.max(6, Math.floor(alphaCount * 0.08))) return false;
  return /(lighting|camera|composition|premium|product|commercial|hero|scene|material|shadow|background|retouching|marketplace)/i.test(normalized);
}

function buildEnglishFallbackDirection(payload) {
  const rawName = String(payload.productName || "").trim();
  const safeProductName = countCjkChars(rawName) ? "the target product" : (rawName || "the target product");
  return `Create a premium e-commerce hero image for ${safeProductName} with refined commercial lighting, stronger material realism, clean composition, premium negative space, and elevated marketplace conversion appeal.`;
}

function buildReplacementMasterPrompt(payload, coreDirection = "") {
  const productName = String(payload.productName || "").trim();
  const templateIndex = Number(payload.templateIndex || 1);
  const replacementIndex = Number(payload.replacementIndex || 2);
  const normalizedCoreDirection = String(coreDirection || payload.userPrompt || "Replace the product in the template scene with the replacement product and keep everything else unchanged.")
    .replace(/\s+/g, " ")
    .trim();
  const promptContext = `${productName} ${normalizedCoreDirection}`.trim();
  const blueprint = getCommercialBlueprint(inferCommercialCategory(promptContext, productName));
  return [
    `Critical product replacement edit. Core user direction: ${normalizedCoreDirection}.`,
    `Canvas aspect ratio: ${payload.aspectRatio || "1:1"}.`,
    `The locked template scene comes from uploaded image ${templateIndex}. The replacement product source comes from uploaded image ${replacementIndex}.`,
    "Keep the template scene visually intact: preserve the same person, hands, face, body pose, wardrobe, props, packaging, background, layout blocks, crop, perspective, lens feel, lighting direction, reflections, depth of field, and overall composition unless the user explicitly requests a change.",
    `Treat the replacement product as the proprietary product layer${productName ? ` for ${productName}` : ""} and preserve its exact category, silhouette, proportions, seams, hardware, printed details, material zones, and recognizable structure.`,
    blueprint.materialLocked,
    "Replace only the single primary product object in the template scene. Do not replace secondary props, packaging, or supporting objects unless the user explicitly asks for that.",
    "Match the replacement product to the original contact point, occlusion, support relationship, scale, perspective, cast shadow, reflected light, rim light, and environmental color so the final result looks naturally photographed in the existing scene rather than pasted.",
    "Adaptable fit is allowed only where necessary to achieve believable body placement, hand grip, or scene contact while keeping the product identity fully intact.",
    "Forbidden fabrication: do not redesign the product, invent new structure, remove recognizable details, alter labels, repaint materials, or change the scene's non-target elements.",
    "Do not add copied branding, slogans, prices, watermarks, QR codes, random text, or unrelated accessories.",
    blueprint.finish,
    blueprint.exclusions,
  ].filter(Boolean).join(" ");
}

function buildEditPlanInstruction(payload) {
  const hasProductImage = Boolean(payload.productImage) || getOwnImageSet(payload, 4).length > 0;
  const hasReferenceImages = Array.isArray(payload.referenceImages)
    ? payload.referenceImages.some(Boolean)
    : Boolean(payload.referenceImage);
  return [
    "# Role",
    "You are a senior e-commerce prompt architect and commercial art director for GPT-Image. Your job is to turn the user's short request, locked product images, and optional inspiration references into one direct-to-use English commercial image prompt.",
    "",
    "# Context",
    `User request: ${payload.userPrompt || "not provided"}`,
    `Product name: ${payload.productName || "not provided"}`,
    `Aspect ratio: ${payload.aspectRatio || "1:1"}`,
    `Style mode: ${payload.styleLabel || payload.styleMode || "clean"}`,
    `Model mode: ${payload.modelLabel || payload.modelMode || "auto"}`,
    `Angle mode: ${payload.angleLabel || payload.angleMode || "auto"}`,
    `Background mode: ${payload.backgroundLabel || payload.backgroundMode || "auto"}`,
    `Locked product image provided: ${hasProductImage ? "yes" : "no"}`,
    `Inspiration reference provided: ${hasReferenceImages ? "yes" : "no"}`,
    "",
    "# Task",
    "1. First infer the product category and commercial use case from the user request and any uploaded product images.",
    "2. Even if the user request is very short, automatically upgrade it into a high-end commercial prompt by filling in four layers: CMF / material and finish, Lighting / commercial light logic, Camera / lens and image quality, Scene / premium environment.",
    "3. If the user already specified any of those layers, preserve the original intent and only make it more commercial, more precise, and more production-ready.",
    "4. If a locked product image is provided, treat it as a proprietary product layer. The final image must preserve the exact category, silhouette, proportions, seams, hardware, trims, pocket layout, zipper path, printed details, material zones, and key recognizable identity. The product must not deform, drift, or be replaced by another product.",
    "5. If a locked product image is provided, CMF instructions must faithfully enhance only what is visibly true in the uploaded product: lighting response, tactile realism, contrast, micro-shadow definition, edge clarity, and realistic material rendering. Do not invent new structures, trims, pockets, hardware, or brand markings.",
    "6. If inspiration references are provided, absorb only their strengths at the principle level: scene tone, composition rhythm, product-to-frame ratio, lifestyle mood, negative space, information hierarchy, and commercial conversion atmosphere. Never copy their brands, logos, slogans, exact wording, prices, or trademark layout.",
    "7. The final generationPrompt must be one complete direct-to-use English prompt for GPT-Image. No Chinese in generationPrompt. No markdown. No multiple versions.",
    "8. The target output quality is premium e-commerce hero image / commercial advertising banner / high-end marketplace main image.",
    "9. generationPrompt should read like a visual director's instruction set and should naturally cover: creative direction, art direction, composition, subject dominance, model or lifestyle support if relevant, lighting, material rendering, scene styling, atmospheric depth, camera quality, premium finish, and negative exclusions.",
    "10. Generic headline areas, feature badge areas, promo ribbon areas, and information blocks are allowed only as blank or generic commercial layout placeholders. Never reproduce reference text or branding.",
    "11. If the user wants the product placed on a model or integrated into a lifestyle scene, allow only believable perspective fit, contact logic, scale matching, shadow matching, and reflected-light matching while preserving the product identity.",
    "12. Do not weaken a strong prompt. Elevate it.",
    "",
    "# Output",
    "Output strict JSON only. No markdown.",
    "{",
    '  "analysisNotes": ["2-4 short Chinese notes about the useful commercial strengths or prompt-upgrade decisions"],',
    '  "generationPrompt": "one single-paragraph direct-to-use English prompt for GPT-Image"',
    "}",
  ].join("\n");
}

function buildReplacementPlanInstruction(payload) {
  return [
    "# Role",
    "Inspect the locked template scene and the replacement product image, then compile one strict English GPT-Image edit prompt.",
    "",
    "# User instruction",
    payload.userPrompt || "Replace the product in image 1 with the product in image 2 and keep everything else unchanged.",
    "",
    "# Hard rules",
    `1. Uploaded image ${payload.templateIndex || 1} is the locked template scene. It defines the person, hands, pose, background, lighting, crop, perspective, composition, props, text blocks, packaging, and every non-target element.`,
    `2. Uploaded image ${payload.replacementIndex || 2} is the only replacement product source. Preserve its structure, silhouette, proportions, materials, printed details, hardware, seams, and key identity.`,
    "3. Replace only the single primary product object inside the locked template scene. Be specific about which object should be replaced based on the template image.",
    "4. Keep all non-target scene elements visually unchanged. Do not redraw the person, background, props, typography layout, extra packaging, or secondary objects unless the user explicitly asked for that.",
    "5. The final prompt must tell GPT-Image to match the original contact point, occlusion, hand relationship, support point, perspective, lighting, cast shadow, reflected light, and scale so the replacement looks naturally photographed in the template scene.",
    "6. The final prompt must separate immutable identity, adaptable fit, and forbidden fabrication: the product identity must stay exact, scene fit may adapt only for believable contact/perspective, and no unrelated scene element may drift.",
    "7. Output only one direct-to-use English edit prompt. No markdown.",
    "",
    "# Context",
    `Product name: ${payload.productName || "not provided"}`,
    `Keywords: ${payload.keywords || "not provided"}`,
    `Aspect ratio: ${payload.aspectRatio || "1:1"}`,
    "",
    "# Output JSON",
    "{",
    '  "analysisNotes": ["short Chinese notes, 2-4 items"],',
    '  "generationPrompt": "one complete English edit prompt for GPT-Image"',
    "}",
  ].join("\n");
}

function extractTextResult(result) {
  const direct = result?.choices?.[0]?.message?.content
    || result?.choices?.[0]?.delta?.content
    || result?.output_text
    || result?.text
    || result?.data?.text
    || result?.output?.[0]?.content?.[0]?.text
    || result?.candidates?.[0]?.content?.parts?.[0]?.text
    || "";

  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    const joined = direct
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content?.text === "string") return item.content.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  const choiceParts = result?.choices?.[0]?.message?.content?.parts;
  if (Array.isArray(choiceParts)) {
    const joined = choiceParts
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  const outputBlocks = result?.output;
  if (Array.isArray(outputBlocks)) {
    const joined = outputBlocks
      .flatMap((block) => Array.isArray(block?.content) ? block.content : [])
      .map((item) => {
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.output_text === "string") return item.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  return "";
}

function parseJsonFromText(text) {
  if (!text) throw new Error("视觉分析 API 没有返回文本内容");
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`视觉分析结果不是 JSON：${cleaned.slice(0, 300)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseJsonOrPromptPayload(text) {
  try {
    return parseJsonFromText(text);
  } catch (error) {
    const recovered = recoverPromptPayloadFromText(text);
    if (recovered) return recovered;
    throw error;
  }
}

function recoverPromptPayloadFromText(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  if (!cleaned) return null;

  const generationPrompt = extractQuotedJsonField(cleaned, "generationPrompt");
  const positivePrompt = extractQuotedJsonField(cleaned, "positivePrompt");
  const negativePrompt = extractQuotedJsonField(cleaned, "negativePrompt");
  if (generationPrompt || positivePrompt || negativePrompt) {
    return {
      generationPrompt: generationPrompt || "",
      positivePrompt: positivePrompt || "",
      negativePrompt: negativePrompt || "",
    };
  }

  const promptBlock = cleaned.match(/Positive Prompt:\s*([\s\S]*?)(?:\n\s*Negative Prompt:\s*([\s\S]*))?$/i);
  if (promptBlock) {
    return {
      positivePrompt: promptBlock[1]?.trim() || "",
      negativePrompt: promptBlock[2]?.trim() || "",
    };
  }

  const plainPrompt = cleaned.match(/(?:generationPrompt|final prompt|prompt)\s*[:：]\s*([\s\S]{80,})/i);
  if (plainPrompt) {
    return {
      generationPrompt: plainPrompt[1].trim(),
    };
  }

  return null;
}

function extractQuotedJsonField(text, fieldName) {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i");
  const match = String(text || "").match(pattern);
  if (!match) return "";
  return decodeEscapedJsonText(match[1]);
}

function decodeEscapedJsonText(value) {
  const wrapped = `"${String(value || "").replace(/"/g, '\\"')}"`;
  try {
    return JSON.parse(wrapped).trim();
  } catch (error) {
    return String(value || "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  }
}

function normalizeAnalysisResult(raw, payload) {
  const creative = raw.creative || {};
  const scores = raw.scores || {};
  const normalized = {
    avg: {
      score: Number(scores.overall || 0),
      cleanBackground: Number(scores.background || 0),
      subjectFocus: Number(scores.focus || 0),
      palette: [],
    },
    strengths: asStringArray(raw.competitorAdvantages),
    weaknesses: asStringArray(raw.competitorWeaknesses),
    commonPatterns: asStringArray(raw.commonPatterns),
    gaps: asStringArray(raw.ownGaps),
    actions: asStringArray(raw.strategy),
    visualDimensions: raw.visualDimensions || null,
    positivePrompt: String(raw.positivePrompt || "").trim(),
    negativePrompt: String(raw.negativePrompt || "").trim(),
    creative: {
      model: creative.model || "仅分析参考图中的模特或辅助产品表达，不主动新增人物主体，产品保持第一视觉中心",
      angle: creative.angle || "匹配参考图的透视、空间关系和光影方向，但不改变产品图层",
      background: creative.background || "使用干净、真实、低干扰的商业摄影背景",
      subjectRatio: creative.subjectRatio || "68%-78%",
    },
    rawPrompt: String(raw.generationPrompt || "").trim(),
    rawPromptVariants: Array.isArray(raw.promptVariants) ? raw.promptVariants : [],
    promptVariants: [],
    prompt: "",
  };
  normalized.prompt = composeFinalGenerationPrompt(normalized, payload);
  normalized.promptVariants = composePromptVariants(normalized, payload);
  return normalized;
}

function normalizeEditPlan(raw, payload) {
  const analysisNotes = asStringArray(raw.analysisNotes).slice(0, 4);
  const basePrompt = normalizeDirectPromptText(raw.generationPrompt || "");
  const prompt = looksLikeCompiledEnglishPrompt(basePrompt)
    ? basePrompt
    : buildEditMasterPrompt(
        payload,
        buildEnglishFallbackDirection(payload),
      );

  return {
    analysisNotes,
    prompt,
  };
}

function normalizeReplacementPlan(raw, payload) {
  const analysisNotes = asStringArray(raw.analysisNotes).slice(0, 4);
  const basePrompt = normalizeDirectPromptText(raw.generationPrompt || "");
  return {
    analysisNotes,
    prompt: looksLikeCompiledEnglishPrompt(basePrompt)
      ? basePrompt
      : buildReplacementMasterPrompt(
          payload,
          "Replace the target product in the locked template scene with the replacement product while keeping all non-target scene elements unchanged.",
        ),
  };
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function buildFallbackGenerationPrompt(raw, payload) {
  return [
    `请基于用户上传的原始主图加工淘宝商品主图，产品是“${payload.productName || "商品"}”。`,
    `参考竞品优点：${asStringArray(raw.competitorAdvantages).join("；")}`,
    `避开竞品缺点：${asStringArray(raw.competitorWeaknesses).join("；")}`,
    `改善用户主图问题：${asStringArray(raw.ownGaps).join("；")}`,
    "生成真实商业摄影效果，保留产品关键外观，不要生成文字、水印、乱码，不照抄竞品。",
  ].join("\n");
}

function stripPromptEnhancerLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(Must absorb these competitor strengths:|Must reflect these shared high-conversion patterns:|Execution priorities:)/i.test(line))
    .join("\n")
    .trim();
}

function isSafePromptEnhancerItem(text) {
  const value = String(text || "").trim();
  if (!value || value.length < 4 || value.length > 220) return false;
  if (/[�]/.test(value)) return false;
  if (/(admin|bathroom|white tiles?)/i.test(value)) return false;
  if (/(浴室|瓷砖)/.test(value)) return false;
  if (/[鍙鍏銆鏄鐨勪簬鍦哄浘鎴风珵鎻愮敤鏈夌殑]/.test(value)) return false;
  return true;
}

function dedupePromptItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPromptEnhancerLines(analysis) {
  const strengths = dedupePromptItems((analysis.strengths || []).filter(isSafePromptEnhancerItem)).slice(0, 2);
  const commonPatterns = dedupePromptItems((analysis.commonPatterns || []).filter(isSafePromptEnhancerItem)).slice(0, 3);
  return [
    strengths.length ? `Must absorb these competitor strengths: ${strengths.join("; ")}.` : "",
    commonPatterns.length ? `Must reflect these shared high-conversion patterns: ${commonPatterns.join("; ")}.` : "",
  ].filter(Boolean);
}

function composeFinalGenerationPrompt(analysis, payload) {
  const productName = payload.productName || "??";
  const keywords = payload.keywords || "???";
  const isDevelop = payload.taskMode === "develop";
  if (!isDevelop && (analysis.positivePrompt || analysis.negativePrompt || analysis.rawPrompt)) {
    const rawPrompt = stripPromptEnhancerLines(String(analysis.rawPrompt || "").trim());
    if (rawPrompt) return rawPrompt;
    const positive = stripPromptEnhancerLines(String(analysis.positivePrompt || "").trim());
    const negative = String(analysis.negativePrompt || "").trim();
    if (positive && negative) return `Positive Prompt:
${positive}

Negative Prompt:
${negative}`;
    if (positive) return positive;
    return [
      "Positive Prompt:",
      "Create a premium e-commerce hero image for PREMIUM_BRAND using the proprietary product layer as the fixed product subject.",
      "The proprietary product layer must remain absolutely unchanged and must not deform in any way.",
      "Do not alter structure, silhouette, proportions, material segmentation, straps, zipper layout, pockets, edges, colors, tags, or key product details.",
      "Only optimize the surrounding environment, scene tone, lighting, depth, contact shadows, reflections, composition support, and commercial atmosphere.",
      `Canvas aspect ratio: ${payload.aspectRatio || "1:1"}.`,
      "",
      "Negative Prompt:",
      "deformed product, distorted product, warped product, changed product structure, changed product shape, changed product color, changed product material, moved product, resized product, rotated product, repainted product, redrawn proprietary product layer, copied brand logo, watermark, readable text, QR code, price label, pasted composite look, messy background, low-resolution, blurry product",
    ].join("\n");
  }
  const commonPatterns = analysis.commonPatterns.length ? analysis.commonPatterns : analysis.strengths;
  const strengths = analysis.strengths.length ? analysis.strengths : [isDevelop ? "竞品产品的吸收方向需要更明确" : "参考图优点需要被转成可执行策略"];
  const weaknesses = analysis.weaknesses.length ? analysis.weaknesses : [isDevelop ? "竞品产品的避坑点需要补充" : "参考图待优化点需要补充"];
  const gaps = analysis.gaps.length ? analysis.gaps : [isDevelop ? "你的产品差距需要补充" : "你的主图差距需要补充"];
  const actions = analysis.actions.length ? analysis.actions : [isDevelop ? "产品升级策略需要补充" : "主图优化策略需要补充"];
  const controlLines = buildUserControlLines(payload);

  if (isDevelop) {
    return [
      `请围绕产品开发与设计升级来优化 ${productName}。`,
      `关键词/卖点：${keywords}`,
      "",
      "用户控制项：",
      ...controlLines.map((item) => `- ${item}`),
      "",
      "竞品共性：",
      ...commonPatterns.map((item) => `- ${item}`),
      "",
      "竞品优点：",
      ...strengths.map((item) => `- ${item}`),
      "",
      "竞品待优化点：",
      ...weaknesses.map((item) => `- ${item}`),
      "",
      "当前产品差距：",
      ...gaps.map((item) => `- ${item}`),
      "",
      "升级策略：",
      `- 模特/使用方式：${analysis.creative.model}`,
      `- 展示角度：${analysis.creative.angle}`,
      `- 背景场景：${analysis.creative.background}`,
      `- 主体比例：${analysis.creative.subjectRatio}`,
      ...actions.map((item) => `- ${item}`),
      "",
      "请给出可直接用于产品设计升级的完整中文提示词，强调可制造性、识别度、卖点表达和高端质感。",
    ].join("\n");
  }

  return [
    "Positive Prompt:",
    "Create a premium e-commerce hero image for PREMIUM_BRAND using the proprietary product layer as the fixed product subject.",
    "The proprietary product layer must remain absolutely unchanged and must not deform in any way.",
    "Do not alter structure, silhouette, proportions, material segmentation, straps, zipper layout, pockets, edges, colors, tags, or key product details.",
    "Only optimize the surrounding environment, scene tone, lighting, depth, contact shadows, reflections, composition support, and commercial atmosphere.",
    `Canvas aspect ratio: ${payload.aspectRatio || "1:1"}.`,
    "",
    "Negative Prompt:",
    "deformed product, distorted product, warped product, changed product structure, changed product shape, changed product size, changed product color, changed product material, moved product, resized product, rotated product, repainted product, redrawn proprietary product layer, copied brand logo, copied trademark, watermark, random text, garbled letters, price tag, QR code, cluttered background, overdecorated layout, poor shadow matching, pasted composite look, low-resolution, blurry product",
  ].join("\n");
}
function composePromptVariants(analysis, payload) {
  const isDevelop = payload.taskMode === "develop";
  const rawVariants = analysis.rawPromptVariants
    .map((item, index) => ({
      title: String(item?.title || `版本 ${index + 1}`).trim(),
      focus: String(item?.focus || "").trim(),
      prompt: String(item?.prompt || "").trim(),
    }))
    .filter((item) => item.prompt);

  const basePrompt = analysis.prompt || composeFinalGenerationPrompt(analysis, payload);
  const commonText = (analysis.commonPatterns.length ? analysis.commonPatterns : analysis.strengths).join("；");
  const fallbackVariants = isDevelop ? [
    {
      title: "外观升级版",
      focus: "升级产品形态和第一眼识别度",
      prompt: `${basePrompt}\n\n本版本重点：在保留原产品品类和核心识别的基础上，优化外观轮廓、比例、颜色和差异化记忆点。竞品产品共性参考：${commonText}`,
    },
    {
      title: "功能结构版",
      focus: "升级功能模块和使用体验",
      prompt: `${basePrompt}\n\n本版本重点：增加或强化可感知的功能结构、开合方式、收纳/防护/便携/耐用等卖点，让设计更像真实可量产新款。竞品产品共性参考：${commonText}`,
    },
    {
      title: "材质高端版",
      focus: "升级材质、工艺和高端质感",
      prompt: `${basePrompt}\n\n本版本重点：强化材质纹理、边缘工艺、金属/织物/塑料/玻璃等质感细节，提升高级感和价格感。竞品产品共性参考：${commonText}`,
    },
  ] : [
    {
      title: "方案",
      focus: "局部重绘/背景替换，产品图层不动，只生成周围场景和匹配光影",
      prompt: basePrompt,
    },
  ];
  const variants = rawVariants.length ? rawVariants : fallbackVariants;

  if (!isDevelop && (analysis.positivePrompt || analysis.negativePrompt || analysis.rawPrompt)) {
    const variant = rawVariants[0] || {
      title: "方案",
      focus: "局部重绘/背景替换，保持产品图层完全不动",
      prompt: basePrompt,
    };
    return [{
      title: "方案",
      focus: variant.focus || "局部重绘/背景替换，产品绝对不变形",
      prompt: basePrompt,
    }];
  }

  return variants.slice(0, 3).map((variant, index) => ({
    title: variant.title || `版本 ${index + 1}`,
    focus: variant.focus || "",
    prompt: [
      variant.prompt,
      "",
      isDevelop
        ? "硬性要求：必须基于用户上传原产品图做产品设计升级，不要生成无关品类；保留原产品基本识别，升级外观、结构、功能、材质和细节；不要生成文字、水印、乱码、价格标签。"
        : "硬性要求：必须基于用户上传原图编辑，不要生成无关新产品；保留原产品关键外观、结构、颜色、图案和材质；不要生成文字、水印、乱码、价格标签。",
    ].join("\n"),
  }));
}

function saveLastApiResponse(result) {
  try {
    fs.writeFileSync(lastResponsePath, JSON.stringify(result, null, 2), "utf8");
  } catch (error) {
    // Debug-only helper; ignore write failures.
  }
}

function extractImageResult(result) {
  const candidates = [
    result?.data?.[0]?.b64_json,
    result?.data?.[0]?.url,
    result?.data?.[0]?.image,
    result?.data?.[0]?.base64,
    result?.data?.[0]?.image_url?.url,
    result?.data?.[0]?.content?.[0]?.image_url?.url,
    result?.output?.[0]?.content?.[0]?.image_url,
    result?.output?.[0]?.content?.[0]?.image_url?.url,
    result?.output?.[0]?.content?.[0]?.url,
    result?.output?.[0]?.content?.[0]?.b64_json,
    result?.images?.[0]?.url,
    result?.images?.[0]?.b64_json,
    result?.image,
    result?.url,
    result?.b64_json,
  ];

  for (const item of candidates) {
    const normalized = normalizeImageValue(item);
    if (normalized) return normalized;
  }

  const deep = findImageLikeValue(result);
  return normalizeImageValue(deep);
}

async function finalizeImageResult(value) {
  if (!value || typeof value !== "string") return "";
  if (!/^https?:\/\//i.test(value)) return value;

  try {
    const response = await proxyFetch(value, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!response.ok) return value;
    const mimeType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    return value;
  }
}

function normalizeImageValue(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9+/=\s]{800,}$/.test(trimmed)) {
    return `data:image/png;base64,${trimmed.replace(/\s+/g, "")}`;
  }
  return "";
}

function findImageLikeValue(value, depth = 0) {
  if (!value || depth > 6) return "";
  if (typeof value === "string") return normalizeImageValue(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageLikeValue(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const priorityKeys = ["url", "image", "image_url", "b64_json", "base64", "data"];
    for (const key of priorityKeys) {
      const found = findImageLikeValue(value[key], depth + 1);
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      const found = findImageLikeValue(value[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function summarizeApiShape(value) {
  try {
    if (!value || typeof value !== "object") return String(value).slice(0, 300);
    const summary = {};
    for (const [key, item] of Object.entries(value).slice(0, 12)) {
      if (Array.isArray(item)) {
        summary[key] = `array(${item.length}) ${item[0] && typeof item[0] === "object" ? Object.keys(item[0]).slice(0, 10).join(",") : typeof item[0]}`;
      } else if (item && typeof item === "object") {
        summary[key] = `object(${Object.keys(item).slice(0, 10).join(",")})`;
      } else {
        summary[key] = typeof item;
      }
    }
    return JSON.stringify(summary);
  } catch (error) {
    return "无法解析返回结构";
  }
}

function shouldFallbackToGeneration(result) {
  const message = String(result.error?.message || result.error || "");
  return /not found|cannot post|unsupported|html|doctype|invalid json|404|405/i.test(message);
}

function shouldRetryAnalysis(result) {
  const message = String(result.error?.message || result.error || "");
  return /负载|较高|busy|overload|temporarily|timeout|rate limit|socket hang up/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readApiResult(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    const sample = text.replace(/\s+/g, " ").slice(0, 180);
    return {
      error: `接口返回的不是 JSON，可能 API 地址或模型接口不兼容。HTTP ${response.status}，返回内容：${sample}`,
    };
  }
}

async function testOpenAIConnection() {
  if (!apiConfig.apiKey) {
    throw new Error("缺少 API Key，请先保存 API 配置");
  }

  let response;
  try {
    response = await proxyFetch(`${apiConfig.apiBaseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
    });
  } catch (error) {
    throw new Error(`连接 OpenAI API 失败：${error.message}`);
  }

  const result = await readApiResult(response);

  if (!response.ok) {
    const message = result.error?.message || `OpenAI API 测试失败：${response.status}`;
    throw new Error(message);
  }

  return {
    ok: true,
    status: response.status,
    apiBaseUrl: apiConfig.apiBaseUrl,
    imageModel: apiConfig.imageModel,
    modelCount: Array.isArray(result.data) ? result.data.length : 0,
  };
}

async function proxyFetch(url, options = {}) {
  const proxyUrl = getProxyForUrl(url);
  if (proxyUrl) {
    return fetchViaHttpProxy(url, options, proxyUrl, new Error("直连已跳过，使用本地代理"));
  }

  try {
    return await fetch(url, options);
  } catch (directError) {
    throw directError;
  }
}

function fetchViaHttpProxy(url, options, proxy, directError) {
  return new Promise(async (resolve, reject) => {
    const target = new URL(url);
    const proxyTarget = new URL(proxy);

    if (target.protocol !== "https:") {
      reject(new Error(`只支持 HTTPS API 代理请求。直连错误：${directError.message}`));
      return;
    }

    let bodyBuffer = Buffer.alloc(0);
    const headers = { ...(options.headers || {}) };

    try {
      if (options.body) {
        const bodyResponse = new Response(options.body);
        const contentType = bodyResponse.headers.get("content-type");
        if (contentType && !headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = contentType;
        }
        const arrayBuffer = await bodyResponse.arrayBuffer();
        bodyBuffer = Buffer.from(arrayBuffer);
        if (!headers["Content-Length"] && !headers["content-length"]) {
          headers["Content-Length"] = String(bodyBuffer.length);
        }
      }
    } catch (error) {
      reject(new Error(`请求体转换失败：${error.message}`));
      return;
    }

    const socket = net.connect(Number(proxyTarget.port || 80), proxyTarget.hostname);
    socket.setTimeout(30000);

    socket.once("connect", () => {
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`);
    });

    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`连接代理 ${proxy} 超时。直连错误：${directError.message}`));
    });

    socket.once("error", (error) => {
      reject(new Error(`连接代理 ${proxy} 失败：${error.message}。直连错误：${directError.message}`));
    });

    let connectBuffer = Buffer.alloc(0);
    socket.on("data", function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      socket.off("data", onConnectData);
      const connectHeader = connectBuffer.slice(0, headerEnd).toString("utf8");
      const rest = connectBuffer.slice(headerEnd + 4);
      if (!/^HTTP\/1\.[01] 200/i.test(connectHeader)) {
        socket.destroy();
        reject(new Error(`代理 ${proxy} CONNECT 失败：${connectHeader.split("\r\n")[0]}。直连错误：${directError.message}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname,
      });

      const tlsSocket = https.request({
        host: target.hostname,
        servername: target.hostname,
        method: options.method || "GET",
        path: `${target.pathname}${target.search}`,
        headers,
        createConnection: () => secureSocket,
        timeout: 60000,
      }, (res) => {
        const chunks = [];
        res.on("data", (item) => chunks.push(item));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve(new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
          }));
        });
      });

      tlsSocket.on("error", (error) => reject(new Error(`代理请求 OpenAI 失败：${error.message}`)));
      tlsSocket.on("timeout", () => {
        tlsSocket.destroy();
        reject(new Error("代理请求 OpenAI 超时"));
      });
      if (rest.length) socket.unshift(rest);
      if (bodyBuffer.length) tlsSocket.write(bodyBuffer);
      tlsSocket.end();
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function isPublicStaticFile(safePath) {
  const normalized = String(safePath || "").replace(/\\/g, "/");
  return publicStaticFiles.has(normalized);
}

function getAdminConfig() {
  return {
    ...getPublicConfig(),
    apiKeyMask: maskApiKey(apiConfig.apiKey),
  };
}

function applyApiConfig(payload) {
  validateApiConfigInput(payload);
  if (payload.apiKey !== undefined && String(payload.apiKey).trim()) {
    apiConfig.apiKey = String(payload.apiKey).trim();
  }
  if (payload.apiBaseUrl !== undefined && String(payload.apiBaseUrl).trim()) {
    apiConfig.apiBaseUrl = normalizeBaseUrl(payload.apiBaseUrl);
  }
  if (payload.imageModel !== undefined && String(payload.imageModel).trim()) {
    apiConfig.imageModel = String(payload.imageModel).trim();
  }
  if (payload.llmModel !== undefined) {
    apiConfig.llmModel = String(payload.llmModel || "").trim();
  }
  saveConfig();
  return getAdminConfig();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/login") {
      if (getCurrentUser(req)) {
        redirect(res, "/");
        return;
      }
      serveFile(res, path.join(root, "login.html"));
      return;
    }

    if (req.method === "GET" && pathname === "/admin") {
      const user = getCurrentUser(req);
      if (!user) {
        redirect(res, "/login");
        return;
      }
      if (user.role !== "admin") {
        redirect(res, "/");
        return;
      }
      serveFile(res, path.join(root, "admin.html"));
      return;
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      const user = authStore.users.find((item) => item.username === username);
      if (!user || user.status !== "active" || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { error: "账号或密码错误，或账号已禁用" });
        return;
      }
      createSession(user, res);
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/register") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      const contact = String(payload.contact || "").trim();
      const note = String(payload.note || "").trim();
if (!isValidUsername(username)) {
        sendJson(res, 400, { error: "账号支持 2-32 位中文、字母、数字、下划线或横线" });
        return;
      }
      if (password.length < 6) {
        sendJson(res, 400, { error: "密码至少 6 位" });
        return;
      }
      if (authStore.users.some((item) => item.username === username)
        || authStore.pendingApplications.some((item) => item.username === username)) {
        sendJson(res, 400, { error: "账号已存在或正在审核中" });
        return;
      }
      authStore.pendingApplications.push({
        id: crypto.randomUUID(),
        username,
        passwordHash: hashPassword(password),
        contact,
        note,
        createdAt: new Date().toISOString(),
      });
      saveAuthStore();
      sendJson(res, 200, { ok: true, message: "申请已提交，等待管理员审核" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      clearSession(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const user = requireAuth(req, res);
      if (!user) return;
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/history") {
      const user = requireAuth(req, res);
      if (!user) return;
      sendJson(res, 200, { histories: getUserHistoryPayload(user) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/history") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const mode = normalizeTaskMode(payload.mode);
      const imageSrc = String(payload.src || "").trim();
      const label = String(payload.label || MODULE_LABELS[mode] || "最新").trim();
      if (!imageSrc) {
        sendJson(res, 400, { error: "缺少历史记录图片" });
        return;
      }
      persistHistoryImage(user, mode, imageSrc, label);
      sendJson(res, 200, { histories: getUserHistoryPayload(user) });
      return;
    }

    if (req.method === "DELETE" && pathname === "/api/history") {
      const user = requireAuth(req, res);
      if (!user) return;
      const modeParam = String(url.searchParams.get("mode") || "").trim();
      const mode = MODULE_KEYS.includes(modeParam) ? modeParam : "";
      clearHistoryForUser(user, mode || undefined);
      sendJson(res, 200, { histories: getUserHistoryPayload(user) });
      return;
    }

    const historyAssetMatch = /^\/api\/history\/assets\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && historyAssetMatch) {
      const user = requireAuth(req, res);
      if (!user) return;
      const ownerId = decodeURIComponent(historyAssetMatch[1]);
      const fileName = decodeURIComponent(historyAssetMatch[2]);
      if (user.role !== "admin" && String(user.id) !== ownerId) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      const filePath = resolveHistoryAssetPath(ownerId, fileName);
      if (!filePath || !fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      serveFile(res, filePath);
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      const admin = requireAdmin(req, res);
      if (!admin) return;

      if (req.method === "GET" && pathname === "/api/admin/users") {
        sendJson(res, 200, {
          users: authStore.users.map(publicUser),
          applications: authStore.pendingApplications.map((item) => ({
            id: item.id,
            username: item.username,
            contact: item.contact,
            note: item.note,
            createdAt: item.createdAt,
          })),
          usageLogs: authStore.usageLogs.slice(0, 50),
        });
        return;
      }

      const applicationMatch = /^\/api\/admin\/applications\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (applicationMatch && req.method === "POST") {
        const [, applicationId, action] = applicationMatch;
        const index = authStore.pendingApplications.findIndex((item) => item.id === applicationId);
        if (index === -1) {
          sendJson(res, 404, { error: "申请不存在" });
          return;
        }
        const application = authStore.pendingApplications[index];
        if (action === "approve") {
          if (authStore.users.some((item) => item.username === application.username)) {
            sendJson(res, 400, { error: "账号已存在，无法通过" });
            return;
          }
          authStore.users.push({
            id: authStore.nextUserId++,
            username: application.username,
            passwordHash: application.passwordHash,
            role: "user",
            status: "active",
            mustChangePassword: false,
            limits: defaultModuleLimits(),
            contact: application.contact,
            note: application.note,
            createdAt: new Date().toISOString(),
          });
        }
        authStore.pendingApplications.splice(index, 1);
        saveAuthStore();
        sendJson(res, 200, {
          users: authStore.users.map(publicUser),
          applications: authStore.pendingApplications,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/admin/users") {
        const payload = JSON.parse(await readBody(req) || "{}");
        const username = String(payload.username || "").trim();
        const password = String(payload.password || "");
        const role = payload.role === "admin" ? "admin" : "user";
if (!isValidUsername(username)) {
          sendJson(res, 400, { error: "账号支持 2-32 位中文、字母、数字、下划线或横线" });
          return;
        }
        if (authStore.users.some((item) => item.username === username)) {
          sendJson(res, 400, { error: "账号已存在" });
          return;
        }
        if (password.length < 6) {
          sendJson(res, 400, { error: "密码至少 6 位" });
          return;
        }
        authStore.users.push({
          id: authStore.nextUserId++,
          username,
          passwordHash: hashPassword(password),
          role,
          status: "active",
          mustChangePassword: false,
          limits: normalizeModuleLimits(payload.limits),
          createdAt: new Date().toISOString(),
        });
        saveAuthStore();
        sendJson(res, 200, { users: authStore.users.map(publicUser) });
        return;
      }

      const userMatch = /^\/api\/admin\/users\/(\d+)$/.exec(pathname);
      if (userMatch && req.method === "POST") {
        const target = authStore.users.find((item) => item.id === Number(userMatch[1]));
        if (!target) {
          sendJson(res, 404, { error: "用户不存在" });
          return;
        }
        const payload = JSON.parse(await readBody(req) || "{}");
        if (payload.password) {
          target.passwordHash = hashPassword(String(payload.password));
          target.mustChangePassword = false;
        }
        if (payload.role) target.role = payload.role === "admin" ? "admin" : "user";
        if (payload.status) target.status = payload.status === "disabled" ? "disabled" : "active";
        if (payload.limits) target.limits = normalizeModuleLimits(payload.limits);
        if (target.id === admin.id) {
          target.role = "admin";
          target.status = "active";
        }
        saveAuthStore();
        sendJson(res, 200, { users: authStore.users.map(publicUser) });
        return;
      }

      if (userMatch && req.method === "DELETE") {
        const targetId = Number(userMatch[1]);
        if (targetId === admin.id) {
          sendJson(res, 400, { error: "不能删除当前登录的管理员" });
          return;
        }
        authStore.users = authStore.users.filter((item) => item.id !== targetId);
        saveAuthStore();
        sendJson(res, 200, { users: authStore.users.map(publicUser) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin/config") {
        sendJson(res, 200, getAdminConfig());
        return;
      }

      if (req.method === "POST" && pathname === "/api/admin/config") {
        const payload = JSON.parse(await readBody(req) || "{}");
        const config = applyApiConfig(payload);
        sendJson(res, 200, config);
        return;
      }
    }

    if (req.method === "GET" && req.url === "/api/health") {
      const user = requireAuth(req, res);
      if (!user) return;
      sendJson(res, 200, {
        ok: true,
        ...getPublicConfig(),
        proxyUrl: getProxyForUrl(apiConfig.apiBaseUrl),
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/config") {
      const user = requireAuth(req, res);
      if (!user) return;
      sendJson(res, 200, getPublicConfig());
      return;
    }

    if (req.method === "POST" && req.url === "/api/config") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      sendJson(res, 200, applyApiConfig(payload));
      return;
    }

    if (req.method === "GET" && req.url === "/api/test-openai") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const result = await testOpenAIConnection();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && ["/api/hero/analyze", "/api/hero/render", "/api/hero/review"].includes(pathname)) {
      const user = requireAuth(req, res);
      if (!user) return;
      const payload = JSON.parse(await readBody(req) || "{}");
      if (pathname !== "/api/hero/render") {
        const analyze = pathname === "/api/hero/analyze";
        const analysis = await (analyze ? heroApi.analyze(payload) : heroApi.review(payload));
        logUsage(user, "analyze", "main");
        sendJson(res, 200, analysis);
        return;
      }
      if (heroRenders.has(user.id)) {
        sendJson(res, 409, { error: "已有一张图正在生成，请等它完成。" });
        return;
      }
      assertCanGenerate(user, "main");
      heroRenders.add(user.id);
      try {
        const result = await heroApi.render(payload);
        logUsage(user, "generate", "main");
        sendJson(res, 200, result);
      } finally {
        heroRenders.delete(user.id);
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/analyze") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const analysis = await analyzeImages(payload);
      logUsage(user, "analyze", normalizeTaskMode(payload.taskMode));
      sendJson(res, 200, analysis);
      return;
    }

    if (req.method === "POST" && req.url === "/api/edit-plan") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const plan = await analyzeEditReference(payload);
      logUsage(user, "analyze", "edit");
      sendJson(res, 200, plan);
      return;
    }

    if (req.method === "POST" && req.url === "/api/replacement-plan") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const plan = await analyzeReplacementTask(payload);
      logUsage(user, "analyze", "edit");
      sendJson(res, 200, plan);
      return;
    }

    if (req.method === "POST" && req.url === "/api/generate") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const taskMode = normalizeTaskMode(payload.taskMode);
      assertCanGenerate(user, taskMode);
      const image = await generateImage(payload);
      logUsage(user, "generate", taskMode);
      sendJson(res, 200, { image });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if ((pathname === "/" || pathname === "/index.html" || pathname === "/hero.html") && !getCurrentUser(req)) {
      redirect(res, "/login");
      return;
    }

    if (pathname === "/admin.html") {
      const user = getCurrentUser(req);
      if (!user) {
        redirect(res, "/login");
        return;
      }
      if (user.role !== "admin") {
        redirect(res, "/");
        return;
      }
    }

    const filePathname = pathname === "/" ? "/index.html" : pathname;
    const safePath = decodeURIComponent(filePathname).replace(/^\/+/, "");
    if (!isPublicStaticFile(safePath)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const filePath = path.resolve(root, safePath);
    if (filePath !== path.resolve(root) && !filePath.startsWith(rootWithSep)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    serveFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Main image optimizer: http://127.0.0.1:${port}`);
  if (host === "0.0.0.0") {
    console.log(`LAN/server access enabled on port ${port}. Use this machine's IP or your domain.`);
  }
});
