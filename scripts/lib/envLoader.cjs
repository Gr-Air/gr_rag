// ============================================================
// 环境变量加载器（CommonJS）
// 从项目根目录 .env 文件加载环境变量
// ============================================================

const fs = require('fs');
const path = require('path');

/**
 * 加载 .env 文件中的环境变量（仅设置尚未定义的环境变量）
 */
function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

module.exports = { loadEnv };
