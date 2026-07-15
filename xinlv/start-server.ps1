<#
.SYNOPSIS
  启动本地 HTTP 服务器供 rPPG 心率检测网页使用
.DESCRIPTION
  摄像头 API 必须在 http(s)://localhost 或 HTTPS 下才能被浏览器授权
  本脚本在本机 8080 端口启动一个轻量静态文件服务器
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
  然后浏览器访问 http://localhost:8080
#>
$port = 8080
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$MIME = @{
    '.html' = 'text/html; charset=utf-8'; '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'; '.json' = 'application/json'
    '.svg'  = 'image/svg+xml'; '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg';      '.jpeg' = 'image/jpeg'
    '.ico'  = 'image/x-icon';    '.md'   = 'text/markdown'
}
Add-Type -AssemblyName System.Web
try {
    $endpoint = New-Object System.Net.IPEndPoint ([System.Net.IPAddress]::Loopback, $port)
    $listener = New-Object System.Net.Sockets.TcpListener $endpoint
    $listener.Start()
} catch {
    Write-Host "无法启动端口 $port，尝试使用 HttpListener ..." -ForegroundColor Yellow
    try {
        $prefix = "http://localhost:$port/"
        $hl = New-Object System.Net.HttpListener
        $hl.Prefixes.Add($prefix)
        $hl.Start()
        Write-Host "✅ HttpListener 模式已启动" -ForegroundColor Green
        Write-Host "🌐 访问: http://localhost:$port"  -ForegroundColor Cyan
        Write-Host "   按 Ctrl+C 停止" -ForegroundColor Gray
        while ($hl.IsListening) {
            $ctx = $hl.GetContext()
            $req = $ctx.Request; $resp = $ctx.Response
            $raw = $req.Url.LocalPath
            $path = [System.Web.HttpUtility]::UrlDecode($raw.Split('?')[0])
            if ($path -eq '/') { $path = '/index.html' }
            $file = Join-Path $root $path.TrimStart('/', '\')
            $full = [System.IO.Path]::GetFullPath($file)
            if ((Test-Path $full -PathType Leaf) -and $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $ext = [System.IO.Path]::GetExtension($full).ToLower()
                $resp.ContentType = if ($MIME.ContainsKey($ext)) { $MIME[$ext] } else { 'application/octet-stream' }
                $resp.ContentLength64 = $bytes.Length
                $resp.AddHeader('Access-Control-Allow-Origin', '*')
                $resp.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $resp.StatusCode = 404
                $b = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
                $resp.ContentType = 'text/plain'
                $resp.ContentLength64 = $b.Length
                $resp.OutputStream.Write($b, 0, $b.Length)
            }
            $resp.Close()
        }
        exit 0
    } catch {
        Write-Error "启动失败: $_"
        Write-Host "替代方案: 安装 Python 3 后执行" -ForegroundColor Yellow
        Write-Host "  python -m http.server $port"  -ForegroundColor Cyan
        exit 1
    }
}
Write-Host "✅ TcpListener 模式已启动" -ForegroundColor Green
Write-Host "🌐 访问: http://localhost:$port"  -ForegroundColor Cyan
Write-Host "   按 Ctrl+C 停止" -ForegroundColor Gray
while ($true) {
    try {
        $client = $listener.AcceptTcpClient()
        $ns = $client.GetStream()
        $buf = New-Object byte[] 8192
        $n = $ns.Read($buf, 0, $buf.Length)
        $reqStr = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
        $parts = $reqStr -split '\r?\n'
        $line = $parts[0] -split ' '
        $raw = if ($line.Count -ge 2) { $line[1] } else { '/' }
        $path = [System.Web.HttpUtility]::UrlDecode($raw.Split('?')[0])
        if ($path -eq '/') { $path = '/index.html' }
        $file = Join-Path $root $path.TrimStart('/', '\')
        $full = [System.IO.Path]::GetFullPath($file)
        [byte[]]$body = $null
        $mime = 'application/octet-stream'
        $status = '200 OK'
        if ((Test-Path $full -PathType Leaf) -and $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $body = [System.IO.File]::ReadAllBytes($full)
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            if ($MIME.ContainsKey($ext)) { $mime = $MIME[$ext] }
        } else {
            $status = '404 Not Found'
            $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $mime = 'text/plain'
        }
        $header = "HTTP/1.1 $status`r`nContent-Type: $mime`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nAccess-Control-Allow-Origin: *`r`n`r`n"
        $headBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
        $ns.Write($headBytes, 0, $headBytes.Length)
        $ns.Write($body, 0, $body.Length)
        $ns.Flush()
        $client.Close()
    } catch {
        try { if ($client) { $client.Close() } } catch {}
    }
}
