// ==================== State ====================
var presets = {};
var bindings = [];
var currentPreset = 'default';
var nvapiReady = false;
var activeChannel = 'all'; // 'all' | 'red' | 'green' | 'blue'

// All 9 internal channel values + DVC + HUE (exact NVIDIA Control Panel ranges)
var ch = {
  rg:1.0, rb:100, rc:100,
  gg:1.0, gb:100, gc:100,
  bg:1.0, bb:100, bc:100,
  dvc: 50, hue: 0,
};

var sliderDefs = {
  gamma: { min: 0.30, max: 2.80, step: 0.01, def: 1.00, decimals: 2, label: '灰度 Gamma' },
  bri:   { min: 80, max: 120, step: 1, def: 100, decimals: 0, label: '亮度 Brightness' },
  con:   { min: 80, max: 120, step: 1, def: 100, decimals: 0, label: '对比度 Contrast' },
  dvc:   { min: 0, max: 100, step: 1, def: 50, decimals: 0, label: '数字亮丽 DVC' },
  hue:   { min: 0, max: 359, step: 1, def: 0, decimals: 0, label: '色调 Hue' },
};

// ==================== Init ====================
async function init() {
  var result = await nvidiaAPI.getPresets();
  presets = result.presets || result;
  nvapiReady = result.nvapi || false;

  refreshPresetSelect();
  refreshBindPresetSelect();
  setupChannelSelector();

  // Load current DVC/HUE from driver
  if (nvapiReady) {
    var dvcInfo = result.dvc;
    var hueInfo = result.hue;
    if (dvcInfo) {
      ch.dvc = dvcInfo.current;
      setSliderUI('dvc', ch.dvc);
    }
    if (hueInfo) {
      ch.hue = hueInfo.current;
      setSliderUI('hue', ch.hue);
    }
  }

  await loadBindings();
  loadPresetToSliders('default');

  nvidiaAPI.onStatus(function(msg) { setStatus(msg); });
  nvidiaAPI.onApplyPreset(function(name) { loadPresetToSliders(name); });
  nvidiaAPI.onReset(function() { setAllDefaults(); });

  // Settings checkboxes
  try {
    var autoOn = await nvidiaAPI.getSetting('autostart');
    document.getElementById('autostart-chk').checked = autoOn;
    var trayOn = await nvidiaAPI.getSetting('minimizeToTray');
    document.getElementById('tray-chk').checked = trayOn;
  } catch(e) {}

  setStatus(nvapiReady ? 'NVAPI 已连接 - 直接控制显卡' : '使用 GDI32 伽马通道（NVAPI 未就绪）');
}

// ==================== Settings toggles ====================
async function toggleAutostart() {
  var chk = document.getElementById('autostart-chk');
  await nvidiaAPI.setSetting('autostart', chk.checked);
  var st = document.getElementById('settings-status');
  if (st) st.textContent = chk.checked ? '已开启开机自启动' : '已关闭开机自启动';
}

async function toggleMinimizeToTray() {
  var chk = document.getElementById('tray-chk');
  await nvidiaAPI.setSetting('minimizeToTray', chk.checked);
  var st = document.getElementById('settings-status');
  if (st) st.textContent = chk.checked ? '关闭窗口将最小化到托盘' : '关闭窗口将退出程序';
}

// ==================== Channel Selector ====================
function setupChannelSelector() {
  var btns = document.querySelectorAll('.ch-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function() {
      var allBtns = document.querySelectorAll('.ch-btn');
      for (var j = 0; j < allBtns.length; j++) allBtns[j].classList.remove('active');
      this.classList.add('active');
      activeChannel = this.dataset.ch;
      updateSlidersForChannel();
    });
  }
}

