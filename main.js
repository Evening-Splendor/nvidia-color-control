const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');

// ---- NVIDIA GPU 硬件加速 ----
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// 单实例锁 — 必须在最前面
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// --------------- koffi FFI (lazy init) ---------------
let koffi = null;

// GDI32
let GetDC, ReleaseDC, SetDeviceGammaRamp, GetDeviceGammaRamp;

// NVAPI (via QueryInterface) — working pattern: koffi.decode(QI(id), koffi.proto(sig))
let nvapiReady = false;
let nvDispHandle = null;   // External: NvDisplayHandle for DVC/HUE calls
let NvAPI_GetDVCInfo, NvAPI_SetDVCLevel, NvAPI_GetHUEInfo, NvAPI_SetHUEAngle;

// NVAPI+GDI32 延迟初始化（加速启动）
function initHardware() {
  try { koffi = require('koffi'); } catch { return; }
if (koffi) {
  // ---- GDI32 Gamma Ramp (always available) ----
  try {
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    GetDC = user32.func('__stdcall', 'GetDC', 'void*', ['void*']);
    ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', ['void*', 'void*']);
    const RAMP = koffi.struct('RAMP', {
      Red: koffi.array('uint16_t', 256),
      Green: koffi.array('uint16_t', 256),
      Blue: koffi.array('uint16_t', 256),
    });
    SetDeviceGammaRamp = gdi32.func('__stdcall', 'SetDeviceGammaRamp', 'bool', ['void*', koffi.pointer(RAMP)]);
    GetDeviceGammaRamp = gdi32.func('__stdcall', 'GetDeviceGammaRamp', 'bool', ['void*', koffi.out(koffi.pointer(RAMP))]);
    console.log('[GDI32] Gamma ramp loaded');
  } catch (e) { console.error('[GDI32] Load error:', e.message); }

  // ---- NVAPI via QueryInterface (working koffi.decode pattern) ----
  try {
    const nvapi = koffi.load('nvapi64.dll');
    const QI = nvapi.func('__stdcall', 'nvapi_QueryInterface', 'void*', ['uint32']);

    // Helper: get function pointer and decode into callable JS function
    function nvGetFn(id, sig) {
      return koffi.decode(QI(id), koffi.proto(sig));
    }

    // 1) NvAPI_Initialize (0x0150E828)
    const NvInit = nvGetFn(0x0150E828, 'int f_NvInit()');
    const initR = NvInit();
    if (initR !== 0) throw new Error('NvAPI_Initialize failed: ' + initR);
    console.log('[NVAPI] Initialized');

    // 2) NvAPI_EnumNvidiaDisplayHandle (0x9ABDD40D) → NvDisplayHandle
    const NvEnumDisp = nvGetFn(0x9ABDD40D, 'int f_EnumDisp(unsigned int i, _Out_ void** h)');
    let hBuf = [null];
    const enumR = NvEnumDisp(0, hBuf);
    if (enumR === 0 && hBuf[0]) {
      nvDispHandle = hBuf[0];
      console.log('[NVAPI] Display handle obtained');
    } else {
      console.warn('[NVAPI] Enum display failed:', enumR);
    }

    // 3) NvAPI_DISP_GetDVCInfoEx (0x0E45002D)
    // Struct: version(4) + currentLevel(4) + minLevel(4) + maxLevel(4) + defaultLevel(4) = 20 bytes
    // version = sizeof(20) | 0x10000 = 0x10014
    const DVC_INFO = koffi.struct('NV_DVC_INFO', {
      version: 'uint32',
      currentLevel: 'int32',
      minLevel: 'int32',
      maxLevel: 'int32',
      defaultLevel: 'int32'
    });
    const NvGetDVC = nvGetFn(0x0E45002D, 'int f_GetDVC(void* hDisp, uint32 oid, _Inout_ NV_DVC_INFO* info)');
    NvAPI_GetDVCInfo = function() {
      if (!nvDispHandle) return null;
      let dvc = { version: 0x10014, currentLevel: 0, minLevel: 0, maxLevel: 0, defaultLevel: 0 };
      const r = NvGetDVC(nvDispHandle, 0, dvc);
      if (r !== 0) return null;
      return { current: dvc.currentLevel, min: dvc.minLevel, max: dvc.maxLevel, default: dvc.defaultLevel };
    };

    // 4) NvAPI_DISP_SetDVCLevelEx (0x4A82C2B1)
    const NvSetDVC = nvGetFn(0x4A82C2B1, 'int f_SetDVC(void* hDisp, uint32 oid, _Inout_ NV_DVC_INFO* info)');
    NvAPI_SetDVCLevel = function(level) {
      if (!nvDispHandle) return false;
      let dvc = { version: 0x10014, currentLevel: Math.round(level), minLevel: 0, maxLevel: 100, defaultLevel: 50 };
      const r = NvSetDVC(nvDispHandle, 0, dvc);
      return r === 0;
    };

    // 5) NvAPI_DISP_GetHUEInfo (0x95B64341)
    // Struct: version(4) + currentHueAngle(4) + defaultHueAngle(4) = 12 bytes
    // version = sizeof(12) | 0x10000 = 0x1000C
    const HUE_INFO = koffi.struct('NV_HUE_INFO', {
      version: 'uint32',
      currentHueAngle: 'uint32',
      defaultHueAngle: 'uint32'
    });
    const NvGetHUE = nvGetFn(0x95B64341, 'int f_GetHUE(void* hDisp, uint32 oid, _Inout_ NV_HUE_INFO* info)');
    NvAPI_GetHUEInfo = function() {
      if (!nvDispHandle) return null;
      let hue = { version: 0x1000C, currentHueAngle: 0, defaultHueAngle: 0 };
      const r = NvGetHUE(nvDispHandle, 0, hue);
      if (r !== 0) return null;
      return { current: hue.currentHueAngle, default: hue.defaultHueAngle };
    };

    // 6) NvAPI_DISP_SetHUEAngle (0xF5A0F22C) — no struct, direct uint32
    const NvSetHUE = nvGetFn(0xF5A0F22C, 'int f_SetHUE(void* hDisp, uint32 oid, uint32 angle)');
    NvAPI_SetHUEAngle = function(angle) {
      if (!nvDispHandle) return false;
      let a = Math.round(angle) % 360;
      if (a < 0) a += 360;
      const r = NvSetHUE(nvDispHandle, 0, a);
      return r === 0;
    };

    nvapiReady = true;
    console.log('[NVAPI] All functions loaded — DVC + HUE ready');

  } catch (e) {
    console.warn('[NVAPI] Load error:', e.message);
  }
}
} // end initHardware()

