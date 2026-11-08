# Brace Map 打包脚本
#
#   pwsh -File release.ps1            # 打包当前版本
#
# 产出三个东西（都在 dist/ 下）：
#   brace-map-<version>.zip           解压到 .obsidian/plugins/ 就能用
#   main.js / manifest.json / styles.css   三个散文件，给 BRAT 和 GitHub Release 用
#
# zip 里只放运行时要的三个文件：manifest.json、main.js、styles.css。
# 不放 data.json（用户自己的设置）、不放 src/test/doc（开发文件）。

param(
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# ---------- 版本号 ----------
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到 manifest.json" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json 里没有 version" }

Write-Host "Brace Map $version" -ForegroundColor Cyan

# ---------- 先构建 ----------
Write-Host "构建 main.js ..." -NoNewline
node "$root\build.js" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "build.js 失败" }
node --check "$root\main.js"
if ($LASTEXITCODE -ne 0) { throw "main.js 语法检查失败" }
Write-Host " ok" -ForegroundColor Green

# ---------- 准备临时目录 ----------
$stage = Join-Path $root "$OutDir\_stage\brace-map"
if (Test-Path (Join-Path $root "$OutDir\_stage")) {
  Remove-Item (Join-Path $root "$OutDir\_stage") -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$files = @('manifest.json', 'main.js', 'styles.css')
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { throw "缺文件：$f" }
  Copy-Item $src (Join-Path $stage $f)
}

# LICENSE 有就一起带上（有些分发渠道会看）
$lic = Join-Path $root 'LICENSE'
if (Test-Path $lic) {
  Copy-Item $lic (Join-Path $stage 'LICENSE')
}

# ---------- 打 zip ----------
$zip = Join-Path $root "$OutDir\brace-map-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "zip  -> $zip" -ForegroundColor Green

# ---------- 散文件（给 BRAT / Release 附件）----------
foreach ($f in $files) {
  Copy-Item (Join-Path $root $f) (Join-Path $root "$OutDir\$f") -Force
}
Write-Host "散文件 -> $OutDir\  (main.js, manifest.json, styles.css)" -ForegroundColor Green

# ---------- 汇总（先列清单，再清临时目录）----------
Write-Host ''
Write-Host "zip 里的文件：" -ForegroundColor Cyan
Get-ChildItem $stage | ForEach-Object { "  {0,-18} {1,10:N0} B" -f $_.Name, $_.Length }

Remove-Item (Join-Path $root "$OutDir\_stage") -Recurse -Force

Write-Host ''
Write-Host "dist/ 产出：" -ForegroundColor Cyan
Get-ChildItem (Join-Path $root $OutDir) -File | ForEach-Object {
  "  {0,-28} {1,10:N0} B" -f $_.Name, $_.Length
}
Write-Host ''
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  git tag $version && git push origin $version"
Write-Host "  在 GitHub 发 Release，附件选 $OutDir 下的 zip 和三个散文件"
