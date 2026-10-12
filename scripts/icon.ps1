$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'assets/logo.png'))
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size,$size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $size, $size)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images += ,$stream.ToArray()
      if ($size -eq 256) {
        [System.IO.File]::WriteAllBytes((Join-Path $projectRoot 'assets/icon.png'), $stream.ToArray())
      }
    } finally {
      $stream.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
  $ico = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter $ico
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Length)
    $offset = 6 + 16 * $sizes.Length
    for ($index = 0; $index -lt $sizes.Length; $index++) {
      $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$index].Length
    }
    foreach ($png in $images) { $writer.Write([byte[]]$png) }
    [System.IO.File]::WriteAllBytes((Join-Path $projectRoot 'assets/icon.ico'), $ico.ToArray())
  } finally {
    $writer.Dispose()
    $ico.Dispose()
  }
} finally { $source.Dispose() }
