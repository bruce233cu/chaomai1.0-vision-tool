const state = {
  mode: "edit",
  own: null,
  competitors: [],
  editImages: [],
  ownMetrics: null,
  competitorMetrics: [],
  lastAnalysis: null,
  history: [],
  histories: {
    main: [],
    edit: [],
    develop: [],
    clone: [],
  },
  historyMode: "edit",
  modeData: {
    edit: null,
    main: null,
    develop: null,
    clone: null,
  },
  activePromptIndex: 0,
  abortController: null,
  isGenerating: false,
  aspectRatio: "1:1",
  currentUser: null,
  pasteTarget: null,
};

const els = {
  productName: document.querySelector("#productName"),
  modeTabs: document.querySelectorAll(".mode-tabs .tab[data-mode]"),
  imageEditSection: document.querySelector("#imageEditSection"),
  editPrompt: document.querySelector("#editPrompt"),
  editImages: document.querySelector("#editImages"),
  editDrop: document.querySelector("#editDrop"),
  editPreview: document.querySelector("#editPreview"),
  clearEditBtn: document.querySelector("#clearEditBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  userLabel: document.querySelector("#userLabel"),
  adminLink: document.querySelector("#adminLink"),
  logoutBtn: document.querySelector("#logoutBtn"),
  settingsModal: document.querySelector("#settingsModal"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  currentApiName: document.querySelector("#currentApiName"),
  historyList: document.querySelector("#historyList"),
  apiKey: document.querySelector("#apiKey"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  imageModel: document.querySelector("#imageModel"),
  llmModel: document.querySelector("#llmModel"),
  apiConfigStatus: document.querySelector("#apiConfigStatus"),
  saveApiConfigBtn: document.querySelector("#saveApiConfigBtn"),
  testApiConfigBtn: document.querySelector("#testApiConfigBtn"),
  keywords: document.querySelector("#keywords"),
  styleMode: document.querySelector("#styleMode"),
  modelMode: document.querySelector("#modelMode"),
  angleMode: document.querySelector("#angleMode"),
  backgroundMode: document.querySelector("#backgroundMode"),
  ratioButtons: document.querySelectorAll(".ratio-grid .ratio"),
  ownImage: document.querySelector("#ownImage"),
  competitorImages: document.querySelector("#competitorImages"),
  ownSectionTitle: document.querySelector("#ownSectionTitle"),
  ownDropTitle: document.querySelector("#ownDropTitle"),
  ownDropHint: document.querySelector("#ownDropHint"),
  competitorSectionTitle: document.querySelector("#competitorSectionTitle"),
  competitorDropTitle: document.querySelector("#competitorDropTitle"),
  competitorDropHint: document.querySelector("#competitorDropHint"),
  clearOwnBtn: document.querySelector("#clearOwnBtn"),
  clearCompetitorsBtn: document.querySelector("#clearCompetitorsBtn"),
  ownDrop: document.querySelector("#ownDrop"),
  competitorDrop: document.querySelector("#competitorDrop"),
  ownPreview: document.querySelector("#ownPreview"),
  competitorPreview: document.querySelector("#competitorPreview"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  cancelBtn: document.querySelector("#cancelBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  downloadBtn: document.querySelector("#downloadBtn"),
  copyPromptBtn: document.querySelector("#copyPromptBtn"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  generatedImage: document.querySelector("#generatedImage"),
  analysisOutput: document.querySelector("#analysisOutput"),
  analysisMeta: document.querySelector("#analysisMeta"),
  statusPill: document.querySelector("#statusPill"),
  generationProgress: document.querySelector("#generationProgress"),
  progressText: document.querySelector("#progressText"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  stageLoading: document.querySelector("#stageLoading"),
  stageLoadingText: document.querySelector("#stageLoadingText"),
  stageLoadingMeta: document.querySelector("#stageLoadingMeta"),
  compareModal: document.querySelector("#compareModal"),
  closeCompareBtn: document.querySelector("#closeCompareBtn"),
  compareTitle: document.querySelector("#compareTitle"),
  compareSubtitle: document.querySelector("#compareSubtitle"),
  compareSourceLabel: document.querySelector("#compareSourceLabel"),
  compareSourceImage: document.querySelector("#compareSourceImage"),
  compareGeneratedPane: document.querySelector("#compareGeneratedPane"),
  compareGeneratedImage: document.querySelector("#compareGeneratedImage"),
  canvas: document.querySelector("#outputCanvas"),
  canvasWrap: document.querySelector(".canvas-wrap"),
};

const ctx = els.canvas.getContext("2d");

function setStatus(text) {
  els.statusPill.textContent = text;
}

function setGenerationState(active, label = "生成中", current = 0, total = 1) {
  state.isGenerating = active;
  els.cancelBtn.hidden = !active;
  els.generationProgress.hidden = !active;
  els.stageLoading.hidden = !active;
  els.generateBtn.disabled = active || els.generateBtn.disabled;
  updateGenerationProgress(label, current, total);
}

function updateGenerationProgress(label, current, total) {
  const safeTotal = Math.max(1, total || 1);
  const percent = Math.max(0, Math.min(100, Math.round((current / safeTotal) * 100)));
  if (els.progressText) els.progressText.textContent = `${label} ${current}/${safeTotal}`;
  if (els.progressPercent) els.progressPercent.textContent = `${percent}%`;
  if (els.progressBar) els.progressBar.style.width = `${percent}%`;
  if (els.stageLoadingText) els.stageLoadingText.textContent = label;
  if (els.stageLoadingMeta) els.stageLoadingMeta.textContent = `${current}/${safeTotal}`;
}

function cancelGeneration() {
  const isAnalyzing = !els.analyzeBtn.hidden && els.analyzeBtn.disabled && els.analyzeBtn.textContent.includes("分析");
  if (state.abortController) {
    state.abortController.abort();
  }
  setStatus(isAnalyzing ? "已取消分析" : "已取消生成");
}

function createModeSnapshot() {
  return {
    own: state.own,
    competitors: [...state.competitors],
    editImages: [...state.editImages],
    editPrompt: els.editPrompt?.value || "",
    ownMetrics: state.ownMetrics,
    competitorMetrics: [...state.competitorMetrics],
    lastAnalysis: state.lastAnalysis,
    activePromptIndex: state.activePromptIndex,
    generatedSrc: els.generatedImage?.getAttribute("src") || "",
    hasOutput: els.canvasWrap?.classList.contains("has-output") || false,
    hasGenerated: els.canvasWrap?.classList.contains("has-generated") || false,
    downloadDisabled: Boolean(els.downloadBtn?.disabled),
  };
}

function saveModeSnapshot(mode = state.mode) {
  if (!["edit", "main", "develop", "clone"].includes(mode)) return;
  state.modeData[mode] = createModeSnapshot();
}

function restoreModeSnapshot(mode) {
  const snapshot = state.modeData[mode] || {
    own: null,
    competitors: [],
    ownMetrics: null,
    competitorMetrics: [],
    lastAnalysis: null,
    activePromptIndex: 0,
    editImages: [],
    editPrompt: "",
    generatedSrc: "",
    hasOutput: false,
    hasGenerated: false,
    downloadDisabled: true,
  };
  state.own = snapshot.own;
  state.competitors = [...snapshot.competitors];
  state.editImages = [...(snapshot.editImages || [])];
  if (els.editPrompt) els.editPrompt.value = snapshot.editPrompt || "";
  state.ownMetrics = snapshot.ownMetrics;
  state.competitorMetrics = [...snapshot.competitorMetrics];
  state.lastAnalysis = snapshot.lastAnalysis;
  state.activePromptIndex = snapshot.activePromptIndex || 0;
  if (snapshot.generatedSrc) {
    els.generatedImage.src = snapshot.generatedSrc;
  } else {
    els.generatedImage.removeAttribute("src");
  }
  els.canvasWrap.classList.toggle("has-output", Boolean(snapshot.hasOutput));
  els.canvasWrap.classList.toggle("has-generated", Boolean(snapshot.hasGenerated));
  els.downloadBtn.disabled = Boolean(snapshot.downloadDisabled);
  renderPreviews();
}

function setMode(mode) {
  saveModeSnapshot(state.mode);
  state.mode = mode;
  state.historyMode = mode;
  document.body.dataset.mode = mode;
  state.lastAnalysis = null;
  state.activePromptIndex = 0;
  els.analysisMeta.textContent = "未分析";
  els.analysisOutput.innerHTML = mode === "develop"
    ? "<p>上传自己的产品图和竞品产品图后，点击分析。系统会从结构、材质、功能、外观卖点和使用痛点总结产品升级方向。</p>"
    : mode === "clone"
      ? "<p>上传自己的替换产品图，再上传一张克隆参考图。系统会尽量保持参考图的背景、人物、光影、构图和整体氛围，只替换目标产品。</p>"
    : "<p>上传自己的主图和竞品参考图后，点击分析。系统会对主体、背景、卖点、模特、角度和场景进行总结。</p>";
  els.copyPromptBtn.disabled = true;
  els.modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  updateHistoryTabs();
  renderHistory();
  if (els.imageEditSection) {
    els.imageEditSection.hidden = mode !== "edit";
  }
  setUploadLabels(mode);
  restoreModeSnapshot(mode);
  if (mode !== "edit" && state.lastAnalysis) {
    renderAnalysis(state.lastAnalysis);
  }

  if (mode === "edit") {
    els.analyzeBtn.style.display = "none";
    els.generateBtn.disabled = !els.editPrompt.value.trim();
    saveModeSnapshot("edit");
    els.generateBtn.textContent = "立即生成";
    setStatus("提示词做图");
  } else if (mode === "clone") {
    els.analyzeBtn.style.display = "none";
    els.generateBtn.disabled = !(state.own && state.competitors.length);
    els.generateBtn.textContent = "立即克隆";
    setStatus("克隆详情");
  } else if (mode === "develop") {
    els.analyzeBtn.style.display = "";
    els.generateBtn.disabled = !state.lastAnalysis;
    els.generateBtn.textContent = "立即生成";
    setStatus(state.lastAnalysis ? "产品开发方案已生成" : "等待上传");
  } else {
    els.analyzeBtn.style.display = "";
    els.generateBtn.disabled = !state.lastAnalysis;
    els.generateBtn.textContent = "立即生成";
    setStatus(state.lastAnalysis ? "分析方案已生成" : "等待上传");
  }
}

function setUploadLabels(mode) {
  const clone = mode === "clone";
  const develop = mode === "develop";
  els.ownSectionTitle.textContent = clone ? "自己的产品" : develop ? "自己的产品图" : "自己的图片";
  els.ownDropTitle.textContent = clone ? "上传替换产品图" : develop ? "上传当前产品图" : "上传当前图片";
  els.ownDropHint.textContent = clone ? "只提供要替换进去的产品" : "支持拖拽 / 点击上传";
  els.competitorSectionTitle.textContent = clone ? "克隆参考图" : develop ? "竞品产品图" : "竞品 / 参考图";
  els.competitorDropTitle.textContent = clone ? "上传克隆参考图" : develop ? "上传竞品产品图" : "上传竞品 / 参考图";
  els.competitorDropHint.textContent = clone ? "参考图会锁定背景、人物、光影和构图" : develop ? "系统会分析产品共性优点" : "系统会分析共性优点";
}

function openSettings() {
  if (state.currentUser?.role !== "admin") return;
  els.settingsModal.classList.add("open");
  els.settingsModal.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  els.settingsModal.classList.remove("open");
  els.settingsModal.setAttribute("aria-hidden", "true");
}

async function loadCurrentUser() {
  try {
    const response = await fetch(getApiUrl("/api/me"));
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "请先登录");
    state.currentUser = result.user;
    if (els.userLabel) {
      els.userLabel.textContent = result.user.role === "admin"
        ? `${result.user.username} · 管理员`
        : result.user.username;
    }
    if (els.adminLink) {
      els.adminLink.hidden = result.user.role !== "admin";
    }
    if (els.settingsBtn) {
      els.settingsBtn.hidden = result.user.role !== "admin";
    }
  } catch (error) {
    location.href = "/login";
  }
}

async function loadApiConfig() {
  try {
    const response = await fetch(getApiUrl("/api/config"));
    const config = await readJsonResponse(response);
    if (!response.ok) throw new Error(config.error || "读取 API 配置失败");
    els.apiBaseUrl.value = config.apiBaseUrl || "";
    els.imageModel.value = config.imageModel || "gpt-image-1.5";
    els.llmModel.value = config.llmModel || "";
    els.apiConfigStatus.textContent = config.hasApiKey ? `已配置 ${config.apiKeyMask}` : "未配置 Key";
    if (els.currentApiName) {
      els.currentApiName.textContent = config.imageModel || "未配置";
    }
    if (!config.hasApiKey && state.currentUser?.role === "admin") openSettings();
  } catch (error) {
    els.apiConfigStatus.textContent = "服务未连接";
  }
}

async function saveApiConfig() {
  els.saveApiConfigBtn.disabled = true;
  els.saveApiConfigBtn.textContent = "保存中...";
  try {
    const response = await fetch(getApiUrl("/api/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: els.apiKey.value.trim(),
        apiBaseUrl: els.apiBaseUrl.value.trim(),
        imageModel: els.imageModel.value.trim(),
        llmModel: els.llmModel.value.trim(),
      }),
    });
    const config = await readJsonResponse(response);
    if (!response.ok) throw new Error(config.error || "保存失败");
    els.apiKey.value = "";
    els.apiBaseUrl.value = config.apiBaseUrl || "";
    els.imageModel.value = config.imageModel || "";
    els.llmModel.value = config.llmModel || "";
    els.apiConfigStatus.textContent = config.hasApiKey ? `已配置 ${config.apiKeyMask}` : "未配置 Key";
    if (els.currentApiName) {
      els.currentApiName.textContent = config.imageModel || "未配置";
    }
    setStatus("API 已保存");
    closeSettings();
  } catch (error) {
    alert(`API 配置保存失败：${error.message}`);
  } finally {
    els.saveApiConfigBtn.disabled = false;
    els.saveApiConfigBtn.textContent = "保存 API";
  }
}

async function testApiConfig() {
  els.testApiConfigBtn.disabled = true;
  els.testApiConfigBtn.textContent = "测试中...";
  try {
    const response = await fetch(getApiUrl("/api/test-openai"));
    const result = await readJsonResponse(response);
    if (!response.ok || !result.ok) throw new Error(result.error || "测试失败");
    els.apiConfigStatus.textContent = `连接成功 · ${result.imageModel || "image"}`;
    setStatus("API 连接成功");
    alert(`API 连接成功：${result.apiBaseUrl}`);
  } catch (error) {
    alert(`API 连接失败：${error.message}`);
    els.apiConfigStatus.textContent = "连接失败";
  } finally {
    els.testApiConfigBtn.disabled = false;
    els.testApiConfigBtn.textContent = "测试连接";
  }
}

function readFiles(files, limit = Infinity) {
  const selected = Array.from(files).slice(0, limit);
  return Promise.all(selected.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve({ file, src: reader.result, image });
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })));
}

function renderPreviews() {
  els.ownPreview.innerHTML = "";
  els.competitorPreview.innerHTML = "";
  if (els.editPreview) {
    els.editPreview.innerHTML = "";
  }

  if (state.own) {
    els.ownPreview.appendChild(createThumb(state.own, state.ownMetrics, "自己的图片", clearOwnUpload));
  }

  state.competitors.forEach((item, index) => {
    els.competitorPreview.appendChild(createThumb(item, state.competitorMetrics[index], state.mode === "clone" ? "克隆参考图" : "参考图", () => removeCompetitorImage(index)));
  });

  state.editImages.forEach((item, index) => {
    els.editPreview.appendChild(createThumb(item, null, "提示词参考图", () => removeEditImage(index)));
  });

  els.ownDrop.classList.toggle("has-file", Boolean(state.own));
  els.competitorDrop.classList.toggle("has-file", state.competitors.length > 0);
  if (els.editDrop) els.editDrop.classList.toggle("has-file", state.editImages.length > 0);
}

function createThumb(item, metrics, label = "上传图", onRemove) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.title = "点击放大对比";
  thumb.tabIndex = 0;
  thumb.setAttribute("role", "button");
  thumb.addEventListener("click", () => openCompare(item.src, label));
  thumb.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCompare(item.src, label);
    }
  });

  const img = document.createElement("img");
  img.src = item.src;
  img.alt = item.file.name;
  thumb.appendChild(img);

  if (metrics) {
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `评分 ${metrics.score}`;
    thumb.appendChild(score);
  }

  if (onRemove) {
    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.type = "button";
    remove.title = "移除这张图";
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      onRemove();
    });
    thumb.appendChild(remove);
  }

  return thumb;
}

