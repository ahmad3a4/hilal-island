# Takes the README screenshots (docs/screenshots/*.png).
# Runs Hilal in demo mode with a throwaway profile - made-up music and downloads, the
# default city - so no personal data ends up in the images. Then frames each capture
# on a dark gradient.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\screenshots.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP 'hilal-shots'
$raw = Join-Path $work 'raw'
$out = Join-Path $root 'docs\screenshots'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null

# step => screenshot name ($null = no screenshot needed)
$steps = @(
  @('democontent', 'compact-music'),
  @('expand:music', 'music'),
  @('expand:prayer', 'prayer'),
  @('expand:azkar', 'azkar'),
  @('expand:settings', 'settings'),
  @('collapse', $null),
  @('fakedl', 'compact-download'),
  @('expand:downloads', 'downloads'),
  @('collapse', $null),
  @('nodl', $null),
  @('reminder:2:186', 'ayah'),
  @('dismiss', $null),
  @('dua:11', 'dua'),
  @('dismiss', $null),
  @('azanlook', 'azan'),
  @('azanend', $null),
  @('prealert', 'prealert'),
  @('dismiss', $null),
  @('clip', 'clipboard'),
  @('dismiss', $null),
  @('nomedia', 'compact-idle'),
  @('demosound', $null),
  @('expand:sound', 'sound'),
  @('collapse', $null),
  @('hud:volume', 'hud-volume'),
  @('dismiss', $null),
  @('hud:brightness', 'hud-brightness')
)

Write-Host 'Running Hilal in demo mode...'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:DI_USER_DATA = Join-Path $work 'profile'
$env:DI_DEMO = ($steps | ForEach-Object { $_[0] }) -join ','
$env:DI_CAPTURE_DIR = $raw
$env:DI_DEMO_EXIT = '1'
$env:DI_STEP_MS = '1700'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$proc = Start-Process -FilePath $electron -ArgumentList "`"$root`"" -PassThru
if (-not $proc.WaitForExit(180000)) { $proc.Kill(); throw 'Demo run timed out' }
foreach ($v in 'DI_USER_DATA', 'DI_DEMO', 'DI_CAPTURE_DIR', 'DI_DEMO_EXIT', 'DI_STEP_MS') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }

Add-Type -AssemblyName System.Drawing

function Get-Crop([int]$index) {
  $base = Join-Path $raw ('{0:D2}-{1}' -f $index, ($steps[$index][0] -replace '[^a-zA-Z0-9]+', '_'))
  $img = [System.Drawing.Image]::FromFile("$base.png")
  $info = Get-Content "$base.json" -Raw | ConvertFrom-Json
  $s = [double]$info.scale
  $x1 = $info.island.x; $y1 = $info.island.y
  $x2 = $info.island.x + $info.island.w; $y2 = $info.island.y + $info.island.h
  if ($info.bubble) { $x2 = [Math]::Max($x2, $info.bubble.x + $info.bubble.w) }
  # leave room for the drop shadow
  $left = [Math]::Max(0, [int](($x1 - 44) * $s)); $top = [Math]::Max(0, [int](($y1 - 8) * $s))
  $right = [Math]::Min($img.Width, [int](($x2 + 44) * $s)); $bottom = [Math]::Min($img.Height, [int](($y2 + 60) * $s))
  $rect = New-Object System.Drawing.Rectangle $left, $top, ($right - $left), ($bottom - $top)
  $crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
  $g = [System.Drawing.Graphics]::FromImage($crop)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $rect.Width, $rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $img.Dispose()
  return $crop
}

function Add-Glow($g, [double]$cx, [double]$cy, [double]$r, [System.Drawing.Color]$color) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse([single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r))
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = $color
  $brush.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $g.FillPath($brush, $path)
  $brush.Dispose(); $path.Dispose()
}

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 13, 17, 38)), ([System.Drawing.Color]::FromArgb(255, 8, 46, 46)), ([single]32)
  $g.FillRectangle($bg, $rect)
  $bg.Dispose()
  Add-Glow $g ($w * 0.88) ($h * 0.05) ([Math]::Max($w, $h) * 0.45) ([System.Drawing.Color]::FromArgb(60, 243, 195, 107))
  Add-Glow $g ($w * 0.08) ($h * 1.0) ([Math]::Max($w, $h) * 0.55) ([System.Drawing.Color]::FromArgb(70, 40, 170, 150))
  Add-Glow $g ($w * 0.5) ($h * 0.45) ([Math]::Max($w, $h) * 0.35) ([System.Drawing.Color]::FromArgb(35, 99, 102, 241))
  return ,@($bmp, $g)
}

function Save-Framed($crops, [string]$name, [int]$pad = 56, [int]$gap = 18) {
  $w = ($crops | Measure-Object -Property Width -Maximum).Maximum + 2 * $pad
  $h = ($crops | Measure-Object -Property Height -Sum).Sum + 2 * $pad + $gap * ($crops.Count - 1)
  $c = New-Canvas $w $h
  $y = $pad
  foreach ($crop in $crops) {
    $c[1].DrawImage($crop, [int](($w - $crop.Width) / 2), $y, $crop.Width, $crop.Height)
    $y += $crop.Height + $gap
  }
  $c[0].Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $c[1].Dispose(); $c[0].Dispose()
  Write-Host "  docs/screenshots/$name.png"
}

$crops = @{}
for ($i = 0; $i -lt $steps.Count; $i++) {
  if ($steps[$i][1]) { $crops[$steps[$i][1]] = Get-Crop $i }
}

Write-Host 'Framing screenshots...'
foreach ($name in 'music', 'downloads', 'prayer', 'azkar', 'settings', 'ayah', 'dua', 'azan', 'prealert', 'clipboard', 'sound') {
  Save-Framed @($crops[$name]) $name
}
Save-Framed @($crops['compact-idle'], $crops['compact-music'], $crops['compact-download']) 'compact' 56 6
Save-Framed @($crops['hud-volume'], $crops['hud-brightness']) 'volume' 56 6

# hero: the verse pop-up on top, prayer and music panels below
$ayah = $crops['ayah']; $prayer = $crops['prayer']; $music = $crops['music']
$pad = 64; $gap = 24
$w = [Math]::Max($ayah.Width, $prayer.Width + $music.Width + $gap) + 2 * $pad
$h = $pad + $ayah.Height + $gap + [Math]::Max($prayer.Height, $music.Height) + $pad
$c = New-Canvas $w $h
$c[1].DrawImage($ayah, [int](($w - $ayah.Width) / 2), $pad, $ayah.Width, $ayah.Height)
$rowY = $pad + $ayah.Height + $gap
$rowX = [int](($w - ($prayer.Width + $gap + $music.Width)) / 2)
$c[1].DrawImage($prayer, $rowX, $rowY, $prayer.Width, $prayer.Height)
$c[1].DrawImage($music, $rowX + $prayer.Width + $gap, $rowY, $music.Width, $music.Height)
$c[0].Save((Join-Path $out 'hero.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$c[1].Dispose(); $c[0].Dispose()
Write-Host '  docs/screenshots/hero.png'
foreach ($crop in $crops.Values) { $crop.Dispose() }
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Done.'
