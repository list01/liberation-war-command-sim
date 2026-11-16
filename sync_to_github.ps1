#Requires -Version 5.1
<#
.SYNOPSIS
  创建 GitHub 仓库并推送《解放战争》项目（凭证仅从环境变量读取，不落盘）。
.EXAMPLE
  $env:GH_PAT = "github_pat_xxx"
  powershell -ExecutionPolicy Bypass -File .\sync_to_github.ps1
#>
$ErrorActionPreference = 'Stop'

$pat = $env:GH_PAT
if (-not $pat) {
  throw '请先设置环境变量 GH_PAT（需 repo 权限的 Personal Access Token）'
}

$owner = 'list01'
$repo  = 'liberation-war-command-sim'
$desc  = '《解放战争》师级指挥模拟器：基于真实电文与地理的网页兵棋 v1.4.1'
$cleanUrl = "https://github.com/$owner/$repo.git"

# 用 Basic 头认证推送，remote 始终保存不含凭证的干净地址
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$owner`:$pat"))

$headers = @{
  Authorization           = "Bearer $pat"
  Accept                  = 'application/vnd.github+json'
  'X-GitHub-Api-Version'  = '2022-11-28'
}
$body = @{
  name        = $repo
  description = $desc
  private     = $false
  auto_init   = $false
} | ConvertTo-Json

Write-Host "[1/3] 创建 GitHub 仓库 $owner/$repo ..."
try {
  Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post `
    -Headers $headers -Body $body | Out-Null
  Write-Host '  仓库已创建。'
} catch {
  $status = 0
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 422) {
    Write-Host '  仓库已存在，跳过创建，继续推送。'
  } else {
    throw "创建仓库失败（HTTP $status）：$($_.Exception.Message)"
  }
}

Write-Host '[2/3] 配置 origin ...'
$existing = & git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
  & git remote set-url origin $cleanUrl
} else {
  & git remote add origin $cleanUrl
}

Write-Host '[3/3] 推送 main ...'
& git -c "http.extraHeader=Authorization: Basic $b64" push -u origin main
if ($LASTEXITCODE -ne 0) { throw '推送失败，请检查 PAT 权限与网络。' }

Write-Host "完成：$cleanUrl"
Write-Host '凭证仅用于本次进程，未写入任何文件。'