// --------------- Gamma Engine (GDI32) ---------------
// Exact NVIDIA Control Panel ranges → GDI32 gamma ramp
// brightness: 80-120 (100=neutral), contrast: 80-120 (100=neutral), gamma: 0.30-2.80 (1.00=neutral)
function buildGdiRamp(gamma, brightness, contrast) {
  const g = clamp(gamma, 0.30, 2.80);
  const bOff = (clamp(brightness, 80, 120) - 100) / 100;  // -0.20 to +0.20
  const cGain = clamp(contrast, 80, 120) / 100;            // 0.80 to 1.20
  const arr = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.pow(i / 255, 1.0 / g) * cGain + bOff;
    v = clamp(v, 0, 1);
    arr[i] = Math.round(v * 65535);
  }
  return Array.from(arr);
}

function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

function applyGamma(rg, rb, rc, gg, gb, gc, bg, bb, bc) {
  if (!SetDeviceGammaRamp) return false;
  try {
    const ramp = {
      Red: buildGdiRamp(rg, rb, rc),
      Green: buildGdiRamp(gg, gb, gc),
      Blue: buildGdiRamp(bg, bb, bc),
    };
    const hDC = GetDC(null);
    const result = SetDeviceGammaRamp(hDC, ramp);
    ReleaseDC(null, hDC);
    return result;
  } catch (e) { console.error('[Gamma] Error:', e.message); return false; }
}

function resetGamma() {
  if (!SetDeviceGammaRamp) return false;
  try {
    const linear = [];
    for (let i = 0; i < 256; i++) linear.push(i * 257);
    const ramp = { Red: linear, Green: linear, Blue: linear };
    const hDC = GetDC(null);
    SetDeviceGammaRamp(hDC, ramp);
    ReleaseDC(null, hDC);
    return true;
  } catch (e) { return false; }
}

// --------------- DVC / HUE wrappers ---------------
function getDVC() {
  if (!nvapiReady || !NvAPI_GetDVCInfo) return null;
  try { return NvAPI_GetDVCInfo(); } catch (e) { return null; }
}

function setDVC(level) {
  if (!nvapiReady || !NvAPI_SetDVCLevel) return false;
  try { return NvAPI_SetDVCLevel(level); } catch (e) { return false; }
}

function getHUE() {
  if (!nvapiReady || !NvAPI_GetHUEInfo) return null;
  try { return NvAPI_GetHUEInfo(); } catch (e) { return null; }
}