function getImageMetrics(image) {
  const sample = document.createElement("canvas");
  const size = 160;
  sample.width = size;
  sample.height = size;
  const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
  sampleCtx.drawImage(image, 0, 0, size, size);

  const data = sampleCtx.getImageData(0, 0, size, size).data;
  let brightness = 0;
  let saturation = 0;
  let edgeEnergy = 0;
  let lightPixels = 0;
  let darkPixels = 0;
  let centerEnergy = 0;
  let borderEnergy = 0;
  const colorBuckets = new Map();

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = (r * .299 + g * .587 + b * .114);
      brightness += lum;
      saturation += max === 0 ? 0 : (max - min) / max;
      if (lum > 218) lightPixels += 1;
      if (lum < 42) darkPixels += 1;
      if (lum > 48 && lum < 238 && (max - min) > 16) {
        const key = `${Math.round(r / 32) * 32},${Math.round(g / 32) * 32},${Math.round(b / 32) * 32}`;
        colorBuckets.set(key, (colorBuckets.get(key) || 0) + 1);
      }

      if (x > 0 && y > 0) {
        const prev = ((y - 1) * size + (x - 1)) * 4;
        const diff = Math.abs(r - data[prev]) + Math.abs(g - data[prev + 1]) + Math.abs(b - data[prev + 2]);
        edgeEnergy += diff;
        if (x > 38 && x < 122 && y > 38 && y < 122) centerEnergy += diff;
        if (x < 20 || x > 140 || y < 20 || y > 140) borderEnergy += diff;
      }
    }
  }

  const pixels = size * size;
  const averageBrightness = Math.round(brightness / pixels);
  const averageSaturation = Math.round((saturation / pixels) * 100);
  const cleanBackground = Math.round(Math.max(0, Math.min(100, lightPixels / pixels * 130 - darkPixels / pixels * 40)));
  const subjectFocus = Math.round(Math.max(0, Math.min(100, (centerEnergy / Math.max(edgeEnergy, 1)) * 145)));
  const borderClutter = Math.round(Math.max(0, Math.min(100, (borderEnergy / Math.max(edgeEnergy, 1)) * 180)));
  const texture = Math.round(Math.max(0, Math.min(100, edgeEnergy / 11000)));
  const palette = Array.from(colorBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key]) => {
      const [r, g, b] = key.split(",").map(Number);
      return { r, g, b, hex: rgbToHex(r, g, b) };
    });
  const score = Math.round(
    cleanBackground * .28 +
    subjectFocus * .26 +
    (100 - Math.abs(averageBrightness - 184) * .7) * .18 +
    Math.min(100, averageSaturation * 1.35) * .14 +
    Math.min(100, texture * 1.2) * .14
  );

  return {
    brightness: averageBrightness,
    saturation: averageSaturation,
    cleanBackground,
    subjectFocus,
    borderClutter,
    texture,
    palette,
    score: Math.max(0, Math.min(100, score)),
  };
}

function averageMetrics(list) {
  const keys = ["brightness", "saturation", "cleanBackground", "subjectFocus", "borderClutter", "texture", "score"];
  const result = keys.reduce((current, key) => {
    current[key] = Math.round(list.reduce((sum, item) => sum + item[key], 0) / Math.max(list.length, 1));
    return current;
  }, {});
  result.palette = getSharedPalette(list);
  return result;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function getSharedPalette(list) {
  const buckets = new Map();
  list.forEach((item) => {
    item.palette.forEach((color, index) => {
      const weight = 5 - index;
      buckets.set(color.hex, (buckets.get(color.hex) || 0) + weight);
    });
  });
  return Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hex]) => hex);
}

