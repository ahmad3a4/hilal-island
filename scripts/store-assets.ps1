# Makes the Microsoft Store tile images in build/appx from assets/icons/icon.png.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'assets\icons\icon.png'))
$out = Join-Path $root 'build\appx'
New-Item -ItemType Directory -Force $out | Out-Null

function Tile($name, $w, $h, $iconPart) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $size = [int]([Math]::Min($w, $h) * $iconPart)
  $g.DrawImage($src, [int](($w - $size) / 2), [int](($h - $size) / 2), $size, $size)
  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Tile 'StoreLogo.png' 50 50 1.0
Tile 'Square44x44Logo.png' 44 44 1.0
Tile 'Square150x150Logo.png' 150 150 0.66
Tile 'Wide310x150Logo.png' 310 150 0.66
Tile 'LargeTile.png' 310 310 0.66
Tile 'SmallTile.png' 71 71 0.8
$src.Dispose()
Get-ChildItem $out | ForEach-Object { $_.Name }
