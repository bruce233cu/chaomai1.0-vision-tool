const http = require("http");
const https = require("https");
const tls = require("tls");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const rootWithSep = path.resolve(root) + path.sep;
const configPath = path.join(root, "api-config.local.json");
const authPath = path.join(root, "auth.local.json");
const lastResponsePath = path.join(root, "last-api-response.json");
const explicitProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.OPENAI_PROXY || "";
const savedConfig = loadSavedConfig();
const apiConfig = {
  apiKey: normalizeSavedApiKey(process.env.OPENAI_API_KEY || savedConfig.apiKey || ""),
  apiBaseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || savedConfig.apiBaseUrl || "https://api.openai.com/v1"),
  imageModel: process.env.OPENAI_IMAGE_MODEL || savedConfig.imageModel || "gpt-image-1.5",
  llmModel: process.env.OPENAI_LLM_MODEL || savedConfig.llmModel || "",
};
const MODULE_KEYS = ["edit", "main", "develop", "clone"];
const MODULE_LABELS = {
  edit: "提示词做图",
  main: "以图做图",
  develop: "产品开发",
  clone: "克隆详情",
};
const authStore = loadAuthStore();
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

async function generateImage(payload) {
  ensureApiReady();
  const imageSize = resolveImageSize(payload.aspectRatio);
  const strictReplacementMode = payload.sourceMode === "two-image-replacement";

  if (!payload.ownImage) {
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

  const image = parseDataUrl(payload.ownImage);
  const form = new FormData();
  form.append("model", apiConfig.imageModel);
  form.append("size", imageSize);
  form.append("quality", "high");
  form.append("n", "1");
  form.append("prompt", payload.prompt);
  form.append("image", new Blob([image.buffer], { type: image.mimeType }), image.fileName);
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
  if (!strictReplacementMode && !response.ok && shouldFallbackToGeneration(result)) {
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
  if (!payload.ownImage || !Array.isArray(payload.competitorImages) || payload.competitorImages.length === 0) {
    throw new Error("请上传自己的主图和至少 1 张竞品图");
  }

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
          { type: "text", text: "用户自己的当前主图" },
          { type: "image_url", image_url: { url: payload.ownImage } },
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
  const analysis = parseJsonFromText(content);
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
  if (!payload.productImage && !inspirationImages.length) {
    throw new Error("请至少上传 1 张产品图或灵感参考图");
  }

  const requestBody = {
    model: apiConfig.llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "你是资深电商广告 Prompt 编译总监，擅长把用户需求、产品图和参考图优点编译成高完成度的英文电商广告 Prompt。只输出 JSON，不要输出 Markdown。",
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
          { type: "text", text: "Image 1: locked template scene" },
          { type: "image_url", image_url: { url: payload.templateImage } },
          { type: "text", text: "Image 2: replacement product source" },
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
    "????????????????????????????????????????????????? Midjourney / Stable Diffusion / GPT-Image ?????????",
    "",
    "???????????????",
    "1. ??????????? / ?????????????????????",
    "2. ?????????????????????? proprietary product layer???????????????????",
    "3. ????????????????????????????????????????????? AI ??????",
    "",
    "???????????",
    "1. ?????",
    "2. ?????????",
    "3. ???????",
    "4. ????????",
    "5. ???????????????",
    "6. ????????????",
    "",
    "???????????????????????????????????????????????????????? Prompt?",
    "?? generationPrompt ????????????????????????????????????????????????????????????????????",
    "",
    "???????????",
    "1. ?????????????????????????????????????????????",
    "2. ????????????Logo???????????????????????????????????????",
    "3. ????????????????????????????????????????????????????????????????????????????????",
    "4. generationPrompt ??????????????????????????????????????????????",
    "5. generationPrompt ??????????????? proprietary product layer absolutely does not deform?????????????????????????????????????????????????",
    "6. generationPrompt ????????????????????????????? premium e-commerce hero image / high-end marketplace main image / commercial ad banner quality?",
    "7. generationPrompt ??????????????????????????????????????????????????",
    "8. ????????????????? generic headline area?generic feature badge area?generic promo ribbon area?generic info block area????????????????",
    "9. generationPrompt ???????????????????????????????????",
    "",
    "?? generationPrompt ??????????????????????????????",
    "- overall art direction and tone",
    "- composition and visual flow",
    "- model / lifestyle support if useful",
    "- product scale and focus",
    "- lighting, reflections, atmospheric depth, material rendering",
    "- premium ad finish and marketplace hero quality",
    "- strict product-lock instructions",
    "- negative exclusions for copied branding / distortion / ugly artifacts",
    "",
    `?????${payload.productName || "???"}` ,
    `??? / ???${payload.keywords || "???"}` ,
    `?????${payload.aspectRatio || "1:1"}` ,
    "",
    "???? JSON??? Markdown?????????????",
    "{",
    "  \"scores\": {\"overall\": number, \"background\": number, \"focus\": number},",
    "  \"visualDimensions\": {",
    "    \"sceneTone\": \"??????????????\",",
    "    \"hierarchy\": \"??????????????????\",",
    "    \"composition\": \"????????????????\",",
    "    \"marketing\": \"?????????????????\",",
    "    \"productFocus\": \"???????????????????\",",
    "    \"modelSupport\": \"????????????????????\"",
    "  },",
    "  \"generationPrompt\": \"???????????????????????? AI ?? Prompt??????? proprietary product layer absolutely does not deform????? premium e-commerce ad finish, cinematic commercial polish, clean visual hierarchy, material contrast, atmospheric depth, sophisticated retouching feel\"",
    "}",
    "",
    "??? JSON?",
  ].join("\n");
}
function buildEditPlanInstruction(payload) {
  return [
    "# Role",
    "你是顶级电商广告 Prompt 编译器，任务是把用户提示词、锁定产品图和灵感参考图，编译成一套可直接用于 gpt-image 的英文商业出图 Prompt。",
    "",
    "# Context",
    `用户原始需求：${payload.userPrompt || "未填写"}`,
    `产品名称：${payload.productName || "未填写"}`,
    `画幅比例：${payload.aspectRatio || "1:1"}`,
    `优化风格：${payload.styleLabel || payload.styleMode || "clean"}`,
    `模特/人物：${payload.modelLabel || payload.modelMode || "auto"}`,
    `产品角度：${payload.angleLabel || payload.angleMode || "auto"}`,
    `背景场景：${payload.backgroundLabel || payload.backgroundMode || "auto"}`,
    "",
    "# Task",
    "1. 如果存在锁定产品图，必须把它视为 proprietary product layer，最终生成图中的产品必须 100% 保持产品类型、轮廓、比例、拉链、肩带、口袋、缝线、五金、材质分区和颜色分区，不得变形，不得换品，不得重绘成另一款产品。",
    "2. 如果存在灵感参考图，只允许吸收它们的有效优点，例如场景调性、构图节奏、视觉动线、生活方式气质、版式留白、信息区块节奏、商业转化氛围，但绝对不能复制品牌、Logo、口号、原文案、原价格、原版式细节。",
    "3. 最终 generationPrompt 必须是单段完整纯英文，可以直接复制给 gpt-image 使用，不要输出中文 Prompt，不要输出多套版本。",
    "4. generationPrompt 的目标不是普通产品图，而是 premium e-commerce hero image / commercial ad banner / high-end marketplace main image。",
    "5. generationPrompt 必须比用户原始需求更导演化，明确写出：art direction、composition、model or lifestyle support、product dominance、lighting、material rendering、atmospheric depth、clean hierarchy、premium finish、negative exclusions。",
    "6. 允许写 generic headline area、generic feature badge area、generic promo ribbon area、generic info block area，但不能复制参考图原始文字。",
    "7. 如果用户提示词本身已经很强，不要削弱它；应在保留原始意图的基础上，把它编译得更像高完成度广告 Prompt。",
    "",
    "# Output",
    "严格输出 JSON，不要 Markdown：",
    "{",
    '  "analysisNotes": ["中文简短总结参考图值得吸收的优点，2-4条"],',
    '  "generationPrompt": "单段完整纯英文 Prompt，可直接用于 gpt-image；必须明确 proprietary product layer absolutely does not deform；必须体现 premium e-commerce ad finish、cinematic commercial polish、clean visual hierarchy、material contrast、atmospheric depth、sophisticated retouching feel；不得包含复制品牌和原文案的要求"',
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
    "1. Image 1 is the locked template scene. It defines the person, hands, pose, background, lighting, crop, perspective, composition, props, text blocks, packaging, and every non-target element.",
    "2. Image 2 is the only replacement product source. Preserve its structure, silhouette, proportions, materials, printed details, hardware, seams, and key identity.",
    "3. Replace only the primary product object in Image 1. Be specific about which object should be replaced based on the template scene.",
    "4. Keep all non-target scene elements visually unchanged. Do not redraw the person, background, props, typography layout, extra packaging, or secondary objects unless the user explicitly asked for that.",
    "5. The final prompt must tell GPT-Image to match the original contact point, occlusion, hand relationship, support point, perspective, lighting, cast shadow, reflected light, and scale so the replacement looks naturally photographed in the template scene.",
    "6. Output only one direct-to-use English edit prompt. No markdown.",
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
  const basePrompt = String(raw.generationPrompt || "").trim();

  const fallbackPrompt = [
    `Create a premium e-commerce hero image for ${payload.productName || "the product"} using the user's prompt as the main creative direction: ${payload.userPrompt || "upgrade the product visual appeal"}.`,
    "If an uploaded product image is provided, treat it as the proprietary product layer and preserve it with 100% fidelity: absolutely do not deform, redraw, replace, simplify, or reinterpret the product.",
    "Do not change the product structure, silhouette, proportions, zippers, straps, pockets, seams, hardware, material segmentation, or key identifying details.",
    "Build a high-end commercial ad composition around the product with clear visual hierarchy, premium material rendering, atmospheric depth, refined lighting, and marketplace hero quality.",
    "You may include generic ad layout zones such as a headline area, feature badge area, or promo ribbon area, but do not copy any brand names, slogans, logos, or exact text from references.",
    "Avoid watermark, QR code, copied brand identity, random text, garbled letters, cheap collage feeling, and low-resolution artifacts.",
  ].join("\n");

  const prompt = basePrompt || fallbackPrompt;

  return {
    analysisNotes,
    prompt,
  };
}

function normalizeReplacementPlan(raw, payload) {
  const analysisNotes = asStringArray(raw.analysisNotes).slice(0, 4);
  const basePrompt = String(raw.generationPrompt || "").trim();
  const productName = String(payload.productName || "").trim();
  const fallbackPrompt = [
    "CRITICAL PRODUCT REPLACEMENT EDIT.",
    "Image 1 is the locked template scene. Image 2 is the only replacement product source.",
    `Follow the user instruction exactly: ${payload.userPrompt || "Replace the product in image 1 with the product in image 2 and keep everything else unchanged."}`,
    productName ? `Target product name: ${productName}.` : "",
    "Replace only the primary product object in the template scene. Keep the same person, hands, pose, clothing, props, text layout, packaging, background, camera angle, crop, perspective, lighting, shadows, reflections, depth of field, and overall composition.",
    "Match the replacement product to the original scene contact point, occlusion, hand relationship, support point, scale, highlights, material response, reflected light, and cast shadow so it looks naturally photographed in the template scene.",
    "Preserve the replacement product structure, silhouette, proportions, printed details, hardware, seams, and edges. Do not deform, redesign, simplify, or swap it for another product.",
    "Do not add or remove unrelated elements. Do not redraw the model. Do not alter non-target props or the background.",
  ].filter(Boolean).join("\n");

  return {
    analysisNotes,
    prompt: basePrompt || fallbackPrompt,
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

    if ((pathname === "/" || pathname === "/index.html") && !getCurrentUser(req)) {
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
