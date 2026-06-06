$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "竞品主图优化工具启动器"
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LocalAppData\Programs\nodejs\node.exe"
  )
  $nodePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($nodePath) {
    $nodeCommand = $nodePath
  } else {
    Write-Host "没找到 Node.js。请先安装 Node.js LTS：https://nodejs.org" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
  }
} else {
  $nodeCommand = $node.Source
}

Write-Host "请粘贴新的 OpenAI API Key，然后按回车。"
Write-Host "注意：不要使用已经发到截图里的旧 Key，请先删除旧 Key 后新建一个。" -ForegroundColor Yellow
$env:OPENAI_API_KEY = Read-Host "API Key"

if (-not $env:OPENAI_API_KEY) {
  Write-Host "没有输入 API Key。" -ForegroundColor Red
  Read-Host "按回车退出"
  exit 1
}

Write-Host ""
Write-Host "如果你使用 API 代理/Base URL，请粘贴；普通 OpenAI 官方接口直接按回车。"
$baseUrl = Read-Host "OpenAI Base URL"
if ($baseUrl) {
  $env:OPENAI_BASE_URL = $baseUrl
}

Write-Host ""
Write-Host "正在启动服务..."
Write-Host "打开地址：http://127.0.0.1:4173"
Write-Host ""

& $nodeCommand server.js
