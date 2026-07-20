# 🎨 NVIDIA Color Control

> A modern Electron desktop application for controlling NVIDIA GPU color settings directly through NVAPI, replicating the NVIDIA Control Panel's "Adjust desktop color settings" interface.

[🇨🇳 中文](#chinese) | [🇺🇸 English](#english)

---

<a name="chinese"></a>
## 🇨🇳 中文

### 简介

NVIDIA 色彩通道控制台是一个基于 Electron 的桌面应用，通过 **NVAPI** 直接控制 NVIDIA 显卡驱动的色彩参数，完美还原 NVIDIA 控制面板「调整桌面颜色设置」的所有功能。

### 功能特性

- 🎮 **NVAPI 直连显卡** — 绕过 Windows GDI32 Gamma Ramp，通过 `nvapi64.dll` 直接读写显卡 LUT
- 🎨 **四通道独立调节** — 所有通道 / 红色 / 绿色 / 蓝色，每个通道独立伽马/亮度/对比度
- 📐 **精确匹配 N 卡面板** — 5 个滑块范围与 NVIDIA Control Panel 完全一致：
  - 亮度 Brightness: **80 – 120**（默认 100）
  - 对比度 Contrast: **80 – 120**（默认 100）
  - 灰度 Gamma: **0.30 – 2.80**（默认 1.00）
  - 数字亮丽 Digital Vibrance: **0 – 100%**（默认 50%）
  - 色调 Hue: **0 – 359°**（默认 0°）
- 💾 **预设方案系统** — 内置 8 套预设（默认/暖色/冷色/游戏/观影/阅读/鲜艳/夜间），支持自定义保存
- 🔗 **程序绑定** — 检测特定 .exe 启动时自动切换色彩方案
- 🛡️ **实时守护** — 每 3 秒轮询 NVAPI，检测并纠正其他程序对显卡参数的篡改
- 📋 **系统托盘** — 最小化到托盘，右键菜单快速切换方案
- ⚙️ **开机自启 / 最小化到托盘** — 设置页可选开关
- 🖥️ **现代 UI** — 毛玻璃透明窗口、暗色主题、无边框设计

### 技术栈

| 层级 | 技术 |
|---|---|
| 桌面框架 | Electron 33 |
| FFI 库 | [koffi](https://koffi.dev/) 2.x |
| 显卡接口 | NVAPI (`nvapi64.dll`) |
| 伽马回退 | GDI32 `SetDeviceGammaRamp` |
| 打包 | electron-builder |

### 核心突破

NVAPI 函数指针原本无法在 JavaScript 中直接调用。本项目通过 **`koffi.decode()` + `koffi.proto()`** 模式成功绕过了这一限制：

```javascript
const nvapi = koffi.load('nvapi64.dll');
const QI = nvapi.func('__stdcall', 'nvapi_QueryInterface', 'void*', ['uint32']);
function nvGetFn(id, sig) {
  return koffi.decode(QI(id), koffi.proto(sig));
}
```

### 快速开始

```bash
# 安装依赖
npm install

# 启动应用
npm start

# 打包为便携版 .exe
npm run build
```

### 系统要求

- Windows 10 / 11
- NVIDIA 显卡 + 驱动
- 不需要管理员权限

### 项目结构

```
nvidia-color-control/
├── main.js          # Electron 主进程 + NVAPI 交互
├── preload.js       # 上下文桥接
├── renderer/
│   ├── index.html   # UI 界面
│   └── app.js       # 前端逻辑
├── assets/
│   └── icon.png     # 应用图标
└── package.json
```

---

<a name="english"></a>
## 🇺🇸 English

### Overview

NVIDIA Color Control is an Electron desktop app that directly controls NVIDIA GPU color settings via **NVAPI**, faithfully replicating the NVIDIA Control Panel's "Adjust desktop color settings" tab.

### Features

- 🎮 **Direct NVAPI Control** — Reads/writes GPU LUT through `nvapi64.dll`, bypassing Windows GDI32 gamma ramp
- 🎨 **4-Channel Independent Control** — All / Red / Green / Blue channels with per-channel gamma/brightness/contrast
- 📐 **Exact NCP Match** — 5 sliders with ranges identical to NVIDIA Control Panel
- 💾 **Preset System** — 8 built-in presets + custom user presets
- 🔗 **Program Bindings** — Auto-switch color profile when a bound .exe launches
- 🛡️ **Real-time Guardian** — Polls NVAPI every 3s to detect and correct driver tampering
- 📋 **System Tray** — Minimize to tray with quick-switch context menu
- ⚙️ **Auto-start / Minimize to tray** — Optional toggles in settings tab
- 🖥️ **Modern UI** — Acrylic transparency, dark theme, frameless window

### Tech Stack

| Layer | Technology |
|---|---|
| Desktop Framework | Electron 33 |
| FFI Library | [koffi](https://koffi.dev/) 2.x |
| GPU Interface | NVAPI (`nvapi64.dll`) |
| Gamma Fallback | GDI32 `SetDeviceGammaRamp` |
| Packaging | electron-builder |

### Key Breakthrough

NVAPI function pointers are not directly callable from JavaScript. This project solves it using the **`koffi.decode()` + `koffi.proto()`** pattern:

```javascript
const nvapi = koffi.load('nvapi64.dll');
const QI = nvapi.func('__stdcall', 'nvapi_QueryInterface', 'void*', ['uint32']);
function nvGetFn(id, sig) {
  return koffi.decode(QI(id), koffi.proto(sig));
}
```

### Quick Start

```bash
npm install
npm start
npm run build     # portable .exe
```

### Requirements

- Windows 10 / 11
- NVIDIA GPU with drivers
- No admin privileges required

---

## 📄 License

MIT — see [LICENSE](LICENSE)