function updateSlidersForChannel() {
  // Gamma/Bri/Con: show values for active channel
  var vals;
  if (activeChannel === 'red')   vals = { gamma: ch.rg, bri: ch.rb, con: ch.rc };
  else if (activeChannel === 'green') vals = { gamma: ch.gg, bri: ch.gb, con: ch.gc };
  else if (activeChannel === 'blue')  vals = { gamma: ch.bg, bri: ch.bb, con: ch.bc };
  else vals = { gamma: ch.rg, bri: ch.rb, con: ch.rc }; // 'all' shows red as reference

  setSliderUI('gamma', vals.gamma);
  setSliderUI('bri', vals.bri);
  setSliderUI('con', vals.con);

  // DVC and Hue are global — always show current values
  setSliderUI('dvc', ch.dvc);
  setSliderUI('hue', ch.hue);

  // Update slider thumb color for gamma/bri/con (dvc/hue keep accent color)
  var inputs = document.querySelectorAll('#slider-card input[type=range]');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    // Only recolor gamma/bri/con sliders
    if (el.id === 'slider-dvc' || el.id === 'slider-hue') continue;
    el.className = el.className.replace(/slider-\w+/, 'slider-' + activeChannel);
  }
}

function setSliderUI(type, val) {
  var sd = sliderDefs[type];
  var slider = document.getElementById('slider-' + type);
  var label = document.getElementById('val-' + type);
  if (slider) slider.value = val;
  if (label) label.textContent = formatVal(type, val, sd.decimals);
}

function formatVal(type, v, d) {
  if (type === 'dvc') return Math.round(v) + '%';
  if (type === 'hue') return Math.round(v) + '°';
  return v.toFixed(d);
}

// ==================== Slider Events ====================
function onSlider(type) {
  var val = parseFloat(document.getElementById('slider-' + type).value);
  var sd = sliderDefs[type];
  document.getElementById('val-' + type).textContent = formatVal(type, val, sd.decimals);

  if (type === 'dvc') {
    ch.dvc = val;
    nvidiaAPI.setDVC(val);
    return;
  }
  if (type === 'hue') {
    ch.hue = val;
    nvidiaAPI.setHUE(val);
    return;
  }

  // Gamma/Bri/Con: apply to selected channel(s)
  var key = type === 'gamma' ? 'g' : (type === 'bri' ? 'b' : 'c');
  if (activeChannel === 'all') {
    ch['r' + key] = val;
    ch['g' + key] = val;
    ch['b' + key] = val;
  } else if (activeChannel === 'red') {
    ch['r' + key] = val;
  } else if (activeChannel === 'green') {
    ch['g' + key] = val;
  } else if (activeChannel === 'blue') {
    ch['b' + key] = val;
  }

  updateChannelPreview();
  if (document.getElementById('realtime').checked) applyCurrent();
}

function resetSlider(type) {
  var sd = sliderDefs[type];
  setSliderUI(type, sd.def);
  document.getElementById('val-' + type).textContent = formatVal(type, sd.def, sd.decimals);

  if (type === 'dvc') {
    ch.dvc = sd.def;
    nvidiaAPI.setDVC(sd.def);
    return;
  }
  if (type === 'hue') {
    ch.hue = sd.def;
    nvidiaAPI.setHUE(sd.def);
    return;
  }

  var key = type === 'gamma' ? 'g' : (type === 'bri' ? 'b' : 'c');
  if (activeChannel === 'all') {
    ch['r' + key] = sd.def;
    ch['g' + key] = sd.def;
    ch['b' + key] = sd.def;
  } else if (activeChannel === 'red') {
    ch['r' + key] = sd.def;
  } else if (activeChannel === 'green') {
    ch['g' + key] = sd.def;
  } else if (activeChannel === 'blue') {
    ch['b' + key] = sd.def;
  }

  updateChannelPreview();
  if (document.getElementById('realtime').checked) applyCurrent();
}

// ==================== Channel Preview ====================
function updateChannelPreview() {
  function g(v) { return v.toFixed(2); }
  function n(v) { return Math.round(v); }
  document.getElementById('pv-red').textContent =
    g(ch.rg) + ' / ' + n(ch.rb) + ' / ' + n(ch.rc);
  document.getElementById('pv-green').textContent =
    g(ch.gg) + ' / ' + n(ch.gb) + ' / ' + n(ch.gc);
  document.getElementById('pv-blue').textContent =
    g(ch.bg) + ' / ' + n(ch.bb) + ' / ' + n(ch.bc);
}

