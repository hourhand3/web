const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const ROOT = __dirname;
const MEDIAPIPE_DIR = path.join(ROOT, 'lib', 'mediapipe');
const BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619';

const FILES = [
  'face_mesh.min.js',
  'face_mesh_solution_wasm_bin.js',
  'face_mesh_solution_simd_wasm_bin.js',
  'face_mesh_solution_packed_assets_loader.js',
  'face_mesh.binarypb'
];

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.wasm':  'application/wasm',
  '.bin':   'application/octet-stream',
  '.data':  'application/octet-stream',
  '.pb':    'application/octet-stream'
};

function downloadFile(url, outPath) {
  return new Promise((resolve) => {
    if (fs.existsSync(outPath)) {
      console.log(`[缓存] ${path.basename(outPath)} 已存在`);
      resolve(true);
      return;
    }
    console.log(`[下载] ${url}`);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.log(`[失败] ${path.basename(outPath)} HTTP ${res.statusCode}`);
        resolve(false);
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => {
        const size = fs.statSync(outPath).size;
        console.log(`[成功] ${path.basename(outPath)} (${size} bytes)`);
        file.close();
        resolve(true);
      });
    }).on('error', (err) => {
      console.log(`[失败] ${path.basename(outPath)} ${err.message}`);
      resolve(false);
    });
  });
}

async function ensureMediaPipeFiles() {
  if (!fs.existsSync(MEDIAPIPE_DIR)) {
    fs.mkdirSync(MEDIAPIPE_DIR, { recursive: true });
  }
  console.log('检查并下载 MediaPipe 文件...');
  let success = false;
  for (const file of FILES) {
    const url = `${BASE_URL}/${file}`;
    const outPath = path.join(MEDIAPIPE_DIR, file);
    const ok = await downloadFile(url, outPath);
    if (ok) success = true;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(success ? 'MediaPipe 文件准备完成！' : '部分文件下载失败，将使用 CDN');
}

function serveFile(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    };
    
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function main() {
  await ensureMediaPipeFiles();
  
  http.createServer(serveFile).listen(PORT, '0.0.0.0', () => {
    console.log(`\n服务器已启动！`);
    console.log(`本地访问: http://127.0.0.1:${PORT}`);
    console.log(`手机访问: http://192.168.110.195:${PORT}`);
    console.log(`\nMediaPipe 文件位置: ${MEDIAPIPE_DIR}`);
  });
}

main().catch(console.error);