function setHUE(angle) {
  if (!nvapiReady || !NvAPI_SetHUEAngle) return false;
  try { return NvAPI_SetHUEAngle(angle); } catch (e) { return false; }
}

// --------------- Data paths ---------------
const dataDir = app.getPath('userData');
const presetsPath = path.join(dataDir, 'presets.json');
const bindingsPath = path.join(dataDir, 'bindings.json');

const builtInPresets = {
  default: { name:'default', desc:'默认设置',     rg:1.00,gg:1.00,bg:1.00, rb:100,gb:100,bb:100, rc:100,gc:100,bc:100, dvc:50, hue:0,  builtIn:true },
  warm:    { name:'warm',    desc:'暖色护眼',     rg:1.00,gg:0.95,bg:0.85, rb:105,gb:100,bb:95,  rc:102,gc:100,bc:98,  dvc:45, hue:5,  builtIn:true },
  cool:    { name:'cool',    desc:'冷色调',       rg:0.90,gg:0.95,bg:1.00, rb:95, gb:100,bb:105, rc:98, gc:100,bc:102, dvc:50, hue:0,  builtIn:true },
  game:    { name:'game',    desc:'游戏模式',     rg:1.00,gg:1.00,bg:1.00, rb:105,gb:105,bb:105, rc:108,gc:108,bc:108, dvc:65, hue:0,  builtIn:true },
  movie:   { name:'movie',   desc:'观影模式',     rg:0.90,gg:0.90,bg:0.90, rb:102,gb:102,bb:102, rc:105,gc:105,bc:105, dvc:55, hue:0,  builtIn:true },
  read:    { name:'read',    desc:'阅读模式',     rg:0.85,gg:0.85,bg:0.85, rb:110,gb:110,bb:110, rc:90, gc:90, bc:90,  dvc:30, hue:10, builtIn:true },
  vivid:   { name:'vivid',   desc:'鲜艳模式',     rg:1.00,gg:1.00,bg:1.00, rb:100,gb:100,bb:100, rc:115,gc:115,bc:115, dvc:80, hue:0,  builtIn:true },
  night:   { name:'night',   desc:'夜间模式',     rg:0.70,gg:0.70,bg:0.75, rb:95, gb:95, bb:95,  rc:85, gc:85, bc:88,  dvc:20, hue:0,  builtIn:true },
};

function loadPresets() {
  const all = Object.assign({}, builtInPresets);
  if (fs.existsSync(presetsPath)) {
    try {
      const custom = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
      for (const [k, v] of Object.entries(custom)) all[k] = { ...v, builtIn: false };
    } catch {}
  }
  return all;
}

function saveCustomPreset(name, preset) {
  let custom = {};
  if (fs.existsSync(presetsPath)) {
    try { custom = JSON.parse(fs.readFileSync(presetsPath, 'utf-8')); } catch {}
  }
  custom[name] = preset;
  fs.writeFileSync(presetsPath, JSON.stringify(custom, null, 2));
}

function deleteCustomPreset(name) {
  if (!fs.existsSync(presetsPath)) return;
  let custom = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
  delete custom[name];
  if (Object.keys(custom).length === 0) fs.unlinkSync(presetsPath);
  else fs.writeFileSync(presetsPath, JSON.stringify(custom, null, 2));
}

function loadBindings() {
  if (fs.existsSync(bindingsPath)) {
    try { return JSON.parse(fs.readFileSync(bindingsPath, 'utf-8')); } catch {}
  }
  return [];
}

function saveBindingsFile(bindings) {
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2));
}

// --------------- Process Monitor ---------------
let bindings = [];
let monitorInterval = null;
let nvapiPollInterval = null;
let currentActivePreset = null;
let preBindPreset = null;
let bindEnabled = true;

// Track last-applied NVAPI values for drift detection
let lastDVC = 50;
let lastHUE = 0;
let lastGammaParams = null;