function buildAnalysis() {
  const own = state.ownMetrics;
  const avg = averageMetrics(state.competitorMetrics);
  const keywords = els.keywords.value.split(/[,，、\s]+/).filter(Boolean).slice(0, 4);
  const productName = els.productName.value.trim() || "产品";

  const strengths = [];
  const weaknesses = [];
  const gaps = [];
  const actions = [];
  const creative = buildCreativeDirection(avg);
  const paletteText = avg.palette.length ? avg.palette.join(" / ") : "清爽浅色";

  if (avg.cleanBackground >= 58) strengths.push("竞品普遍使用更干净的浅色或低干扰背景，搜索流里主体更容易被快速识别。");
  if (avg.subjectFocus >= 42) strengths.push("竞品主体集中度较高，产品通常占据画面中心区域，缩略图状态下更有点击优势。");
  if (avg.saturation >= 24) strengths.push("竞品色彩更醒目，能在列表页形成更强的第一眼记忆点。");
  if (avg.texture >= 34) strengths.push("竞品边缘和材质细节更清楚，容易传达品质感。");
  if (strengths.length === 0) strengths.push("竞品整体没有形成明显统一优势，建议优先做清晰度、主体比例和卖点表达。");

  if (avg.borderClutter >= 42) weaknesses.push("部分竞品边缘元素偏多，画面会显得拥挤，可以用更克制的版式避开。");
  if (avg.saturation >= 45) weaknesses.push("竞品中存在饱和度过高的倾向，容易廉价化，优化图应保留醒目但控制色彩数量。");
  if (avg.brightness < 135) weaknesses.push("部分竞品亮度偏低，列表页可能不够轻快，建议用更明亮的背景拉开差异。");
  if (weaknesses.length === 0) weaknesses.push("竞品短板不明显，建议用更明确的卖点标签和更稳定的高级感建立差异。");

  if (own.cleanBackground + 8 < avg.cleanBackground) gaps.push("你的主图背景干净度低于竞品，建议弱化杂物、提高背景明度。");
  if (own.subjectFocus + 8 < avg.subjectFocus) gaps.push("你的主图主体集中度不足，建议放大产品并靠近画面中心。");
  if (own.saturation + 8 < avg.saturation) gaps.push("你的主图色彩记忆点弱于竞品，建议增加品牌色或卖点色块。");
  if (own.texture + 8 < avg.texture) gaps.push("你的主图材质细节不够突出，建议增加边缘高光和清晰度。");
  if (gaps.length === 0) gaps.push("你的主图基础表现接近竞品，优化重点应放在卖点更明确、画面更统一。");

  actions.push(`保持我方产品图层完全不动，围绕“${productName}”只重绘周围场景、空间关系和匹配光影，建议视觉主体占比：${creative.subjectRatio}。`);
  actions.push(`场景方向：${creative.background}。产品角度只作为周围透视和光影匹配参考：${creative.angle}。`);
  actions.push("自动过滤参考图中的品牌、Logo、商标、文字、水印和价格信息，不新增抢占主体的文案标签。");
  actions.push(`环境色与光影可参考竞品高频色：${paletteText}，但只用于背景氛围和接触阴影，不改变产品本体。`);
  actions.push("只吸收竞品的商业氛围、构图逻辑和光影层次，不复刻竞品主体、装饰元素或版式。");

  const visualDimensions = {
    sceneTone: `参考图整体适合提炼为${creative.background}，画面需要保持商业摄影的干净、真实和高点击感。`,
    hierarchy: "第一视觉必须是我方产品图层，卖点信息只作为辅助，不能抢占主体。",
    composition: `主体比例建议控制在 ${creative.subjectRatio}，通过周围场景、透视关系和匹配光影把视线引向产品。`,
    marketing: "使用更真实的生活方式场景和柔和高级光影，提升用户对使用场景、品质和转化价值的联想。",
    productFocus: "我方产品图层必须完全不动，只允许生成周围场景、环境关系和匹配光影。",
    modelSupport: "识别参考图中的模特或辅助产品表达方式，但最终提示词不主动新增人物主体，只保留必要的场景氛围。",
  };
  const positivePrompt = [
    "Commercial e-commerce image editing, local repaint and background replacement.",
    "Keep the proprietary product layer completely fixed, untouched, pixel-locked and structurally identical.",
    "Do not move, resize, redraw, reshape, recolor, warp, bend, simplify or reinterpret the proprietary product layer.",
    "Only generate the surrounding scene, background environment, spatial context, matching shadows, contact shadows, reflected light and realistic commercial photography lighting.",
    "Create a premium marketplace hero image for PREMIUM_BRAND with a clean high-conversion e-commerce visual style.",
    "Scene direction: a clean premium lifestyle or studio environment inspired by the reference images, without copying any exact layout, logo, text, brand mark or decorative identity.",
    `Keep product focus strong, with the proprietary product layer as the first visual center and approximately ${creative.subjectRatio} of the visual composition.`,
    "Incorporate the reference-image advantages only as generic commercial guidance: clear hierarchy, clean background, strong product focus, refined lighting, premium texture, natural depth, high marketplace conversion impact.",
    "Avoid reference-image weaknesses: cluttered layout, excessive decorative elements, low-end color treatment, copied brand identity, distracting text, poor shadow matching, pasted composite look.",
    "Use generic premium commercial styling only, no copied brand identity, no reference-image logos, no watermark, no random text, no price tags.",
    "Photorealistic, natural perspective, coherent depth of field, clean background, refined material highlights, high-end marketplace hero image.",
  ].join(" ");
  const negativePrompt = [
    "deformed product, distorted product, warped product, changed product structure, changed product shape, changed product size, changed product color, changed product material, redesigned product, extra product parts, missing product parts",
    "moving the proprietary product layer, redrawing the proprietary product layer, replacing the proprietary product layer, bending straps, broken edges, melted geometry, incorrect perspective on the product",
    "brand logo copied from reference image, watermark, random letters, garbled text, price label, QR code, low-resolution, blurry product, messy background, overdecorated layout, unnecessary model, unnecessary hands, distorted body, extra fingers, bad shadows, pasted look",
  ].join(", ");
  const prompt = `Positive Prompt:\n${positivePrompt}\n\nNegative Prompt:\n${negativePrompt}`;

  return {
    avg,
    strengths,
    weaknesses,
    gaps,
    actions,
    creative,
    visualDimensions,
    positivePrompt,
    negativePrompt,
    prompt,
    promptVariants: [{ title: "方案", focus: "局部重绘/背景替换，产品图层不动", prompt }],
  };
}

function buildCreativeDirection(avg) {
  const modelMap = {
    hand: "使用干净手部或局部手持展示，突出真实使用感，手部不遮挡产品主体",
    half: "使用半身生活方式模特，模特作为辅助氛围，产品保持第一视觉中心",
    none: "不加人物，使用大主体产品图，适合强功能和强价格心智",
  };
  const angleMap = {
    front: "正面主视角，保证图案和外观第一眼可识别",
    angle45: "45 度立体角度，展示厚度、边缘和材质层次",
    combo: "正面大图 + 侧面小图组合，兼顾点击和信息量",
  };
  const backgroundMap = {
    bathroom: "明亮浴室背景，白色瓷砖、柔和自然光、干净无杂物",
    vanity: "梳妆台 / 洗漱台背景，浅色台面、柔和反光、生活方式氛围",
    hotel: "轻奢酒店浴室背景，暖光、石材台面、品质感陈列",
    plain: "纯色高点击背景，低干扰浅色底，适合搜索流缩略图",
  };
  const autoModel = avg.subjectFocus > 46 ? "none" : "hand";
  const autoAngle = avg.texture > 38 ? "angle45" : "combo";
  const autoBg = avg.cleanBackground > 60 ? "plain" : avg.brightness > 155 ? "bathroom" : "hotel";
  const modelKey = els.modelMode.value === "auto" ? autoModel : els.modelMode.value;
  const angleKey = els.angleMode.value === "auto" ? autoAngle : els.angleMode.value;
  const bgKey = els.backgroundMode.value === "auto" ? autoBg : els.backgroundMode.value;

  return {
    modelKey,
    angleKey,
    bgKey,
    model: modelMap[modelKey],
    angle: angleMap[angleKey],
    background: backgroundMap[bgKey],
    subjectRatio: angleKey === "combo" ? "主产品 62%-70%，辅助角度图 18%-24%" : "68%-78%",
  };
}

