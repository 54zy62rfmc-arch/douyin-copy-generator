'use strict';
/**
 * 桌面启动器：双击快捷方式后执行
 * 1. 服务已在运行 → 直接打开浏览器
 * 2. 未运行 → 启动服务（--experimental-sqlite），等端口就绪后打开浏览器
 */

const http = require('node:http');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');

const PORT = process.env.PORT || 8000;
const URL_OPEN = `http://127.0.0.1:${PORT}`;
const APP_DIR = __dirname;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(URL_OPEN + '/api/history', (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function waitReady(tries = 30) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < tries; i++) {
      if (await ping()) return resolve(true);
      await new Promise((r) => setTimeout(r, 500));
    }
    resolve(false);
  });
}

function openBrowser() {
  exec(`start "" "${URL_OPEN}"`);
}

(async () => {
  if (await ping()) {
    console.log('[启动器] 服务已在运行，直接打开页面');
    openBrowser();
    return;
  }
  console.log('[启动器] 正在启动服务…');
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    windowsHide: true,
  });
  child.unref();

  const ok = await waitReady();
  if (ok) {
    console.log('[启动器] 服务已就绪，打开页面');
    openBrowser();
  } else {
    console.error('[启动器] 服务启动超时，请检查 8000 端口是否被占用');
    process.exitCode = 1;
  }
  // 停留 2 秒让用户看到提示再关窗
  setTimeout(() => process.exit(process.exitCode || 0), 2000);
})();
