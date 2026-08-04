// DNS 修复脚本 - 绕过 Node.js 的 getaddrinfo 故障
// 通过 NODE_OPTIONS=--require=./dns-fix.js 加载
const dns = require('dns');

const originalLookup = dns.lookup;

// 已知域名 IP 映射 (通过 PowerShell Resolve-DnsName 获取)
const knownIPs = {
  'registry.npmmirror.com': '119.188.172.139',
  'registry.npmjs.org': '104.16.2.34',
  'www.npmmirror.com': '119.188.172.139',
  'cdn.npmmirror.com': '119.188.172.139',
  'nodejs.org': '104.16.2.34',
  'esm.sh': '104.16.2.34',
  'unpkg.com': '104.16.2.34',
};

// 动态解析缓存 (通过 child_process 调用 PowerShell)
const { execSync } = require('child_process');
const dynamicCache = new Map();

function resolveWithPowerShell(hostname) {
  if (dynamicCache.has(hostname)) return dynamicCache.get(hostname);
  try {
    const result = execSync(
      `powershell -NoProfile -Command "(Resolve-DnsName -Name '${hostname}' -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress"`,
      { timeout: 5000, encoding: 'utf-8' }
    ).trim();
    if (result && /^\d+\.\d+\.\d+\.\d+$/.test(result)) {
      dynamicCache.set(hostname, result);
      return result;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (!options) options = {};

  // 先查硬编码映射
  if (knownIPs[hostname]) {
    return callback(null, knownIPs[hostname], 4);
  }

  // 尝试 PowerShell 动态解析
  const ip = resolveWithPowerShell(hostname);
  if (ip) {
    return callback(null, ip, 4);
  }

  // 回退到原始 lookup
  return originalLookup.call(dns, hostname, options, callback);
};

// 同时设置默认结果顺序
dns.setDefaultResultOrder('ipv4first');
