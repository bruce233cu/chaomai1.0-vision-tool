"use strict";

const byId = id => document.getElementById(id);
const { normalizePlan, productBox, removeWhiteBackground } = window.HeroCore;
const size = 1000;
const state = { plans: null, photos: [], reference: null, background: null, output: null, busy: false };
const asset = byId("asset");
const title = byId("title");
const threshold = byId("threshold");
const applyIssue = byId("apply-issue");
const aiBackground = byId("ai-background");

function status(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function canvas(width = size, height = width) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}

async function loadImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

async function loadFile(file, limit = 1600) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 15_000_000) {
    throw new Error("请选择 15 MB 以内的 PNG、JPEG 或 WebP。");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const layer = canvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
    layer.getContext("2d").drawImage(image, 0, 0, layer.width, layer.height);
    return { layer, name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function jpeg(layer, limit = 1024) {
  const ratio = Math.min(1, limit / Math.max(layer.width, layer.height));
  const result = canvas(Math.max(1, Math.round(layer.width * ratio)), Math.max(1, Math.round(layer.height * ratio)));
  const ctx = result.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, result.width, result.height);
  ctx.drawImage(layer, 0, 0, result.width, result.height);
  return result.toDataURL("image/jpeg", 0.9);
}

async function post(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) {
    location.assign("/login");
    throw new Error("登录已过期，请重新登录。");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败，请重试。");
  return result;
}

async function job(statusId, pending, run) {
  if (state.busy) return;
  state.busy = true;
  const controls = [...document.querySelectorAll("button, input, select")].filter(element => !element.disabled);
  controls.forEach(element => { element.disabled = true; });
  status(statusId, pending);
  try {
    await run();
  } catch (error) {
    status(statusId, error.message, true);
  } finally {
    state.busy = false;
    controls.forEach(element => { element.disabled = false; });
    applyIssue.disabled = !state.plans?.issue;
  }
}

function addDefinition(list, key, value) {
  if (!value) return;
  const term = document.createElement("dt");
  const definition = document.createElement("dd");
  term.textContent = key;
  definition.textContent = value;
  list.append(term, definition);
}

function showAnalysis() {
  const plan = state.plans;
  byId("evidence-image").src = jpeg(state.reference.layer);
  const evidence = byId("evidence-box");
  evidence.hidden = !plan.issue;
  if (plan.issue) {
    const [x, y, w, h] = plan.issue.region.map(value => `${value * 100}%`);
    Object.assign(evidence.style, { left: x, top: y, width: w, height: h });
  }
  byId("strengths").replaceChildren(...plan.strengths.map(value => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
  byId("issue-title").textContent = plan.issue?.finding || "暂未发现值得优先改的问题";
  const list = byId("issue");
  list.replaceChildren();
  if (plan.issue) {
    addDefinition(list, "图上证据", plan.issue.evidence);
    addDefinition(list, "影响", plan.issue.impact);
    addDefinition(list, "怎么改", plan.issue.action);
    addDefinition(list, "怎么验收", plan.issue.check);
  }
  byId("missing").textContent = plan.missing ? `素材建议：${plan.missing}` : "";
  byId("observations").replaceChildren();
  plan.observations.forEach(item => addDefinition(byId("observations"), item.dimension, item.evidence));
  asset.replaceChildren(...state.photos.map((photo, i) => new Option(`图 ${i + 1} · ${photo.name}`, String(i))));
  asset.value = String(plan.assetIndex);
  describeAsset();
  applyIssue.checked = Boolean(plan.issue);
  byId("analysis").hidden = false;
}

function describeAsset() {
  byId("asset-reason").textContent = Number(asset.value) === state.plans.assetIndex
    ? state.plans.assetReason : "已手动选择，请确认目标结构在此角度可见。";
}

function resetOutput() {
  if (state.output) {
    Object.values(state.output.urls).forEach(URL.revokeObjectURL);
    state.output = null;
  }
  byId("results").hidden = true;
}

function resetAnalysis() {
  state.plans = null;
  state.background = null;
  byId("analysis").hidden = true;
  byId("cutout").hidden = true;
  resetOutput();
  status("status", "");
}

byId("input").addEventListener("input", resetAnalysis);
byId("input").addEventListener("submit", event => {
  event.preventDefault();
  job("status", "正在识别商品角度与竞品图的画面证据…", async () => {
    const files = [...byId("products").files];
    if (files.length < 1 || files.length > 4) throw new Error("请上传 1–4 张自家商品图。");
    const claim = byId("claim").value.trim();
    const [photos, reference] = await Promise.all([
      Promise.all(files.map(file => loadFile(file))),
      loadFile(byId("reference").files[0]),
    ]);
    const result = await post("/api/hero/analyze", {
      productImages: photos.map(photo => jpeg(photo.layer)),
      reference: jpeg(reference.layer), thumbnail: jpeg(reference.layer, 152), claim,
    });
    resetAnalysis();
    state.photos = photos;
    state.reference = reference;
    state.plans = normalizePlan(result, photos.length);
    title.value = claim;
    byId("product-strip").replaceChildren(...photos.map((photo, index) => {
      const img = document.createElement("img");
      img.src = jpeg(photo.layer, 110);
      img.alt = `自家商品图 ${index + 1}`;
      img.title = photo.name;
      return img;
    }));
    showAnalysis();
    status("status", "已完成分析，可以确认方案并出图。");
  });
});

function cutout() {
  const source = state.photos[Number(asset.value)].layer;
  const layer = canvas(source.width, source.height);
  const ctx = layer.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, layer.width, layer.height);
  const { data } = image;
  const hasAlpha = data.some((value, index) => index % 4 === 3 && value === 0);
  if (!hasAlpha && !removeWhiteBackground(data, layer.width, layer.height, Number(threshold.value))) {
    throw new Error("没有识别到边缘白底。请检查阈值，或上传透明 PNG。");
  }
  let left = layer.width, top = layer.height, right = -1, bottom = -1, visible = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    const x = (i / 4) % layer.width;
    const y = Math.floor(i / 4 / layer.width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    visible++;
  }
  if (visible < layer.width * layer.height * 0.005) {
    throw new Error("可见商品过少。请提高白底阈值或上传透明 PNG。");
  }
  ctx.putImageData(image, 0, 0);
  const cropped = canvas(right - left + 1, bottom - top + 1);
  cropped.getContext("2d").drawImage(layer, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

function rgb(color) {
  return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
}

function mix(color, target, amount) {
  return `rgb(${rgb(color).map(channel => Math.round(channel + (target - channel) * amount)).join(",")})`;
}

function backdrop(ctx, photo, palette) {
  if (photo) {
    const fill = size / Math.min(photo.naturalWidth, photo.naturalHeight);
    const w = photo.naturalWidth * fill;
    const h = photo.naturalHeight * fill;
    ctx.drawImage(photo, (size - w) / 2, (size - h) / 2, w, h);
    return;
  }
  const gradient = ctx.createRadialGradient(320, 220, 70, 485, 495, 800);
  gradient.addColorStop(0, mix(palette, 255, 0.68));
  gradient.addColorStop(0.72, palette);
  gradient.addColorStop(1, mix(palette, 0, 0.16));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

function productLightness(layer) {
  const sample = canvas(32);
  const ctx = sample.getContext("2d");
  ctx.drawImage(layer, 0, 0, 32, 32);
  const pixels = ctx.getImageData(0, 0, 32, 32).data;
  let sum = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 224) continue;
    sum += (pixels[i] * 0.21 + pixels[i + 1] * 0.72 + pixels[i + 2] * 0.07);
    count++;
  }
  return sum / (count || 1);
}

function drawTitle(ctx, headline, position, subtle) {
  if (!headline) return;
  const center = position === "center";
  const textX = center ? 500 : position === "left" ? 700 : 64;
  const maxWidth = center ? 820 : 228;
  const fontSize = subtle ? 41 : 63;
  ctx.save();
  ctx.font = `700 ${fontSize}px "Microsoft YaHei","PingFang SC",sans-serif`;
  ctx.textAlign = center ? "center" : "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#182622";
  ctx.strokeStyle = "#ffffffcc";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  const lines = [""];
  for (const character of headline) {
    const i = lines.length - 1;
    if (lines[i] && ctx.measureText(lines[i] + character).width > maxWidth) lines.push(character);
    else lines[i] += character;
  }
  const middle = center ? 105 : 460;
  const lineHeight = fontSize * 1.13;
  lines.forEach((line, i) => {
    const y = middle + (i - (lines.length - 1) / 2) * lineHeight;
    ctx.strokeText(line, textX, y);
    ctx.fillText(line, textX, y);
  });
  ctx.restore();
}

function compose(product, background, plan, headline, change = "", reserveHeadline = Boolean(headline)) {
  const result = canvas();
  const ctx = result.getContext("2d");
  const { placement, palette, scale } = plan.layout;
  const withText = reserveHeadline;
  const box = productBox(product.width, product.height, placement, change === "focus" ? Math.min(scale + 0.13, 0.88) : scale, withText);
  backdrop(ctx, background, palette);
  if (change === "contrast") {
    const x = box.x + box.w / 2, y = box.y + box.h / 2;
    const glow = ctx.createRadialGradient(x, y, Math.min(box.w, box.h) * 0.18, x, y, Math.max(box.w, box.h) * 0.75);
    const light = productLightness(product) < 145;
    glow.addColorStop(0, light ? "#ffffff74" : "#17241f77");
    glow.addColorStop(1, light ? "#ffffff00" : "#17241f00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.save();
  ctx.filter = "blur(17px)";
  ctx.fillStyle = "#23332d35";
  ctx.beginPath();
  ctx.ellipse(box.x + box.w / 2, box.y + box.h - 2, box.w * 0.35, Math.max(6, box.h * 0.026), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.drawImage(product, box.x, box.y, box.w, box.h);
  drawTitle(ctx, headline, placement, change === "copy");
  return result;
}

function cleanCutout() {
  const product = cutout();
  byId("cutout").src = product.toDataURL();
  byId("cutout").hidden = false;
  return product;
}

function outputUrl(layer) {
  return new Promise((resolve, reject) => {
    layer.toBlob(blob => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("图片导出失败。")), "image/png");
  });
}

async function showOutput(base, variant, record, note) {
  resetOutput();
  const urls = { base: await outputUrl(base) };
  try {
    if (variant) urls.variant = await outputUrl(variant);
  } catch (error) {
    URL.revokeObjectURL(urls.base);
    throw error;
  }
  state.output = { base, variant, urls, record };
  Object.entries(urls).forEach(([id, url]) => {
    byId(`${id}-full`).href = url;
    byId(`${id}-image`).src = url;
    byId(`${id}-download`).href = url;
  });
  if (!variant) {
    byId("variant-image").removeAttribute("src");
    byId("variant-full").removeAttribute("href");
    byId("variant-download").removeAttribute("href");
  }
  byId("variant-card").hidden = !variant;
  byId("review").hidden = !variant;
  byId("review-result").hidden = true;
  byId("variant-note").textContent = note;
  byId("chosen").options[1].hidden = !variant;
  byId("chosen").value = variant ? "variant" : "base";
  status("result-status", "");
  byId("results").hidden = false;
}

byId("preview-cutout").addEventListener("click", () => job("output-status", "正在提取商品主体…", async () => {
  cleanCutout();
  status("output-status", "请检查刀网、商品轮廓以及边缘白边。");
}));

byId("render").addEventListener("click", () => job("output-status", "正在按确认方案生成主图…", async () => {
  const plan = state.plans;
  const product = cleanCutout();
  const headline = title.value.trim();
  if (aiBackground.checked && !state.background) {
    const output = await post("/api/hero/render", {
      kind: "background", scene: `${plan.layout.scene} Accent color ${plan.layout.palette}.`,
    });
    state.background = await loadImage(output.image);
  }
  const background = aiBackground.checked ? state.background : null;
  const base = compose(product, background, plan, headline);
  let variant = null, message = "主图已生成。", note = "";
  const change = applyIssue.checked ? plan.issue?.kind : null;
  if (change === "copy" && !headline) {
    message = "参考版已生成。改进方案需要标题，当前文案为空。";
  } else if (change === "lighting") {
    try {
      const source = compose(product, background, plan, "", "", Boolean(headline));
      const output = await post("/api/hero/render", { kind: "lighting", image: source.toDataURL(), direction: plan.issue.action });
      const image = await loadImage(output.image);
      variant = canvas();
      const ctx = variant.getContext("2d");
      ctx.drawImage(image, 0, 0, size, size);
      drawTitle(ctx, headline, plan.layout.placement, false);
      note = "AI 光影版。请放大对照商品结构、颜色、标志和材质后再选用。";
    } catch (error) {
      message = `参考版已生成。AI 改光未完成。${error.message}`;
    }
  } else if (change === "focus" || change === "contrast" || change === "copy") {
    const candidate = compose(product, background, plan, headline, change);
    if (change === "focus" && base.toDataURL() === candidate.toDataURL()) {
      message = "参考版已生成。当前构图没有放大空间。";
    } else {
      variant = candidate;
      note = `${{ focus: "调整主体尺寸", contrast: "调整主体周围的背景反差", copy: "降低标题的视觉权重" }[change]}。商品由同一张实拍合成。`;
    }
  }
  await showOutput(base, variant, {
    createdAt: new Date().toISOString(),
    asset: state.photos[Number(asset.value)].name, reference: state.reference.name,
    claim: byId("claim").value.trim(), headline, plan,
    background: aiBackground.checked ? "ai" : "studio-gradient",
    change: variant ? change : null,
    options: { threshold: Number(threshold.value), selectedAsset: Number(asset.value) },
  }, note);
  status("output-status", message);
  byId("results").scrollIntoView({ block: "nearest" });
}));

byId("mini-reference").addEventListener("change", event => byId("evidence-preview").classList.toggle("mini", event.target.checked));
byId("mini-output").addEventListener("change", event => byId("comparison").classList.toggle("mini", event.target.checked));
asset.addEventListener("change", describeAsset);
[asset, threshold].forEach(element => element.addEventListener("input", () => { byId("cutout").hidden = true; }));
byId("save").addEventListener("click", () => job("result-status", "正在保存到历史…", async () => {
  const choice = byId("chosen").value;
  const { record } = state.output;
  const name = choice === "variant" ? "改进版" : "参考版";
  const note = choice === "variant" ? record.plan.issue.finding : record.claim;
  await post("/api/history", { mode: "main", src: state.output[choice].toDataURL(), label: `对标 · ${name} · ${note}` });
  status("result-status", `${name}已存入「以图做图」历史。`);
}));
byId("record").addEventListener("click", () => {
  const record = { ...state.output.record, chosen: byId("chosen").value };
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = "主图对标方案.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

byId("review").addEventListener("click", () => job("result-status", "正在复核商品细节、质感及缩略图表现…", async () => {
  const { base, variant, record } = state.output;
  const review = await post("/api/hero/review", {
    product: jpeg(state.photos[record.options.selectedAsset].layer),
    base: jpeg(base), variant: jpeg(variant), baseMini: jpeg(base, 152), variantMini: jpeg(variant, 152),
    check: record.plan.issue.check,
  });
  record.review = review;
  const list = byId("review-result");
  list.replaceChildren();
  for (const [key, label] of Object.entries({ fidelity: "商品保真", quality: "画面质感", legibility: "卖点可读性", decision: "AI 建议" })) {
    addDefinition(list, label, review[key]);
  }
  list.hidden = false;
  status("result-status", "复核完成，可结合原图确认最终版本。");
}));
