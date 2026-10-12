Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(53,120,246))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White),18
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$points = [System.Drawing.Point[]] @((New-Object System.Drawing.Point 50,76),(New-Object System.Drawing.Point 82,182),(New-Object System.Drawing.Point 128,100),(New-Object System.Drawing.Point 174,182),(New-Object System.Drawing.Point 206,76))
$graphics.DrawLines($pen,$points)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $PWD 'assets/icon.png'), $png)
$ico = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $ico
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$png.Length)
$writer.Write([uint32]22)
$writer.Write($png)
[System.IO.File]::WriteAllBytes((Join-Path $PWD 'assets/icon.ico'), $ico.ToArray())
$writer.Dispose()
$ico.Dispose()
$stream.Dispose()
$pen.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
