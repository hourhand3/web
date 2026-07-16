const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const ROOT = __dirname;

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.map':   'application/json',
  '.wasm':  'application/wasm',
  '.bin':   'application/octet-stream',
  '.data':  'application/octet-stream'
};

const server = http.createServer((req, res) => {
  let closed = false;
  const onAbort = () => { closed = true; };
  req.on('aborted', onAbort);
  req.on('close', () => { closed = true; });

  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stat) => {
      if (closed) return;
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('Not Found: ' + urlPath);
      }

      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      };

      if (ext === '.wasm' || ext === '.bin' || ext === '.data') {
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      }

      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }

      const stream = fs.createReadStream(filePath);
      stream.on('error', (e) => {
        if (closed) return;
        try {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Stream Error: ' + e.message);
        } catch (_) {}
      });
      res.on('error', () => { closed = true; try { stream.destroy(); } catch (_) {} });
      stream.pipe(res);
    });
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server Error: ' + e.message);
  }
});

server.on('clientError', (err, socket) => {
  try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); }
  catch (_) { try { socket.destroy(); } catch (_) {} }
});

process.on('uncaughtException', (e) => {
  try { console.error('[SERVER] uncaught:', e.message); } catch (_) {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP server running at http://0.0.0.0:' + PORT + '/');
  console.log('Local: http://127.0.0.1:' + PORT + '/');
  console.log('LAN: http://192.168.110.195:' + PORT + '/');
  console.log('Serving: ' + ROOT);
});