// ==================== Apply ====================
async function applyCurrent() {
  await nvidiaAPI.applyGamma(ch);
}

// ==================== Presets ====================
function loadPresetToSliders(name) {
  var p = presets[name];
  if (!p) return;
  currentPreset = name;
  ch.rg = p.rg; ch.rb = p.rb; ch.rc = p.rc;
  ch.gg = p.gg; ch.gb = p.gb; ch.gc = p.gc;
  ch.bg = p.bg; ch.bb = p.bb; ch.bc = p.bc;
  ch.dvc = (p.dvc !== undefined) ? p.dvc : 50;
  ch.hue = (p.hue !== undefined) ? p.hue : 0;
  updateSlidersForChannel();
  updateChannelPreview();
}

function onPresetSelect() {
  var name = document.getElementById('preset-select').value;
  if (name && presets[name]) {
    loadPresetToSliders(name);
    if (document.getElementById('realtime').checked) applyCurrent();
    // Also apply DVC/HUE
    if (ch.dvc !== undefined) nvidiaAPI.setDVC(ch.dvc);
    if (ch.hue !== undefined) nvidiaAPI.setHUE(ch.hue);
    setStatus('已加载: ' + name + ' (' + presets[name].desc + ')');
  }
}

async function applyPreset() {
  var name = document.getElementById('preset-select').value;
  if (name && presets[name]) {
    loadPresetToSliders(name);
    await applyCurrent();
    nvidiaAPI.setDVC(ch.dvc);
    nvidiaAPI.setHUE(ch.hue);
    setStatus('已应用: ' + name + ' (' + presets[name].desc + ')');
  }
}

async function resetAll() {
  ch = { rg:1, rb:100, rc:100, gg:1, gb:100, gc:100, bg:1, bb:100, bc:100, dvc:50, hue:0 };
  updateSlidersForChannel();
  updateChannelPreview();
  await nvidiaAPI.resetGamma();
  nvidiaAPI.setDVC(50);
  nvidiaAPI.setHUE(0);
  document.getElementById('preset-select').selectedIndex = 0;
  currentPreset = 'default';
  setStatus('已恢复默认');
}

function setAllDefaults() {
  ch = { rg:1, rb:100, rc:100, gg:1, gb:100, gc:100, bg:1, bb:100, bc:100, dvc:50, hue:0 };
  updateSlidersForChannel();
  updateChannelPreview();
}

// ==================== Save/Delete ====================
function showSaveModal() {
  document.getElementById('save-modal').classList.add('show');
  document.getElementById('save-name').value = '';
  document.getElementById('save-desc').value = '';
  document.getElementById('save-name').focus();
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.remove('show');
}

async function doSavePreset() {
  var name = document.getElementById('save-name').value.trim();
  if (!name) return;
  var desc = document.getElementById('save-desc').value.trim() || '自定义';
  var preset = { desc: desc };
  // Copy all ch values
  var keys = Object.keys(ch);
  for (var i = 0; i < keys.length; i++) preset[keys[i]] = ch[keys[i]];
  presets = await nvidiaAPI.savePreset(name, preset);
  refreshPresetSelect();
  refreshBindPresetSelect();
  closeSaveModal();
  setStatus('已保存方案: ' + name);
}

async function deletePreset() {
  var name = document.getElementById('preset-select').value;
  if (!name) return;
  if (presets[name] && presets[name].builtIn) { alert('不能删除内置方案'); return; }
  if (!confirm('确定删除方案 "' + name + '"？')) return;
  presets = await nvidiaAPI.deletePreset(name);
  refreshPresetSelect();
  refreshBindPresetSelect();
  setStatus('已删除: ' + name);
}

