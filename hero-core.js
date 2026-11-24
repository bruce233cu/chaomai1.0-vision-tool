(function expose(factory) {
  if (typeof module === "object") module.exports = factory();
  else window.HeroCore = factory();
})(function createHeroCore() {
  const changes = ["focus", "copy", "contrast", "lighting", "none"];
  const text = (value, limit = 180) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizePlan(raw, count) {
    if (!raw || !Array.isArray(raw.strengths) || !Array.isArray(raw.observations) || !raw.layout ||
        !Number.isInteger(raw.assetIndex) || raw.assetIndex < 0 || raw.assetIndex >= count) {
      throw new Error("分析结果缺少有效素材或版式，请重新分析。");
    }
    const layout = raw.layout;
    const issue = raw.issue;
    const region = Array.isArray(issue?.region) && issue.region.length === 4 &&
      issue.region.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
      issue.region[2] > 0 && issue.region[3] > 0 &&
      issue.region[0] + issue.region[2] <= 1.001 && issue.region[1] + issue.region[3] <= 1.001
      ? issue.region : null;
    const diagnosis = issue && changes.includes(issue.kind) && issue.kind !== "none" && region &&
      ["finding", "evidence", "impact", "action", "check"].every(key => text(issue[key]))
      ? { kind: issue.kind, region, ...Object.fromEntries(
        ["finding", "evidence", "impact", "action", "check"].map(key => [key, text(issue[key])])
      ) } : null;
    const strengths = raw.strengths.map(value => text(value)).filter(Boolean).slice(0, 2);
    if (!strengths.length) throw new Error("分析结果缺少可借鉴的视觉做法，请重新分析。");
    return {
      strengths,
      observations: raw.observations.map(item => ({
        dimension: text(item?.dimension, 30), evidence: text(item?.evidence),
      })).filter(item => item.dimension && item.evidence).slice(0, 8),
      assetIndex: raw.assetIndex,
      assetReason: text(raw.assetReason),
      missing: text(raw.missing),
      issue: diagnosis,
      layout: {
        placement: ["left", "right", "center"].includes(layout.placement) ? layout.placement : "right",
        scale: Number.isFinite(layout.scale) ? clamp(layout.scale, 0.43, 0.75) : 0.61,
        palette: /^#[0-9a-f]{6}$/i.test(layout.palette) ? layout.palette : "#e6dfd6",
        scene: text(layout.scene, 350),
      },
    };
  }

  function productBox(width, height, placement, scale, hasHeadline) {
    const maxWidth = hasHeadline && placement !== "center" ? 590 : 870;
    const factor = Math.min(1000 * scale / Math.max(width, height), maxWidth / width);
    const w = Math.round(width * factor);
    const h = Math.round(height * factor);
    const x = placement === "left" ? 64 : placement === "right" ? 936 - w : (1000 - w) / 2;
    const y = placement === "center" && hasHeadline ? 535 - h / 2 : 510 - h / 2;
    return { x: Math.round(x), y: Math.round(y), w, h };
  }

  function removeWhiteBackground(rgba, width, height, threshold) {
    const count = width * height;
    const seen = new Uint8Array(count);
    const queue = new Uint32Array(count);
    let end = 0;
    function visit(index) {
      if (seen[index]) return;
      seen[index] = 1;
      const p = index * 4;
      const low = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]);
      const high = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]);
      if (rgba[p + 3] === 0 || (low >= threshold && high - low <= 19)) queue[end++] = index;
    }
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    for (let start = 0; start < end; start++) {
      const index = queue[start];
      rgba[index * 4 + 3] = 0;
      if (index % width > 0) visit(index - 1);
      if (index % width < width - 1) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index < count - width) visit(index + width);
    }
    return end;
  }

  return { changes, normalizePlan, productBox, removeWhiteBackground };
});