function renderAnalysis(analysis) {
  const metric = analysis.avg;
  const prompt = buildImagePrompt(analysis);
  const isDevelop = state.mode === "develop";
  if (!isDevelop) {
    const dimensions = analysis.visualDimensions || {};
    const dimensionItems = [
      ["1. 场景与调性", dimensions.sceneTone || "已根据参考图提炼适合电商转化的场景调性。"],
      ["2. 信息层级与卖点传达", dimensions.hierarchy || "已弱化无效干扰，保留产品核心卖点和第一视觉焦点。"],
      ["3. 构图与视觉动线", dimensions.composition || "已按参考图构图逻辑规划主体占比、场景透视和视觉焦点。"],
      ["4. 营销氛围与转化力", dimensions.marketing || "已提炼参考图的商业氛围，用于提升点击率和购买联想。"],
      ["5. 产品占比与核心聚焦点", dimensions.productFocus || "已要求保持我方产品图层完全不动，并强化产品主体聚焦。"],
      ["6. 模特表达与辅助产品", dimensions.modelSupport || "已识别参考图中的人物/辅助元素表达，但提示词只生成周围场景和匹配光影。"],
    ];

    els.analysisMeta.textContent = "提示词已生成";
    els.analysisOutput.innerHTML = `
      <div class="analysis-block compact-scheme">
        <h3>核心视觉维度分析</h3>
        <ul>
          ${dimensionItems.map(([title, value]) => `<li><strong>${escapeHtml(title)}：</strong>${escapeHtml(value)}</li>`).join("")}
        </ul>
      </div>
      <div class="analysis-block">
        <h3>我方产品直出绘图提示词（方案：局部重绘/背景替换）</h3>
        <div class="prompt-box prompt-code" id="promptBox">${escapeHtml(prompt)}</div>
      </div>
    `;
    els.copyPromptBtn.disabled = false;
    els.generateBtn.disabled = false;
    return;
  }
  if (!isDevelop && analysis.visualDimensions) {
    const dimensions = analysis.visualDimensions || {};
    els.analysisMeta.textContent = `${state.competitorMetrics.length} 张参考图`;
    els.analysisOutput.innerHTML = `
      <div class="metric-grid">
        <div class="metric"><strong>${metric.score}</strong><span>参考综合分</span></div>
        <div class="metric"><strong>${metric.cleanBackground}</strong><span>背景控制</span></div>
        <div class="metric"><strong>${metric.subjectFocus}</strong><span>主体聚焦</span></div>
      </div>
      <div class="analysis-block">
        <h3>核心视觉维度分析</h3>
        <ul>
          <li><strong>1. 场景与调性：</strong>${escapeHtml(dimensions.sceneTone || "")}</li>
          <li><strong>2. 信息层级与卖点传达：</strong>${escapeHtml(dimensions.hierarchy || "")}</li>
          <li><strong>3. 构图与视觉动线：</strong>${escapeHtml(dimensions.composition || "")}</li>
          <li><strong>4. 营销氛围与转化力：</strong>${escapeHtml(dimensions.marketing || "")}</li>
          <li><strong>5. 产品占比与核心聚焦点：</strong>${escapeHtml(dimensions.productFocus || "")}</li>
          <li><strong>6. 模特表达与辅助产品：</strong>${escapeHtml(dimensions.modelSupport || "")}</li>
        </ul>
      </div>
      ${renderBlock("参考图优点", analysis.strengths)}
      ${renderBlock("参考图待改进", analysis.weaknesses)}
      ${analysis.commonPatterns?.length ? renderBlock("多参考图共性总结", analysis.commonPatterns) : ""}
      ${renderBlock("方案执行策略", analysis.actions)}
      <div class="analysis-block">
        <h3>我方产品直出绘图提示词（方案：局部重绘/背景替换）</h3>
        ${renderPromptVariants(analysis)}
        <div class="prompt-box prompt-code" id="promptBox">${escapeHtml(prompt)}</div>
      </div>
    `;
    els.copyPromptBtn.disabled = false;
    els.generateBtn.disabled = false;
    return;
  }
  const promptSources = [
    isDevelop ? "竞品产品优点会作为设计升级方向进入提示词" : "竞品优点会作为必须吸收项进入提示词",
    isDevelop ? "竞品产品待提升点会作为避坑方向进入提示词" : "竞品待优化点会作为必须避开项进入提示词",
    isDevelop ? "你的产品差距会作为设计改良重点进入提示词" : "你的主图差距会作为加工重点进入提示词",
    isDevelop ? "材质、结构、功能卖点、外观比例会统一进入最终提示词" : "模特、角度、背景、主体比例会统一进入最终画面要求",
  ];
  els.analysisMeta.textContent = `${state.competitorMetrics.length} 张竞品`;
  els.analysisOutput.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><strong>${metric.score}</strong><span>竞品综合均分</span></div>
      <div class="metric"><strong>${metric.cleanBackground}</strong><span>背景干净度</span></div>
      <div class="metric"><strong>${metric.subjectFocus}</strong><span>主体集中度</span></div>
    </div>
    <div class="palette-row">
      ${(metric.palette || []).map((color) => `<span style="background:${color}" title="${color}"></span>`).join("")}
      <em>竞品高频色已用于优化图背景和卖点标签</em>
    </div>
    ${renderBlock(isDevelop ? "竞品产品好在哪里" : "竞品主图好在哪里", analysis.strengths)}
    ${renderBlock(isDevelop ? "竞品产品待提升点" : "竞品待优化点", analysis.weaknesses)}
    ${analysis.commonPatterns?.length ? renderBlock(isDevelop ? "多竞品产品共性总结" : "多竞品共性总结", analysis.commonPatterns) : ""}
    ${renderBlock(isDevelop ? "你的产品差距" : "你的主图差距", analysis.gaps)}
    ${renderBlock(isDevelop ? "本次产品升级策略" : "本次优化策略", analysis.actions)}
    ${renderBlock("提示词融合依据", promptSources)}
    ${renderBlock("生成画面要求（与提示词同源）", [
      `模特：${analysis.creative.model}`,
      `产品角度：${analysis.creative.angle}`,
      `背景：${analysis.creative.background}`,
      `主体比例：${analysis.creative.subjectRatio}`
    ])}
    <div class="analysis-block">
      <h3>${isDevelop ? "产品开发提示词（已融合竞品产品共性）" : "最终加工提示词（已融合竞品优点/缺点）"}</h3>
      ${renderPromptVariants(analysis)}
      <div class="prompt-box" id="promptBox">${escapeHtml(prompt)}</div>
    </div>
  `;
  els.copyPromptBtn.disabled = false;
  els.generateBtn.disabled = false;
}

function renderPromptVariants(analysis) {
  if (!analysis.promptVariants?.length) return "";
  return `
    <div class="prompt-variants">
      ${analysis.promptVariants.map((variant, index) => (
        `<button class="${index === state.activePromptIndex ? "active" : ""}" type="button" data-prompt-index="${index}">${escapeHtml(variant.title || `版本 ${index + 1}`)}</button>`
      )).join("")}
    </div>
  `;
}

function renderBlock(title, items) {
  return `
    <div class="analysis-block">
      <h3>${title}</h3>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSelectText(select) {
  if (!select) return "";
  return select.options[select.selectedIndex]?.textContent?.trim() || select.value || "";
}

function getControlDirectives() {
  const directives = [
    `画幅比例：${state.aspectRatio}`,
    `优化风格：${getSelectText(els.styleMode)}`,
    `模特/人物：${getSelectText(els.modelMode)}`,
    `产品角度：${getSelectText(els.angleMode)}`,
    `背景场景：${getSelectText(els.backgroundMode)}`,
  ];
  return directives.filter((item) => item && !/自动建议|根据竞品自动建议|auto/i.test(item));
}

function buildPromptWithControls(prompt, title = "用户选择的生成控制，必须执行") {
  const directives = getControlDirectives();
  if (!directives.length) return prompt;
  return [
    title,
    ...directives.map((item) => `- ${item}`),
    "",
    prompt,
  ].join("\n");
}

function buildEditDirectorPrompt(userPrompt, { hasOwnImage = false } = {}) {
  const styleMap = {
    clean: "Aim for a clean, high-click marketplace hero image with polished simplicity.",
    premium: "Aim for a premium, refined, upscale marketplace hero image with elevated material feel.",
    functional: "Aim for a feature-forward, conversion-focused marketplace hero image with strong clarity.",
    scene: "Aim for a lifestyle-driven, scene-rich marketplace hero image with commercial polish.",
  };
  const modelMap = {
    auto: "Allow tasteful lifestyle support only if it improves the ad finish while keeping the product dominant.",
    hand: "If useful, include subtle hand-held product support that feels naturally photographed.",
    half: "If useful, include a tasteful half-body lifestyle model support while keeping the product as the hero.",
    none: "Do not include a visible person; keep the scene product-focused.",
  };
  const angleMap = {
    auto: "",
    front: "Prefer a confident front-facing hero angle.",
    angle45: "Prefer a refined 45-degree hero angle.",
    combo: "Allow one main hero angle with subtle secondary angle support only if it improves the commercial finish.",
  };
  const backgroundMap = {
    auto: "",
    bathroom: "Use a bright, clean, realistic lifestyle environment only if it fits the product and prompt.",
    vanity: "Use a polished tabletop or vanity-like lifestyle environment only if it fits the product and prompt.",
    hotel: "Use a refined hospitality-style environment only if it fits the product and prompt.",
    plain: "Keep the background clean and high-conversion with minimal distraction.",
  };

  return [
    userPrompt,
    `Canvas aspect ratio: ${state.aspectRatio}.`,
    styleMap[els.styleMode.value] || styleMap.clean,
    modelMap[els.modelMode.value] || modelMap.auto,
    angleMap[els.angleMode.value] || "",
    backgroundMap[els.backgroundMode.value] || "",
    hasOwnImage
      ? "Use the uploaded product image as the proprietary product layer and preserve it with 100% fidelity."
      : "",
    hasOwnImage
      ? "The proprietary product layer absolutely must not deform, must not be redrawn, and must not change structure, silhouette, proportions, zippers, straps, pockets, seams, hardware, material segmentation, or key identifying details."
      : "",
    "Turn the result into a premium e-commerce hero image / commercial ad banner / high-end marketplace main image with strong visual hierarchy, premium lighting, material contrast, atmospheric depth, and sophisticated retouching feel.",
    "You may use clean generic headline area, feature badge area, promo ribbon area, or info block area when they improve the ad finish, but do not copy real brand names, logos, slogans, prices, or exact reference text.",
    "Avoid watermark, QR code, random text, garbled letters, trademark infringement, cheap collage feeling, low-resolution artifacts, and blurry product edges.",
  ].filter(Boolean).join("\n");
}

function isTwoImageReplacementPrompt(prompt, imageCount) {
  if (imageCount < 2) return false;
  const text = String(prompt || "").toLowerCase();
  const hasNumberedReference = /(图1|图2|image\s*1|image\s*2)/i.test(text);
  const hasReplaceIntent = /(替换|replace|swap|换成|替成)/i.test(text);
  const hasKeepOthers = /(其他元素不变|其余元素不变|其他不变|others? unchanged|keep .* unchanged|everything else unchanged)/i.test(text);
  return hasNumberedReference && hasReplaceIntent && hasKeepOthers;
}

function normalizeReplacementProductName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (/^(admin|提示词做图|替换产品|目标产品)$/i.test(name)) return "";
  return name;
}