// ==================== UI Refresh ====================
function refreshPresetSelect() {
  var sel = document.getElementById('preset-select');
  sel.innerHTML = '';
  var keys = Object.keys(presets);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v = presets[k];
    var tag = v.builtIn ? '[内置]' : '[自定义]';
    var opt = document.createElement('option');
    opt.value = k;
    opt.textContent = tag + ' ' + k + ' - ' + v.desc;
    sel.appendChild(opt);
  }
  if (sel.options.length > 0) sel.selectedIndex = 0;
}

function refreshBindPresetSelect() {
  var sel = document.getElementById('bind-preset-select');
  if (!sel) return;
  sel.innerHTML = '';
  var keys = Object.keys(presets);
  for (var i = 0; i < keys.length; i++) {
    var opt = document.createElement('option');
    opt.value = keys[i];
    opt.textContent = keys[i];
    sel.appendChild(opt);
  }
}

function setStatus(msg) {
  document.getElementById('main-status').innerHTML =
    '<span class="status-dot on"></span> ' + msg;
}

// ==================== Bindings ====================
async function loadBindings() {
  bindings = await nvidiaAPI.getBindings();
  renderBindTable();
}

function renderBindTable() {
  var tbody = document.querySelector('#bind-table tbody');
  tbody.innerHTML = '';
  for (var i = 0; i < bindings.length; i++) {
    var b = bindings[i];
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (b.enabled ? '●' : '○') + '</td>' +
      '<td>' + (b.programName || '-') + '</td>' +
      '<td style="font-size:11px;color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + b.programPath + '</td>' +
      '<td>' + b.presetName + '</td>' +
      '<td>' +
        '<button class="btn danger sm" onclick="removeBinding(' + i + ')">✕</button> ' +
        '<button class="btn sm" onclick="toggleBinding(' + i + ')">' + (b.enabled ? '停用' : '启用') + '</button>' +
      '</td>';
    tbody.appendChild(tr);
  }
}

async function addBinding() {
  var path = document.getElementById('bind-path').value.trim();
  var presetName = document.getElementById('bind-preset-select').value;
  if (!path || !presetName) { alert('请填写程序路径和选择预设'); return; }
  var programName = path.split('\\').pop().replace('.exe', '');
  bindings.push({
    programPath: path, programName: programName,
    presetName: presetName, enabled: true, wasActive: false,
  });
  bindings = await nvidiaAPI.saveBindings(bindings);
  renderBindTable();
  document.getElementById('bind-path').value = '';
  setStatus('已添加绑定: ' + programName + ' → ' + presetName);
}

async function removeBinding(i) {
  bindings.splice(i, 1);
  bindings = await nvidiaAPI.saveBindings(bindings);
  renderBindTable();
}

async function toggleBinding(i) {
  bindings[i].enabled = !bindings[i].enabled;
  bindings = await nvidiaAPI.saveBindings(bindings);
  renderBindTable();
}

async function toggleBindMonitor() {
  var enabled = document.getElementById('bind-enabled').checked;
  await nvidiaAPI.setBindEnabled(enabled);
}

async function browseExe() {
  var path = await nvidiaAPI.browseExe();
  if (path) document.getElementById('bind-path').value = path;
}

// ==================== Tab Switching ====================
function switchTab(tab) {
  var allTabs = document.querySelectorAll('.tab');
  var allContent = document.querySelectorAll('.tab-content');
  for (var i = 0; i < allTabs.length; i++) allTabs[i].classList.remove('active');
  for (var j = 0; j < allContent.length; j++) allContent[j].classList.remove('active');
  if (tab === 'color') {
    allTabs[0].classList.add('active');
    document.getElementById('tab-color').classList.add('active');
  } else if (tab === 'bind') {
    allTabs[1].classList.add('active');
    document.getElementById('tab-bind').classList.add('active');
  } else if (tab === 'settings') {
    allTabs[2].classList.add('active');
    document.getElementById('tab-settings').classList.add('active');
  }
}

// ==================== Boot ====================
init();
