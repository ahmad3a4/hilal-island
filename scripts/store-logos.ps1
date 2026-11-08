# Makes the Microsoft Store poster (9:16, 1440x2160) and box art (1:1, 2160x2160) in docs/store-logos.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'docs\store-logos'
New-Item -ItemType Directory -Force $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'assets\icons\icon.png'))
$shot = [System.Drawing.Image]::FromFile((Join-Path $root 'docs\screenshots\music.png'))

function Art($name, $cw, $ch) {
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $cw, $ch), ([System.Drawing.Color]::FromArgb(255, 12, 20, 38)), ([System.Drawing.Color]::FromArgb(255, 40, 24, 62))
  $g.FillRectangle($bg, 0, 0, $cw, $ch)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center

  # Icon, name and tagline in the top part, a screenshot of the island below.
  $is = [int]($cw * 0.30)
  # Centre everything vertically: icon, name, tagline and the screenshot.
  $shotH = [int]($shot.Height * $cw * 0.86 / $shot.Width)
  $top = [int][Math]::Max($ch * 0.06, ($ch - ($is + $cw * 0.31 + $shotH)) / 2)
  $g.DrawImage($icon, [int](($cw - $is) / 2), $top, $is, $is)
  $y = $top + $is + [int]($cw * 0.04)
  $big = New-Object System.Drawing.Font 'Segoe UI Semibold', ([single]($cw * 0.11)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString('Hilal', $big, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, $y, $cw, ($cw * 0.16)), $fmt)
  $y += [int]($cw * 0.15)
  $small = New-Object System.Drawing.Font 'Segoe UI', ([single]($cw * 0.045)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 190, 196, 214))
  $g.DrawString('A Dynamic Island for Windows', $small, $grey, (New-Object System.Drawing.RectangleF 0, $y, $cw, ($cw * 0.08)), $fmt)
  $y += [int]($cw * 0.12)

  $sw = [int]($cw * 0.86)
  $sh = [int]($shot.Height * $sw / $shot.Width)
  if ($y + $sh -gt $ch - 40) { $sh = $ch - 40 - $y; $sw = [int]($shot.Width * $sh / $shot.Height) }
  $g.DrawImage($shot, [int](($cw - $sw) / 2), $y, $sw, $sh)

  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $name
}

Art 'poster-1440x2160.png' 1440 2160
Art 'box-art-2160x2160.png' 2160 2160
$icon.Dispose(); $shot.Dispose()
