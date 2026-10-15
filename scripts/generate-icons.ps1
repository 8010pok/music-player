Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\pokem\.gemini\antigravity\scratch\music-player\icons\icon-512.png"
$iconsDir = "C:\Users\pokem\.gemini\antigravity\scratch\music-player\icons"

$srcImg = [System.Drawing.Image]::FromFile($srcPath)

$targets = @(
    @{ Name = "maskable-512.png"; Size = 512 },
    @{ Name = "icon-192.png"; Size = 192 },
    @{ Name = "maskable-192.png"; Size = 192 },
    @{ Name = "apple-touch-icon-180.png"; Size = 180 },
    @{ Name = "apple-touch-icon.png"; Size = 180 },
    @{ Name = "apple-touch-icon-167.png"; Size = 167 },
    @{ Name = "apple-touch-icon-152.png"; Size = 152 },
    @{ Name = "favicon-32.png"; Size = 32 },
    @{ Name = "favicon-16.png"; Size = 16 }
)

foreach ($t in $targets) {
    $sz = $t.Size
    $destBmp = New-Object System.Drawing.Bitmap $sz, $sz
    $g = [System.Drawing.Graphics]::FromImage($destBmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $rect = New-Object System.Drawing.Rectangle 0, 0, $sz, $sz
    $g.DrawImage($srcImg, $rect)
    $g.Dispose()

    $destPath = Join-Path $iconsDir $t.Name
    $destBmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $destBmp.Dispose()
    Write-Host "Generated $($t.Name) ($sz x $sz)"
}

$srcImg.Dispose()
Write-Host "All resolutions generated successfully with HighQualityBicubic!"
