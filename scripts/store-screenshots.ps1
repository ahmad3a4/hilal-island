# Makes 1920x1080 Microsoft Store screenshots in docs/store-screenshots from docs/screenshots.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'docs\screenshots'
$out = Join-Path $root 'docs\store-screenshots'
New-Item -ItemType Directory -Force $out | Out-Null

$shots = @(
  @('hero', 'A Dynamic Island for Windows'),
  @('music', 'Control the music from any player'),
  @('sound', 'Volume, a mixer for each app, and brightness'),
  @('volume', 'A volume pop-up when you press the keys'),
  @('system', 'CPU, GPU, memory, network and FPS'),
  @('downloads', 'Copy a link and download it from the island'),
  @('prayer', 'Prayer times for your city'),
  @('azan', 'The azan, and your music pauses for it'),
  @('azkar', 'Short azkar and verses during the day'),
  @('settings', 'Make it yours')
)

$W = 1920; $H = 1080
$i = 1
foreach ($s in $shots) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $src "$($s[0]).png"))
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $W, $H), ([System.Drawing.Color]::FromArgb(255, 14, 22, 40)), ([System.Drawing.Color]::FromArgb(255, 36, 24, 56))
  $g.FillRectangle($bg, 0, 0, $W, $H)

  # The shot, as big as fits (at most 1.6x), centred below the caption.
  $scale = [Math]::Min(1.6, [Math]::Min(1700 / $img.Width, 820 / $img.Height))
  $iw = [int]($img.Width * $scale); $ih = [int]($img.Height * $scale)
  $g.DrawImage($img, [int](($W - $iw) / 2), [int](200 + (820 - $ih) / 2), $iw, $ih)

  $font = New-Object System.Drawing.Font 'Segoe UI Semibold', 54, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString($s[1], $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 70, $W, 90), $fmt)

  $name = '{0:D2}-{1}.png' -f $i, $s[0]
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose(); $font.Dispose(); $bg.Dispose()
  $name
  $i++
}
