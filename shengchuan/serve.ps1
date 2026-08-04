﻿$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("https://+:8443/")
$listener.Prefixes.Add("http://+:8000/")
$listener.Start()
Write-Host "========================================="
Write-Host "  HTTPS (phone): https://192.168.110.195:8443/"
Write-Host "  HTTP  (PC):    http://localhost:8000/"
Write-Host "========================================="
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" } | Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) { Write-Host "  Phone HTTPS: https://$($ip):8443/" }
Write-Host ""
$mimeMap = @{ ".html"="text/html; charset=utf-8"; ".js"="application/javascript; charset=utf-8"; ".mjs"="application/javascript; charset=utf-8"; ".css"="text/css; charset=utf-8"; ".json"="application/json; charset=utf-8"; ".ts"="application/javascript; charset=utf-8"; ".png"="image/png"; ".svg"="image/svg+xml"; ".ico"="image/x-icon" }
$distPath = Join-Path (Get-Location) "dist"
$indexHtml = Join-Path $distPath "index.html"
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $urlPath = $req.Url.LocalPath
    if ($urlPath -eq "/") { $urlPath = "/index.html" }
    $relativePath = $urlPath -replace "/", "\"
    $filePath = Join-Path $distPath $relativePath.TrimStart("\")
    if (-not (Test-Path $filePath -PathType Leaf)) { $filePath = $indexHtml }
    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        if ($mimeMap.ContainsKey($ext)) { $contentType = $mimeMap[$ext] } else { $contentType = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentType = $contentType
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $res.StatusCode = 404 }
    $res.Close()
}
