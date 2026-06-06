# 竞品主图优化工具

这个版本分两步：

1. 前端分析自己的主图和竞品图，生成模特、角度、背景、构图和卖点方案。
2. 本地后端调用 OpenAI `gpt-image-1.5` 图片编辑接口，生成真实商业图。

## 启动

最简单方式：双击 `start.bat` 启动服务，然后在网页右上角“设置”里填写中转站信息。

不想每次手动启动：双击 `install-autostart.bat` 一次，之后 Windows 登录后会自动启动。需要取消时双击 `remove-autostart.bat`。

中转站模式：

- API Key：填写中转站给你的 Key。
- API 地址：填写中转站地址，例如 `https://ai.t8star.cn`。工具会自动补成 OpenAI 兼容的 `/v1` 路径。
- 生图模型：填写中转站支持的图片模型，例如 `gpt-image-2`。
- LLM 模型：可选，先用于记录配置。
- 配置会保存到本机 `api-config.local.json`，重启服务后自动读取。

PowerShell:

```powershell
$env:OPENAI_API_KEY="你的 API Key"
node server.js
```

然后打开：

```text
http://127.0.0.1:4173
```

## 为什么要后端

API Key 不能放在浏览器前端，否则会被直接看到。`server.js` 只在本机运行，用来安全代理 OpenAI 图片生成请求。

## 输出逻辑

- GPT 分析结果负责确定：模特、产品角度、真实背景、光线、构图和禁忌项。
- `gpt-image-1.5` 负责真实生成图片。
- 中文卖点建议后续继续由前端 Canvas 添加，避免图片模型生成乱码中文。