// Periodic NVAPI poll: ensure driver values stay correct (every 3 seconds)
function startNvapiPoll() {
  if (nvapiPollInterval) clearInterval(nvapiPollInterval);
  nvapiPollInterval = setInterval(() => {
    if (!nvapiReady) return;
    try {
      const dvcInfo = getDVC();
      const hueInfo = getHUE();
      if (dvcInfo && dvcInfo.current !== lastDVC) {
        setDVC(lastDVC);
        if (win) win.webContents.send('status', 'NVAPI 守护: DVC 已纠正 (' + dvcInfo.current + ' → ' + lastDVC + ')');
      }
      if (hueInfo && hueInfo.current !== lastHUE) {
        setHUE(lastHUE);
        if (win) win.webContents.send('status', 'NVAPI 守护: HUE 已纠正 (' + hueInfo.current + '° → ' + lastHUE + '°)');
      }
      // Re-apply gamma if any app overwrote it
      if (lastGammaParams && GetDeviceGammaRamp) {
        const hDC = GetDC(null);
        const curRamp = {};
        GetDeviceGammaRamp(hDC, curRamp);
        ReleaseDC(null, hDC);
        // Quick check: compare midpoint value to detect drift
        if (curRamp.Red && curRamp.Red[128] !== undefined) {
          const expected = buildGdiRamp(lastGammaParams.rg, lastGammaParams.rb, lastGammaParams.rc);
          if (Math.abs(curRamp.Red[128] - expected[128]) > 500) {
            applyGamma(lastGammaParams.rg, lastGammaParams.rb, lastGammaParams.rc,
                       lastGammaParams.gg, lastGammaParams.gb, lastGammaParams.gc,
                       lastGammaParams.bg, lastGammaParams.bb, lastGammaParams.bc);
            if (win) win.webContents.send('status', 'NVAPI 守护: Gamma 已纠正');
          }
        }
      }
    } catch(e) { /* silent */ }
  }, 3000);
}

function startMonitor() {
  bindings = loadBindings();
  if (monitorInterval) clearInterval(monitorInterval);
  // Start NVAPI polling
  startNvapiPoll();
  monitorInterval = setInterval(() => {
    if (!bindEnabled || bindings.length === 0) return;
    for (const b of bindings) {
      if (!b.enabled) continue;
      const procName = path.basename(b.programPath, '.exe');
      const isRunning = execSync(`tasklist /fi "imagename eq ${procName}.exe" /fo csv /nh`, { encoding: 'utf-8' })
        .toLowerCase().includes(procName.toLowerCase());
      if (isRunning && !b.wasActive) {
        // Only capture restore target for the FIRST binding that fires
        if (preBindPreset === null) preBindPreset = currentActivePreset;
        const p = loadPresets()[b.presetName];
        if (p) {
          applyGamma(p.rg, p.rb, p.rc, p.gg, p.gb, p.gc, p.bg, p.bb, p.bc);
          lastGammaParams = {rg:p.rg, rb:p.rb, rc:p.rc, gg:p.gg, gb:p.gb, gc:p.gc, bg:p.bg, bb:p.bb, bc:p.bc};
          if (p.dvc !== undefined) { setDVC(p.dvc); lastDVC = p.dvc; }
          if (p.hue !== undefined) { setHUE(p.hue); lastHUE = p.hue; }
        }
        currentActivePreset = b.presetName;
        if (win) win.webContents.send('status', `程序绑定: ${b.programName} 启动 → ${b.presetName}`);
      } else if (!isRunning && b.wasActive) {
        b.wasActive = false;
        let otherActive = bindings.some(bb => bb !== b && bb.wasActive);
        if (!otherActive) {
          if (preBindPreset) {
            const prev = loadPresets()[preBindPreset];
            if (prev) {
              applyGamma(prev.rg, prev.rb, prev.rc, prev.gg, prev.gb, prev.gc, prev.bg, prev.bb, prev.bc);
              lastGammaParams = {rg:prev.rg, rb:prev.rb, rc:prev.rc, gg:prev.gg, gb:prev.gb, gc:prev.gc, bg:prev.bg, bb:prev.bb, bc:prev.bc};
              if (prev.dvc !== undefined) { setDVC(prev.dvc); lastDVC = prev.dvc; }
              if (prev.hue !== undefined) { setHUE(prev.hue); lastHUE = prev.hue; }
            }
            currentActivePreset = preBindPreset;
            preBindPreset = null;
          } else {
            resetGamma();
            setDVC(50); lastDVC = 50;
            setHUE(0); lastHUE = 0;
            lastGammaParams = null;
            currentActivePreset = null;
          }
          if (win) win.webContents.send('status', '程序绑定: 已恢复');
        }
      }
      if (isRunning) { b.wasActive = true; }
    }
  }, 2000);
}