function buildEditReplacementPrompt(userPrompt, productName, extraNotes = "") {
  const normalizedName = normalizeReplacementProductName(productName);
  return [
    "CRITICAL PRODUCT REPLACEMENT EDIT.",
    "Treat the uploaded base image as the locked template scene.",
    "Treat the uploaded replacement product image as the only product source to insert.",
    `User instruction to follow exactly: ${userPrompt}`,
    normalizedName ? `Target product name: ${normalizedName}.` : "",
    "Keep the template scene unchanged: preserve the same hands, person, face, body pose, clothing, props, background, camera angle, crop, perspective, lens, lighting, shadows, reflections, depth of field, typography layout, and overall composition unless the user explicitly asks otherwise.",
    "Only replace the single main product that appears in the template scene with the replacement product source. Do not replace secondary props or packaging unless the user explicitly asks for that.",
    "The replacement product must match the original scene perspective, scale, contact point, occlusion, hand relationship, support point, cast shadow, reflected light, highlights, material response, and environmental color. It must look naturally photographed in the template scene, not pasted.",
    "Preserve the replacement product's structure, silhouette, proportions, printed details, hardware, edges, seams, and key visual identity. Do not deform or redesign it.",
    "Do not add or remove unrelated scene elements. Do not change the template background. Do not redraw the person. Do not introduce random text, watermark, QR code, or extra accessories.",
    extraNotes ? `Replacement-specific scene notes: ${extraNotes}` : "",
  ].filter(Boolean).join("\n");
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

function buildImagePrompt(analysis) {
  const variant = analysis.promptVariants?.[state.activePromptIndex];
  const candidatePrompt = stripPromptEnhancerLines(variant?.prompt || analysis.prompt || "");
  if (state.mode !== "develop") {
    if (candidatePrompt) return candidatePrompt;
    const rawPrompt = stripPromptEnhancerLines(String(analysis.rawPrompt || "").trim());
    if (rawPrompt) return rawPrompt;
    const positive = stripPromptEnhancerLines(String(analysis.positivePrompt || "").trim());
    const negative = String(analysis.negativePrompt || "").trim();
    if (positive && negative) return `Positive Prompt:
${positive}

Negative Prompt:
${negative}`;
    if (positive) return positive;
  }
  if (variant?.prompt) return buildPromptWithControls(variant.prompt);
  if (analysis.prompt) return buildPromptWithControls(analysis.prompt);
  const productName = els.productName.value.trim() || "?????";
  const keywords = els.keywords.value.split(/[,??s]+/).filter(Boolean).slice(0, 5);
  const styleMap = {
    clean: "?????????",
    premium: "????????",
    functional: "????????",
    scene: "????????",
  };

  return [
    `?????????????????/??????????????????????${productName}?`,
    `?????${styleMap[els.styleMode.value]}?`,
    `????/????${keywords.length ? keywords.join("?") : "???????? 2-3 ?????"}?`,
    "",
    "??????????",
    ...analysis.strengths.map((item) => `- ${item}`),
    "",
    "?????????/?????",
    ...analysis.weaknesses.map((item) => `- ${item}`),
    "",
    "?????????",
    ...analysis.gaps.map((item) => `- ${item}`),
    "",
    "??????????????????????",
    `- ??/???${analysis.creative.model}`,
    `- ?????${analysis.creative.angle}`,
    `- ?????${analysis.creative.background}`,
    `- ?????${analysis.creative.subjectRatio}`,
    ...analysis.actions.map((item) => `- ${item}`),
    "",
    "???????????????????????????????????????????????????????????????/??????????????????????????????????????????????????????????logo ????????????????1:1 ????????????",
  ].join("\n");
}
function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const chars = text.split("");
  let line = "";
  let lines = [];

  chars.forEach((char) => {
    const test = line + char;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = char;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  lines = lines.slice(0, maxLines);
  lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = parseInt(normalized.length === 3
    ? normalized.split("").map((item) => item + item).join("")
    : normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function mixHex(hex, target, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(
    Math.round(a.r + (b.r - a.r) * amount),
    Math.round(a.g + (b.g - a.g) * amount),
    Math.round(a.b + (b.b - a.b) * amount)
  );
}

function getCompetitorStyle() {
  const avg = state.lastAnalysis?.avg || averageMetrics(state.competitorMetrics);
  const palette = avg.palette?.length ? avg.palette : ["#2f6df6", "#7cb3ff", "#f4c76b"];
  const accent = palette[0];
  const second = palette[1] || mixHex(accent, "#ffffff", .45);
  return {
    avg,
    accent,
    second,
    bgStart: avg.cleanBackground > 52 ? mixHex(second, "#ffffff", .82) : mixHex(second, "#ffffff", .66),
    bgEnd: avg.brightness > 170 ? mixHex(accent, "#ffffff", .72) : mixHex(accent, "#ffffff", .58),
    text: avg.brightness > 150 ? "#152033" : "#ffffff",
  };
}

function createCutout(image) {
  const maxSide = 920;
  const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.round(image.width * ratio);
  const h = Math.round(image.height * ratio);
  const source = document.createElement("canvas");
  source.width = w;
  source.height = h;
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(image, 0, 0, w, h);

  const imageData = sourceCtx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const cornerSize = Math.max(8, Math.floor(Math.min(w, h) * .08));
  const bg = getCornerAverage(data, w, h, cornerSize);
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let kept = 0;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const diff = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      const distToCenter = Math.hypot((x - w / 2) / w, (y - h / 2) / h);
      const keep = diff > 54 || distToCenter < .28;
      if (!keep) {
        data[i + 3] = Math.max(0, Math.min(255, (diff - 22) * 5));
      }
      if (data[i + 3] > 32) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        kept += 1;
      }
    }
  }

  sourceCtx.putImageData(imageData, 0, 0);
  if (kept < w * h * .16 || kept > w * h * .92) {
    return { canvas: source, x: 0, y: 0, width: w, height: h, cutout: false };
  }

  const pad = Math.round(Math.min(w, h) * .04);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w, maxX + pad);
  maxY = Math.min(h, maxY + pad);
  return { canvas: source, x: minX, y: minY, width: maxX - minX, height: maxY - minY, cutout: true };
}

function getCornerAverage(data, w, h, cornerSize) {
  const points = [
    [0, 0],
    [w - cornerSize, 0],
    [0, h - cornerSize],
    [w - cornerSize, h - cornerSize],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  points.forEach(([startX, startY]) => {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const i = (y * w + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
      }
    }
  });
  return { r: r / count, g: g / count, b: b / count };
}

function drawPill(ctx, text, x, y, width, height, fill, stroke, color) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, x, y, width, height, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "800 28px Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, x + width / 2, y + height / 2 + 10);
}

