# Generates launcher/pos.ico (256x256 PNG-compressed icon, Vista+ format):
# indigo rounded square with a white "POS" label.
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Rounded-square background.
$r = 48
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $size, $size),
    [System.Drawing.Color]::FromArgb(79, 70, 229), [System.Drawing.Color]::FromArgb(30, 27, 75))
$g.FillPath($brush, $path)

# White "POS" label, centered.
$font = New-Object System.Drawing.Font('Segoe UI', 88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF 0, -6, $size, $size
$g.DrawString('POS', $font, [System.Drawing.Brushes]::White, $textRect, $fmt)
$g.Dispose()

# Encode the bitmap as PNG, then wrap it in an ICO container.
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()

$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type: icon
$bw.Write([uint16]1)            # image count
$bw.Write([byte]0)              # width 256 -> 0
$bw.Write([byte]0)              # height 256 -> 0
$bw.Write([byte]0)              # palette
$bw.Write([byte]0)              # reserved
$bw.Write([uint16]1)            # color planes
$bw.Write([uint16]32)           # bits per pixel
$bw.Write([uint32]$png.Length)  # data size
$bw.Write([uint32]22)           # data offset (6 + 16)
$bw.Write($png)
$bw.Flush()

$out = Join-Path $PSScriptRoot 'pos.ico'
[System.IO.File]::WriteAllBytes($out, $ico.ToArray())
Write-Output ("icon written: {0} ({1} bytes)" -f $out, (Get-Item $out).Length)
