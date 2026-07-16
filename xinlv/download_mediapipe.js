const https = require('https');
const fs = require('fs');
const path = require('path');

const baseUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619';
const files = [
  'face_mesh.min.js',
  'face_mesh_solution_wasm_bin.js',
  'face_mesh_solution_simd_wasm_bin.js',
  'face_mesh_solution_packed_assets_loader.js',
  'face_mesh.binarypb'
];

const outDir = path.join(__dirname, 'lib', 'mediapipe');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function downloadFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(outPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(outPath, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('Downloading MediaPipe files...');
  for (const file of files) {
    const url = `${baseUrl}/${file}`;
    const outPath = path.join(outDir, file);
    console.log(`Downloading: ${url}`);
    try {
      await downloadFile(url, outPath);
      const stats = fs.statSync(outPath);
      console.log(`  OK: ${file} (${stats.size} bytes)`);
    } catch (err) {
      console.error(`  FAILED: ${file}`);
      console.error(err.message);
    }
  }
  console.log('Done!');
}

main().catch(console.error);