// --------------- Window & Tray ---------------
let win = null;
let tray = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const appIcon = nativeImage.createFromPath(iconPath);
  win = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 650,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('renderer/index.html');
  win.on('close', (e) => {
    if (minimizeToTray) {
      e.preventDefault();
      win.hide();
      if (win) win.webContents.send('status', '已最小化到系统托盘');
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray_icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip('NVIDIA 色彩控制');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '🎮 游戏模式', click: () => {
      const p = builtInPresets.game;
      applyGamma(p.rg, p.rb, p.rc, p.gg, p.gb, p.gc, p.bg, p.bb, p.bc);
      if (p.dvc !== undefined) setDVC(p.dvc);
      if (p.hue !== undefined) setHUE(p.hue);
      if (win) win.webContents.send('apply-preset', 'game');
    }},
    { label: '🟠 暖色护眼', click: () => {
      const p = builtInPresets.warm;
      applyGamma(p.rg, p.rb, p.rc, p.gg, p.gb, p.gc, p.bg, p.bb, p.bc);
      if (p.dvc !== undefined) setDVC(p.dvc);
      if (p.hue !== undefined) setHUE(p.hue);
      if (win) win.webContents.send('apply-preset', 'warm');
    }},
    { label: '↺ 恢复默认', click: () => { resetGamma(); setDVC(50); setHUE(0); if (win) win.webContents.send('reset'); } },
    { type: 'separator' },
    { label: '退出', click: () => {
      clearInterval(monitorInterval);
      tray.destroy();
      win.destroy();
      app.quit();
    }},
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// --------------- IPC Handlers ---------------
ipcMain.handle('apply-gamma', (_, params) => {
  lastGammaParams = {
    rg:params.rg, rb:params.rb, rc:params.rc,
    gg:params.gg, gb:params.gb, gc:params.gc,
    bg:params.bg, bb:params.bb, bc:params.bc,
  };
  return applyGamma(
    params.rg, params.rb, params.rc,
    params.gg, params.gb, params.gc,
    params.bg, params.bb, params.bc
  );
});

ipcMain.handle('reset-gamma', () => { lastGammaParams = null; return resetGamma(); });
ipcMain.handle('get-presets', () => {
  return {
    presets: loadPresets(),
    dvc: getDVC(),
    hue: getHUE(),
    nvapi: nvapiReady,
  };
});

ipcMain.handle('save-preset', (_, name, preset) => {
  saveCustomPreset(name, preset);
  return loadPresets();
});

ipcMain.handle('delete-preset', (_, name) => {
  deleteCustomPreset(name);
  return loadPresets();
});

ipcMain.handle('get-dvc', () => getDVC());
ipcMain.handle('set-dvc', (_, level) => { lastDVC = Math.round(level); return setDVC(level); });
ipcMain.handle('get-hue', () => getHUE());
ipcMain.handle('set-hue', (_, angle) => { lastHUE = Math.round(angle); return setHUE(angle); });
ipcMain.handle('get-bindings', () => bindings);
ipcMain.handle('save-bindings', (_, newBindings) => {
  bindings = newBindings;
  saveBindingsFile(bindings);
  return bindings;
});
ipcMain.handle('set-bind-enabled', (_, enabled) => { bindEnabled = enabled; });
ipcMain.handle('set-active-preset', (_, name) => { currentActivePreset = name; });
ipcMain.handle('window-minimize', () => win.minimize());
ipcMain.handle('window-close', () => { win.hide(); });
ipcMain.handle('browse-exe', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择程序',
    filters: [{ name: '可执行文件', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Auto-start toggle
ipcMain.handle('get-autostart', () => {
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-autostart', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return app.getLoginItemSettings().openAtLogin;
});

// Settings: minimize-to-tray (default true)
let minimizeToTray = true;
ipcMain.handle('get-setting', (_, key) => {
  if (key === 'minimizeToTray') return minimizeToTray;
  if (key === 'autostart') return app.getLoginItemSettings().openAtLogin;
  return null;
});
ipcMain.handle('set-setting', (_, key, value) => {
  if (key === 'minimizeToTray') { minimizeToTray = !!value; return true; }
  if (key === 'autostart') { app.setLoginItemSettings({ openAtLogin: !!value }); return true; }
  return false;
});

// --------------- App Lifecycle ---------------
app.setLoginItemSettings({ openAtLogin: false }); // 默认关闭，用户可选

app.whenReady().then(() => {
  createWindow();
  createTray();
  // 让出主线程先渲染窗口，再加载 NVAPI/驱动
  setTimeout(() => {
    initHardware();
    if (win) win.webContents.send('status', nvapiReady ? 'NVAPI 已连接 - 直接控制显卡' : '使用 GDI32 伽马通道（NVAPI 未就绪）');
    startMonitor();
  }, 50);
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  clearInterval(monitorInterval);
  clearInterval(nvapiPollInterval);
  resetGamma();
  setDVC(50);
  setHUE(0);
});