function drawSceneBackground(ctx, creative, style) {
  if (creative.bgKey === "plain") return;

  ctx.save();
  ctx.globalAlpha = .52;
  if (creative.bgKey === "bathroom") {
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.lineWidth = 3;
    for (let x = 0; x <= 1200; x += 150) {
      ctx.beginPath();
      ctx.moveTo(x, 300);
      ctx.lineTo(x, 930);
      ctx.stroke();
    }
    for (let y = 330; y <= 930; y += 120) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1200, y);
      ctx.stroke();
    }
  }
  if (creative.bgKey === "vanity" || creative.bgKey === "hotel") {
    ctx.fillStyle = creative.bgKey === "hotel" ? "rgba(118, 96, 76, .24)" : "rgba(210, 220, 226, .46)";
    drawRoundedRect(ctx, 86, 690, 1028, 260, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.42)";
    drawRoundedRect(ctx, 700, 345, 320, 260, 8);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = style === "premium" ? "rgba(255,255,255,.48)" : "rgba(255,255,255,.36)";
  ctx.beginPath();
  ctx.ellipse(1010, 225, 118, 118, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawModelCue(ctx, creative, accent) {
  if (creative.modelKey === "none") return;

  ctx.save();
  ctx.globalAlpha = .92;
  ctx.fillStyle = "rgba(244, 206, 178, .72)";
  ctx.strokeStyle = "rgba(126, 92, 76, .25)";
  ctx.lineWidth = 3;
  if (creative.modelKey === "hand") {
    ctx.translate(810, 720);
    ctx.rotate(-0.25);
    drawRoundedRect(ctx, 0, 0, 310, 82, 38);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 4; i += 1) {
      drawRoundedRect(ctx, 44 + i * 54, -42, 48, 124, 22);
      ctx.fill();
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.ellipse(955, 390, 78, 92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = mixHex(accent, "#ffffff", .34);
    drawRoundedRect(ctx, 845, 490, 220, 360, 90);
    ctx.fill();
  }
  ctx.restore();
}

function drawAngleCue(ctx, creative, cutout, x, y, w, h) {
  if (creative.angleKey !== "combo") return;

  ctx.save();
  ctx.globalAlpha = .88;
  ctx.shadowColor = "rgba(20, 28, 40, .18)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 16;
  ctx.filter = "contrast(1.06) saturate(1.05) brightness(1.06)";
  ctx.translate(900, 665);
  ctx.rotate(.14);
  ctx.drawImage(cutout.canvas, cutout.x, cutout.y, cutout.width, cutout.height, -95, -140, 190, 280);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,.84)";
  drawRoundedRect(ctx, 810, 805, 190, 46, 8);
  ctx.fill();
  ctx.fillStyle = "#233047";
  ctx.font = "800 22px Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("侧面角度", 905, 835);
  ctx.restore();
}

function renderOptimizedImage() {
  const own = state.own;
  const productName = els.productName.value.trim() || "品质好物";
  const keywords = els.keywords.value.split(/[,，、\s]+/).filter(Boolean).slice(0, 3);
  const style = els.styleMode.value;
  const competitorStyle = getCompetitorStyle();
  const creative = state.lastAnalysis?.creative || buildCreativeDirection(competitorStyle.avg);
  const cutout = createCutout(own.image);
  const accent = competitorStyle.accent;
  const second = competitorStyle.second;
  const avg = competitorStyle.avg;

  ctx.clearRect(0, 0, 1200, 1200);

  const bg = ctx.createLinearGradient(0, 0, 1200, 1200);
  bg.addColorStop(0, competitorStyle.bgStart);
  bg.addColorStop(1, competitorStyle.bgEnd);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1200, 1200);
  drawSceneBackground(ctx, creative, style);
  drawModelCue(ctx, creative, accent);

  ctx.save();
  ctx.globalAlpha = avg.cleanBackground > 55 ? .12 : .2;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  for (let x = -80; x < 1280; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 360, 1200);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = .2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(630, 765, 430, 95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = .34;
  ctx.fillStyle = mixHex(accent, "#ffffff", .36);
  ctx.beginPath();
  ctx.ellipse(640, 790, 360, 58, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const competitorZoom = avg.subjectFocus > state.ownMetrics.subjectFocus ? 1.15 : 1.06;
  const maxW = style === "functional" ? 760 : 850;
  const maxH = style === "functional" ? 700 : 770;
  const ratio = Math.min(maxW / cutout.width, maxH / cutout.height) * competitorZoom;
  const drawW = cutout.width * ratio;
  const drawH = cutout.height * ratio;
  const drawX = (1200 - drawW) / 2;
  const drawY = 245 + (650 - drawH) / 2;

  ctx.save();
  ctx.shadowColor = "rgba(20, 28, 40, .32)";
  ctx.shadowBlur = cutout.cutout ? 44 : 24;
  ctx.shadowOffsetY = cutout.cutout ? 30 : 18;
  ctx.filter = `contrast(${avg.texture > state.ownMetrics.texture ? 1.16 : 1.08}) saturate(${avg.saturation > state.ownMetrics.saturation ? 1.16 : 1.08}) brightness(${avg.brightness > state.ownMetrics.brightness ? 1.08 : 1.02})`;
  ctx.drawImage(cutout.canvas, cutout.x, cutout.y, cutout.width, cutout.height, drawX, drawY, drawW, drawH);
  ctx.restore();
  drawAngleCue(ctx, creative, cutout, drawX, drawY, drawW, drawH);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = .22;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(drawX + drawW * .34, drawY + drawH * .18, drawW * .3, drawH * .08, -.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#17202d";
  ctx.font = "800 68px Microsoft YaHei, sans-serif";
  ctx.textAlign = "left";
  wrapText(ctx, productName, 78, 120, 700, 78, 2);

  ctx.font = "700 28px Microsoft YaHei, sans-serif";
  ctx.fillStyle = accent;
  ctx.fillText("AI 生成方案预览", 82, 245);

  ctx.save();
  ctx.fillStyle = accent;
  drawRoundedRect(ctx, 930, 84, 176, 58, 8);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 29px Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("点击感升级", 1018, 122);
  ctx.restore();

  const tagText = keywords.length ? keywords : ["主体突出", "质感升级", "高点击"];
  tagText.forEach((tag, index) => {
    const x = 78 + index * 220;
    const y = 990;
    drawPill(
      ctx,
      tag,
      x,
      y,
      185,
      64,
      index === 0 ? accent : "rgba(255,255,255,.86)",
      index === 0 ? accent : mixHex(accent, "#ffffff", .38),
      index === 0 ? "#ffffff" : accent
    );
  });

  ctx.save();
  ctx.globalAlpha = .96;
  ctx.fillStyle = mixHex(second, "#ffffff", .26);
  drawRoundedRect(ctx, 78, 1084, 420, 52, 8);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 24px Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${creative.modelKey === "none" ? "无人物" : "人物辅助"} · ${creative.angleKey === "combo" ? "多角度" : "单主角度"} · ${creative.bgKey === "plain" ? "纯色背景" : "真实场景"}`, 288, 1118);
  ctx.restore();

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(23, 32, 45, .76)";
  ctx.font = "700 26px Microsoft YaHei, sans-serif";
  ctx.fillText("清晰主体 · 干净背景 · 卖点聚焦", 1122, 1110);

  els.canvasWrap.classList.add("has-output");
  els.downloadBtn.disabled = false;
  saveModeSnapshot();
}

async function analyze() {
  if (!state.own) {
    alert(state.mode === "develop" ? "请先上传自己的产品图。" : "请先上传自己的主图。");
    return;
  }
  if (state.competitors.length < 1) {
    alert(state.mode === "develop" ? "请至少上传 1 张竞品产品图，建议 3-9 张。" : "请至少上传 1 张竞品主图，建议 3-9 张。");
    return;
  }

  setStatus(state.mode === "develop" ? "正在分析产品" : "正在分析");
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "分析中...";
  state.abortController = new AbortController();
  setGenerationState(true, state.mode === "develop" ? "产品分析" : "参考图分析", 0, 4);
  updateGenerationProgress(state.mode === "develop" ? "读取产品图" : "读取参考图", 1, 4);
  state.ownMetrics = getImageMetrics(state.own.image);
  state.competitorMetrics = state.competitors.map((item) => getImageMetrics(item.image));
  renderPreviews();
  try {
    updateGenerationProgress("连接分析 API", 2, 4);
    await checkApiServer();
    updateGenerationProgress(state.mode === "develop" ? "分析产品卖点" : "拆解参考图", 3, 4);
    const response = await fetch(getApiUrl("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownImage: state.own.src,
        competitorImages: state.competitors.map((item) => item.src),
        productName: els.productName.value.trim(),
        keywords: els.keywords.value.trim(),
        styleMode: els.styleMode.value,
        modelMode: els.modelMode.value,
        angleMode: els.angleMode.value,
        backgroundMode: els.backgroundMode.value,
        aspectRatio: state.aspectRatio,
        taskMode: state.mode,
      }),
      signal: state.abortController.signal,
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(result.error || "分析失败");
    }
    updateGenerationProgress("整理方案提示词", 4, 4);
    state.lastAnalysis = mergeMetricFallback(result);
    state.activePromptIndex = 0;
    renderAnalysis(state.lastAnalysis);
    els.canvasWrap.classList.remove("has-output", "has-generated");
    els.generatedImage.removeAttribute("src");
    els.downloadBtn.disabled = true;
    saveModeSnapshot();
    setStatus(state.mode === "develop" ? "产品开发方案已生成" : "分析方案已生成");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("已取消分析");
      return;
    }
    updateGenerationProgress("生成本地基础方案", 4, 4);
    state.lastAnalysis = buildAnalysis();
    renderAnalysis(state.lastAnalysis);
    saveModeSnapshot();
    console.warn("API analysis failed, using local repaint/background analysis:", error);
    setStatus(state.mode === "develop" ? "API忙，已生成本地产品方案" : "API忙，已生成本地方案");
  } finally {
    state.abortController = null;
    setGenerationState(false);
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "分析方案";
  }
}

function mergeMetricFallback(analysis) {
  const fallback = buildAnalysis();
  return {
    ...analysis,
    avg: {
      ...fallback.avg,
      ...(analysis.avg || {}),
      palette: analysis.avg?.palette?.length ? analysis.avg.palette : fallback.avg.palette,
    },
    creative: {
      ...fallback.creative,
      ...(analysis.creative || {}),
    },
    strengths: analysis.strengths?.length ? analysis.strengths : fallback.strengths,
    weaknesses: analysis.weaknesses?.length ? analysis.weaknesses : fallback.weaknesses,
    commonPatterns: analysis.commonPatterns?.length ? analysis.commonPatterns : [],
    gaps: analysis.gaps?.length ? analysis.gaps : fallback.gaps,
    actions: analysis.actions?.length ? analysis.actions : fallback.actions,
    visualDimensions: analysis.visualDimensions || fallback.visualDimensions,
    positivePrompt: analysis.positivePrompt || fallback.positivePrompt,
    negativePrompt: analysis.negativePrompt || fallback.negativePrompt,
    promptVariants: analysis.promptVariants?.length ? analysis.promptVariants : [],
    prompt: analysis.prompt || buildImagePrompt(fallback),
  };
}

function getModeHistory(mode = state.historyMode || state.mode) {
  if (!state.histories[mode]) state.histories[mode] = [];
  return state.histories[mode];
}

function addHistoryImage(src, label = "最新", mode = state.mode) {
  const history = getModeHistory(mode);
  history.unshift({ src, label, time: Date.now(), mode });
  state.histories[mode] = history.slice(0, 12);
  renderHistory();
}

function updateHistoryTabs() {
  document.querySelectorAll("[data-history-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.historyMode === state.historyMode);
  });
}

function renderHistory() {
  if (!els.historyList) return;
  const history = getModeHistory();
  updateHistoryTabs();
  if (!history.length) {
    els.historyList.innerHTML = `<div class="history-empty">暂无生成记录</div>`;
    return;
  }
  els.historyList.innerHTML = history.map((item, index) => `
    <button class="history-thumb" type="button" data-history-index="${index}">
      <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.label)}">
      <span>${escapeHtml(index === 0 ? "最新" : item.label)}</span>
    </button>
  `).join("");
}

function openCompare(sourceSrc, label = "上传图") {
  if (!sourceSrc || !els.compareModal) return;
  const generatedSrc = els.generatedImage?.getAttribute("src") || "";
  els.compareTitle.textContent = generatedSrc ? "图片对比" : "图片预览";
  els.compareSubtitle.textContent = generatedSrc ? "左侧为上传图，右侧为当前生成图" : "当前还没有生成图，先放大查看上传图";
  els.compareSourceLabel.textContent = label;
  els.compareSourceImage.src = sourceSrc;
  if (generatedSrc) {
    els.compareGeneratedImage.src = generatedSrc;
    els.compareGeneratedPane.hidden = false;
  } else {
    els.compareGeneratedImage.removeAttribute("src");
    els.compareGeneratedPane.hidden = true;
  }
  els.compareModal.classList.add("open");
  els.compareModal.setAttribute("aria-hidden", "false");
}

function closeCompare() {
  els.compareModal.classList.remove("open");
  els.compareModal.setAttribute("aria-hidden", "true");
}

async function generateRealImage() {
  if (state.mode === "edit") {
    await generateEditImages();
    return;
  }
  if (state.mode === "clone") {
    await generateCloneImage();
    return;
  }
  if (!state.own || !state.lastAnalysis) {
    alert("请先上传图片并点击分析方案。");
    return;
  }

  const promptFromPanel = document.querySelector("#promptBox")?.textContent || buildImagePrompt(state.lastAnalysis);
  const selectedVariant = state.mode === "develop" && state.lastAnalysis.promptVariants?.length
    ? state.lastAnalysis.promptVariants[0]
    : null;
  const variants = [{
    title: selectedVariant?.title || (state.mode === "develop" ? "产品开发方案" : "方案"),
    prompt: selectedVariant?.prompt || promptFromPanel,
  }];
  const progressLabel = state.mode === "develop" ? "产品开发" : "方案作图";
  setStatus("AI 正在生成");
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "生成中...";
  state.abortController = new AbortController();
  setGenerationState(true, progressLabel, 0, variants.length);

  try {
    await checkApiServer();

    for (let index = 0; index < variants.length; index += 1) {
      setStatus(`AI 正在生成 ${index + 1}/${variants.length}`);
      updateGenerationProgress(progressLabel, index, variants.length);
      const variantPrompt = variants[index].prompt || "";
      const promptToSend = state.mode !== "develop" ? variantPrompt : (variantPrompt.includes("Positive Prompt:") && variantPrompt.includes("Negative Prompt:") ? variantPrompt : buildPromptWithControls(variantPrompt));
      const response = await fetch(getApiUrl("/api/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptToSend,
          ownImage: state.own.src,
          productName: els.productName.value.trim(),
          keywords: els.keywords.value.trim(),
          styleMode: els.styleMode.value,
          modelMode: els.modelMode.value,
          angleMode: els.angleMode.value,
          backgroundMode: els.backgroundMode.value,
          aspectRatio: state.aspectRatio,
          taskMode: state.mode,
        }),
        signal: state.abortController.signal,
      });

      const result = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(result.error || "生成失败");
      }

      els.generatedImage.src = result.image;
      addHistoryImage(result.image, variants[index].title || `方案 ${index + 1}`);
      updateGenerationProgress(progressLabel, index + 1, variants.length);
    }

    els.canvasWrap.classList.add("has-output", "has-generated");
    els.downloadBtn.disabled = false;
    saveModeSnapshot();
    setStatus("真实图已生成");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("已取消生成");
    } else {
      alert(`AI 生成失败：${error.message}`);
      setStatus("生成失败");
    }
  } finally {
    state.abortController = null;
    setGenerationState(false);
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "立即生成";
  }
}

async function generateEditImages() {
  const prompt = els.editPrompt.value.trim();
  if (!prompt) {
    alert("请先输入关键词或提示词。");
    return;
  }

  setStatus("提示词做图生成中");
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "生成中...";
  state.abortController = new AbortController();

  try {
    await checkApiServer();
    const uploadedImages = state.editImages.slice(0, 8);
    const isReplacementTask = isTwoImageReplacementPrompt(prompt, uploadedImages.length);
    const productImage = uploadedImages[0] || null;
    const inspirationImages = uploadedImages.slice(1);
    const hasProductImage = Boolean(productImage);
    const hasInspiration = inspirationImages.length > 0;
    let compiledPrompt = buildEditDirectorPrompt(prompt, { hasOwnImage: hasProductImage });
    let generateOwnImage = productImage?.src || "";
    let generateReferenceImages = [];

    if (isReplacementTask) {
      const templateImage = uploadedImages[1];
      if (!templateImage) {
        throw new Error("双图替换任务至少需要 2 张图：图1为替换产品，图2为模板场景。");
      }
      const productName = normalizeReplacementProductName(els.productName.value);
      setGenerationState(true, "双图替换", 0, 2);
      setStatus("正在分析模板场景");
      updateGenerationProgress("双图替换", 1, 2);
      const planResponse = await fetch(getApiUrl("/api/replacement-plan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateImage: templateImage.src,
          replacementImage: productImage?.src || "",
          userPrompt: prompt,
          productName,
          keywords: els.keywords.value.trim(),
          aspectRatio: state.aspectRatio,
          taskMode: "edit",
        }),
        signal: state.abortController.signal,
      });
      const planResult = await readJsonResponse(planResponse);
      if (!planResponse.ok) throw new Error(planResult.error || "双图替换提示词编译失败");
      compiledPrompt = planResult.prompt || buildEditReplacementPrompt(prompt, productName, (planResult.analysisNotes || []).join("; "));
      generateOwnImage = templateImage.src;
      generateReferenceImages = [productImage.src];
    }

    if (!isReplacementTask && (hasProductImage || hasInspiration)) {
      setGenerationState(true, "提示词做图", 0, 2);
      setStatus("正在编译广告提示词");
      updateGenerationProgress("提示词编译", 1, 2);
      const planResponse = await fetch(getApiUrl("/api/edit-plan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productImage: productImage?.src || "",
          referenceImages: inspirationImages.map((item) => item.src),
          userPrompt: prompt,
          productName: els.productName.value.trim(),
          styleMode: els.styleMode.value,
          styleLabel: getSelectText(els.styleMode),
          modelMode: els.modelMode.value,
          modelLabel: getSelectText(els.modelMode),
          angleMode: els.angleMode.value,
          angleLabel: getSelectText(els.angleMode),
          backgroundMode: els.backgroundMode.value,
          backgroundLabel: getSelectText(els.backgroundMode),
          aspectRatio: state.aspectRatio,
          taskMode: "edit",
        }),
        signal: state.abortController.signal,
      });
      const planResult = await readJsonResponse(planResponse);
      if (!planResponse.ok) throw new Error(planResult.error || "广告提示词编译失败");
      if (planResult.prompt) compiledPrompt = planResult.prompt;
    }

    const finalPrompt = compiledPrompt;
    const totalSteps = isReplacementTask
      ? 2
      : (!isReplacementTask && (hasProductImage || hasInspiration) ? 2 : 1);
    const currentStep = totalSteps > 1 ? 1 : 0;
    setGenerationState(true, "提示词做图", currentStep, totalSteps);
    setStatus(`提示词做图 ${totalSteps > 1 ? "2/2" : "1/1"}`);
    updateGenerationProgress("提示词做图", currentStep, totalSteps);
    const response = await fetch(getApiUrl("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: finalPrompt,
        ownImage: generateOwnImage,
        referenceImages: generateReferenceImages,
        productName: "提示词做图",
        keywords: "",
        styleMode: els.styleMode.value,
        modelMode: els.modelMode.value,
        angleMode: els.angleMode.value,
        backgroundMode: els.backgroundMode.value,
        aspectRatio: state.aspectRatio,
        taskMode: state.mode,
        sourceMode: isReplacementTask
          ? "two-image-replacement"
          : hasProductImage
            ? (hasInspiration ? "product-lock-compiled" : "product-lock-director")
            : "text-to-image-director",
      }),
      signal: state.abortController.signal,
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "生成失败");
    els.generatedImage.src = result.image;
    addHistoryImage(result.image, "提示词做图");
    updateGenerationProgress("提示词做图", totalSteps, totalSteps);
    els.canvasWrap.classList.add("has-output", "has-generated");
    els.downloadBtn.disabled = false;
    saveModeSnapshot("edit");
    setStatus("提示词图已生成");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("已取消生成");
    } else {
      alert(`AI 生成失败：${error.message}`);
      setStatus("生成失败");
    }
  } finally {
    state.abortController = null;
    setGenerationState(false);
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "立即生成";
  }
}

async function generateCloneImage() {
  if (!state.own) {
    alert("请先上传要替换进去的产品图。");
    return;
  }
  if (!state.competitors.length) {
    alert("请上传 1 张克隆参考图。");
    return;
  }

  const productName = els.productName.value.trim() || "目标产品";
  const keywords = els.keywords.value.trim() || "自然融合，真实商业摄影";
  const template = state.competitors[0];
  const prompt = [
    "CRITICAL CLONE EDIT. Image 1 is the locked template scene. Image 2 is only the replacement product reference.",
    "Keep Image 1 unchanged: same background, person, face, hair, hands, body pose, clothing, props, camera angle, crop, perspective, lens, lighting, shadows, color grading, depth of field and overall composition.",
    `Only replace the main product in Image 1 with the product from Image 2. Target product name: ${productName}.`,
    `Replacement notes: ${keywords}.`,
    "The replacement product must match the original scene perspective, size, contact point, occlusion, strap/hand/body relationship, cast shadow, reflected light, highlights, material response and environmental color. It must look photographed in the original scene, not pasted.",
    "Do not change any other element. Do not redraw the model. Do not change the background. Do not add text, logos, price tags, watermark, random symbols or extra accessories.",
    "If the product category differs, preserve the template object's position and scale while adapting the replacement product naturally to that exact location.",
  ].join("\n");

  setStatus("克隆详情生成中");
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "克隆中...";
  state.abortController = new AbortController();
  setGenerationState(true, "克隆详情", 0, 1);

  try {
    await checkApiServer();
    const response = await fetch(getApiUrl("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        ownImage: template.src,
        referenceImages: [state.own.src],
        productName,
        taskMode: "clone",
      }),
      signal: state.abortController.signal,
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "克隆失败");
    els.generatedImage.src = result.image;
    addHistoryImage(result.image, "克隆详情");
    els.canvasWrap.classList.add("has-output", "has-generated");
    els.downloadBtn.disabled = false;
    saveModeSnapshot("clone");
    updateGenerationProgress("克隆详情", 1, 1);
    setStatus("克隆详情已生成");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("已取消生成");
    } else {
      alert(`AI 生成失败：${error.message}`);
      setStatus("生成失败");
    }
  } finally {
    state.abortController = null;
    setGenerationState(false);
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "立即克隆";
  }
}

function getApiUrl(path) {
  if (window.location.protocol === "file:") {
    return `http://127.0.0.1:4173${path}`;
  }
  return path;
}

async function checkApiServer() {
  try {
    const response = await fetch(getApiUrl("/api/health"), { method: "GET" });
    const result = await readJsonResponse(response);
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "本地生成服务不可用");
    }
    if (!result.hasApiKey) {
      throw new Error("本地服务已启动，但没有设置 OPENAI_API_KEY。请关闭服务后用：$env:OPENAI_API_KEY=\"你的Key\"; node server.js 重新启动。");
    }
  } catch (error) {
    if (window.location.protocol === "file:") {
      throw new Error("你现在是直接打开 index.html，AI 生成必须先启动本地服务：在 E:\\TEST3 执行 $env:OPENAI_API_KEY=\"你的Key\"; node server.js，然后打开 http://127.0.0.1:4173");
    }
    throw new Error(`连接不到本地生成服务。请确认是用 node server.js 启动并打开 http://127.0.0.1:4173。原始错误：${error.message}`);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

function resetAll() {
  state.own = null;
  state.competitors = [];
  state.editImages = [];
  state.ownMetrics = null;
  state.competitorMetrics = [];
  state.lastAnalysis = null;
  state.histories = { main: [], edit: [], develop: [], clone: [] };
  state.history = [];
  state.activePromptIndex = 0;
  els.ownImage.value = "";
  els.competitorImages.value = "";
  if (els.editImages) els.editImages.value = "";
  els.ownDrop.classList.remove("has-file");
  els.competitorDrop.classList.remove("has-file");
  if (els.editDrop) els.editDrop.classList.remove("has-file");
  els.ownPreview.innerHTML = "";
  els.competitorPreview.innerHTML = "";
  if (els.editPreview) els.editPreview.innerHTML = "";
  els.analysisMeta.textContent = "未分析";
  els.analysisOutput.innerHTML = "<p>上传自己的主图和 3-9 张竞品主图后，点击分析。系统会从主体占比、背景干净度、色彩、光影、文字卖点和搜索流点击感进行对比。</p>";
  ctx.clearRect(0, 0, 1200, 1200);
  els.canvasWrap.classList.remove("has-output");
  els.canvasWrap.classList.remove("has-generated");
  els.generatedImage.removeAttribute("src");
  renderHistory();
  els.downloadBtn.disabled = true;
  els.copyPromptBtn.disabled = true;
  els.generateBtn.disabled = true;
  setStatus("等待上传");
}

function clearOwnUpload() {
  state.own = null;
  state.ownMetrics = null;
  els.ownImage.value = "";
  els.ownDrop.classList.remove("has-file");
  els.ownPreview.innerHTML = "";
  if (state.mode === "clone") {
    els.generateBtn.disabled = true;
  }
  saveModeSnapshot();
  setStatus("已清空自己的图片");
}

function clearCompetitorUpload() {
  state.competitors = [];
  state.competitorMetrics = [];
  els.competitorImages.value = "";
  els.competitorDrop.classList.remove("has-file");
  els.competitorPreview.innerHTML = "";
  if (state.mode === "clone") {
    els.generateBtn.disabled = true;
  }
  saveModeSnapshot();
  setStatus("已清空参考图");
}

function clearEditUpload() {
  state.editImages = [];
  if (els.editImages) els.editImages.value = "";
  if (els.editDrop) els.editDrop.classList.remove("has-file");
  if (els.editPreview) els.editPreview.innerHTML = "";
  if (state.mode === "edit") {
    els.generateBtn.disabled = !els.editPrompt.value.trim();
  }
  setStatus("已清空提示词参考图");
  saveModeSnapshot("edit");
}

function removeCompetitorImage(index) {
  state.competitors.splice(index, 1);
  state.competitorMetrics.splice(index, 1);
  els.competitorDrop.classList.toggle("has-file", state.competitors.length > 0);
  if (!state.competitors.length) els.competitorImages.value = "";
  renderPreviews();
  if (state.mode === "clone") {
    els.generateBtn.disabled = !(state.own && state.competitors.length);
  }
  saveModeSnapshot();
  setStatus("已移除参考图");
}

function removeEditImage(index) {
  state.editImages.splice(index, 1);
  if (els.editDrop) els.editDrop.classList.toggle("has-file", state.editImages.length > 0);
  if (!state.editImages.length && els.editImages) els.editImages.value = "";
  renderPreviews();
  setStatus("已移除提示词参考图");
}

function clearCurrentMode() {
  if (state.mode === "edit") {
    els.editPrompt.value = "";
    clearEditUpload();
    els.generateBtn.disabled = true;
    els.canvasWrap.classList.remove("has-output", "has-generated");
    els.generatedImage.removeAttribute("src");
    els.downloadBtn.disabled = true;
    saveModeSnapshot("edit");
    return;
  }
  clearOwnUpload();
  clearCompetitorUpload();
  state.lastAnalysis = null;
  state.activePromptIndex = 0;
  els.analysisMeta.textContent = "未分析";
  els.analysisOutput.innerHTML = "<p>当前功能栏已清空，请重新上传图片后继续。</p>";
  els.canvasWrap.classList.remove("has-output", "has-generated");
  els.generatedImage.removeAttribute("src");
  els.downloadBtn.disabled = true;
  saveModeSnapshot();
}

async function handleOwnFiles(files) {
  const [image] = await readFiles(files, 1);
  if (!image) return;
  state.own = image;
  state.ownMetrics = null;
  els.ownDrop.classList.add("has-file");
  renderPreviews();
  if (state.mode === "clone") {
    els.generateBtn.disabled = !(state.own && state.competitors.length);
  }
  saveModeSnapshot();
  setStatus("已上传主图");
}

async function handleCompetitorFiles(files, append = false) {
  const images = await readFiles(files, 9);
  state.competitors = append ? [...state.competitors, ...images].slice(0, 9) : images;
  state.competitorMetrics = [];
  els.competitorImages.value = "";
  els.competitorDrop.classList.toggle("has-file", state.competitors.length > 0);
  renderPreviews();
  if (state.mode === "clone") {
    els.generateBtn.disabled = !(state.own && state.competitors.length);
  }
  saveModeSnapshot();
  setStatus(`已上传 ${state.competitors.length} 张竞品`);
}

async function handleEditFiles(files, append = false) {
  const images = await readFiles(files, 8);
  state.editImages = append ? [...state.editImages, ...images].slice(0, 8) : images;
  if (els.editImages) els.editImages.value = "";
  els.editDrop.classList.toggle("has-file", state.editImages.length > 0);
  renderPreviews();
  els.generateBtn.disabled = state.mode === "edit" && !els.editPrompt.value.trim();
  saveModeSnapshot("edit");
  setStatus(state.editImages.length > 1
    ? `已上传 ${state.editImages.length} 张图片（首张为产品图）`
    : state.editImages.length === 1
      ? "已上传产品图"
      : "等待上传");
}

function getClipboardImageFiles(event) {
  return Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function getDefaultPasteTarget() {
  if (state.mode === "edit") return "edit";
  if (!state.own) return "own";
  return "competitor";
}

async function handlePasteFiles(files) {
  const target = state.pasteTarget || getDefaultPasteTarget();
  if (target === "edit") return handleEditFiles(files, true);
  if (target === "competitor") return handleCompetitorFiles(files, true);
  return handleOwnFiles(files);
}

function setupDrop(zone, input, onFiles, pasteTarget) {
  if (!zone) return;
  zone.tabIndex = 0;
  ["mouseenter", "focus", "click"].forEach((eventName) => {
    zone.addEventListener(eventName, () => {
      state.pasteTarget = pasteTarget;
    });
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("drag-over");
    });
  });
  zone.addEventListener("drop", (event) => onFiles(event.dataTransfer.files));
  input.addEventListener("change", () => onFiles(input.files));
}

setupDrop(els.ownDrop, els.ownImage, handleOwnFiles, "own");

setupDrop(els.competitorDrop, els.competitorImages, (files) => handleCompetitorFiles(files, true), "competitor");

if (els.editDrop && els.editImages) {
  setupDrop(els.editDrop, els.editImages, (files) => handleEditFiles(files, true), "edit");
}

function setAspectRatio(value) {
  state.aspectRatio = value || "1:1";
  els.ratioButtons.forEach((button) => {
    button.classList.toggle("active", button.textContent.trim() === state.aspectRatio);
  });
  if (state.lastAnalysis) {
    state.lastAnalysis.prompt = buildImagePrompt(state.lastAnalysis);
    renderAnalysis(state.lastAnalysis);
  }
}

els.ratioButtons.forEach((button) => {
  button.addEventListener("click", () => setAspectRatio(button.textContent.trim()));
});

els.analyzeBtn.addEventListener("click", analyze);
els.generateBtn.addEventListener("click", generateRealImage);
els.cancelBtn.addEventListener("click", cancelGeneration);
els.clearOwnBtn.addEventListener("click", clearOwnUpload);
els.clearCompetitorsBtn.addEventListener("click", clearCompetitorUpload);
if (els.clearEditBtn) {
  els.clearEditBtn.addEventListener("click", clearEditUpload);
}
els.saveApiConfigBtn.addEventListener("click", saveApiConfig);
els.testApiConfigBtn.addEventListener("click", testApiConfig);
els.settingsBtn.addEventListener("click", openSettings);
els.logoutBtn.addEventListener("click", async () => {
  await fetch(getApiUrl("/api/logout"), { method: "POST" });
  location.href = "/login";
});
els.closeSettingsBtn.addEventListener("click", closeSettings);
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) closeSettings();
});
els.compareModal.addEventListener("click", (event) => {
  if (event.target === els.compareModal) closeCompare();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettings();
    closeCompare();
  }
});
document.addEventListener("paste", async (event) => {
  const files = getClipboardImageFiles(event);
  if (!files.length) return;
  event.preventDefault();
  try {
    await handlePasteFiles(files);
  } catch (error) {
    alert(`粘贴图片失败：${error.message}`);
  }
});
els.closeCompareBtn.addEventListener("click", closeCompare);
els.resetBtn.addEventListener("click", clearCurrentMode);
els.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});
if (els.editPrompt) {
  els.editPrompt.addEventListener("input", () => {
    if (state.mode === "edit") {
      els.generateBtn.disabled = !els.editPrompt.value.trim();
      saveModeSnapshot("edit");
    }
  });
}
if (els.analysisOutput) {
  els.analysisOutput.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt-index]");
    if (!button || !state.lastAnalysis?.promptVariants?.length) return;
    state.activePromptIndex = Number(button.dataset.promptIndex || 0);
    renderAnalysis(state.lastAnalysis);
  });
}
if (els.historyList) {
  els.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-index]");
    if (!button) return;
    const item = getModeHistory()[Number(button.dataset.historyIndex)];
    if (!item) return;
    els.generatedImage.src = item.src;
    els.canvasWrap.classList.add("has-output", "has-generated");
    els.downloadBtn.disabled = false;
    saveModeSnapshot();
  });
}
if (els.clearHistoryBtn) {
  els.clearHistoryBtn.addEventListener("click", () => {
    state.histories[state.historyMode] = [];
    renderHistory();
  });
}
document.querySelectorAll("[data-history-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.historyMode = button.dataset.historyMode;
    renderHistory();
  });
});
els.downloadBtn.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = "optimized-main-image.png";
  link.href = els.generatedImage.src || els.canvas.toDataURL("image/png");
  link.click();
});

els.copyPromptBtn.addEventListener("click", async () => {
  const promptBox = document.querySelector("#promptBox");
  if (!promptBox) return;
  await navigator.clipboard.writeText(promptBox.textContent);
  els.copyPromptBtn.textContent = "已复制";
  setTimeout(() => {
    els.copyPromptBtn.textContent = "复制提示词";
  }, 1200);
});

(async function initApp() {
  await loadCurrentUser();
  await loadApiConfig();
  renderHistory();
  setMode("edit");
})();

