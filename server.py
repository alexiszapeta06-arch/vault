#!/usr/bin/env python3
"""
Vault — Server v1.0
Flask :7070  |  UI tipo Scarlet/AltStore
Secciones: Import · My Apps · Settings
Sin dependencias externas de red — todo CSS/JS embebido.
"""

import os, sys, json, time, shutil, subprocess, threading, secrets
from pathlib import Path

try:
    from flask import Flask, request, jsonify, send_from_directory
except ImportError:
    subprocess.run([sys.executable,"-m","pip","install","flask","--quiet",
                    "--break-system-packages"], check=True)
    from flask import Flask, request, jsonify, send_from_directory

sys.path.insert(0, str(Path(__file__).parent))
from core import (
    all_apps, get_app, unregister,
    install_apk, delete_apk, APKError,
    install_zip, uninstall_linux, ZipError,
    VAULT_HOME, SHORTCUTS,
)

app  = Flask(__name__)
PORT = 7070
UPLOAD_TMP = VAULT_HOME / "tmp"
UPLOAD_TMP.mkdir(exist_ok=True)

# ═══════════════════════════════════════════════════════════════
# UI — Scarlet clone
# Paleta: negro carbón · índigo eléctrico · glassmorphism
# Tipografía: SF Pro / sistema  (cero CDN)
# ═══════════════════════════════════════════════════════════════

UI = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Vault</title>
<style>
/* ── Reset & variables ───────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#07070e;
  --surf:#0d0d1c;
  --card:rgba(255,255,255,0.057);
  --card-h:rgba(255,255,255,0.095);
  --bdr:rgba(255,255,255,0.082);
  --bdr-h:rgba(255,255,255,0.18);
  --accent:#4e6df5;
  --accent2:#7c3aed;
  --ag:linear-gradient(135deg,#4e6df5,#7c3aed);
  --green:#22c55e;
  --red:#f43f5e;
  --amber:#f59e0b;
  --t1:#eeeef8;
  --t2:rgba(238,238,248,.56);
  --t3:rgba(238,238,248,.30);
  --blur:blur(28px) saturate(170%);
  --rXL:22px;--rLG:16px;--rMD:12px;--rSM:8px;--rPill:999px;
  --font:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif;
  --mono:"SF Mono","Fira Code",monospace;
  --tab-h:72px;
}
html{font-size:16px;height:100%;-webkit-text-size-adjust:100%}
body{
  font-family:var(--font);background:var(--ink);color:var(--t1);
  min-height:100%;overflow-x:hidden;-webkit-font-smoothing:antialiased;
  padding-bottom:var(--tab-h);
}
/* Fondo radial animado */
body::before{
  content:'';position:fixed;inset:0;z-index:-1;
  background:
    radial-gradient(ellipse 65% 45% at 10%  0%,rgba(78,109,245,.16) 0%,transparent 60%),
    radial-gradient(ellipse 50% 40% at 90% 90%,rgba(124,58,237,.12) 0%,transparent 55%),
    var(--ink);
}

/* ── Status bar ──────────────────────────────────────────── */
.sbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 20px 8px;font-size:12px;font-weight:600;
  color:var(--t2);letter-spacing:.03em;
}
.sbar-logo{
  font-size:15px;font-weight:800;color:var(--t1);
  letter-spacing:-0.4px;
  background:var(--ag);-webkit-background-clip:text;
  -webkit-text-fill-color:transparent;background-clip:text;
}
.sbar-dot{
  width:7px;height:7px;border-radius:50%;
  background:var(--green);box-shadow:0 0 8px var(--green);
  animation:blink 2.5s ease-in-out infinite;
}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

/* ── Pages (tab routing) ─────────────────────────────────── */
.page{display:none;padding:0 0 16px}
.page.active{display:block;animation:fadeIn .22s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ── Section header ──────────────────────────────────────── */
.sec-head{padding:8px 20px 18px}
.sec-title{font-size:28px;font-weight:700;letter-spacing:-.5px}
.sec-sub{font-size:13px;color:var(--t2);margin-top:3px}

/* ── Tab bar ─────────────────────────────────────────────── */
.tabbar{
  position:fixed;bottom:0;left:0;right:0;z-index:300;
  display:flex;
  height:var(--tab-h);
  background:rgba(7,7,14,.90);
  border-top:1px solid var(--bdr);
  backdrop-filter:var(--blur);
  -webkit-backdrop-filter:var(--blur);
  padding-bottom:env(safe-area-inset-bottom,0px);
}
.tab{
  flex:1;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:4px;
  font-size:10px;font-weight:500;
  color:var(--t3);cursor:pointer;border:none;background:none;
  transition:color .18s;-webkit-tap-highlight-color:transparent;
}
.tab.on{color:var(--accent)}
.tab-ic{font-size:22px;line-height:1}

/* ── Cards ───────────────────────────────────────────────── */
.card{
  background:var(--card);border:1px solid var(--bdr);
  border-radius:var(--rXL);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  overflow:hidden;
}

/* ── App list row ────────────────────────────────────────── */
.app-list{margin:0 16px 16px}
.arow{
  display:flex;align-items:center;gap:14px;
  padding:13px 14px;
  border-bottom:1px solid var(--bdr);
  cursor:pointer;
  transition:background .15s;
  -webkit-tap-highlight-color:transparent;
}
.arow:last-child{border-bottom:none}
.arow:active{background:rgba(255,255,255,0.04)}
.arow-ic{
  width:52px;height:52px;border-radius:14px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;font-size:26px;
  background:var(--ag);box-shadow:0 4px 14px rgba(78,109,245,.35);
}
.arow-info{flex:1;min-width:0}
.arow-name{font-size:15px;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arow-meta{font-size:12px;color:var(--t2);margin-top:2px}
.arow-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.badge{
  font-size:10px;font-weight:700;letter-spacing:.05em;
  padding:3px 9px;border-radius:var(--rPill);
  text-transform:uppercase;
}
.b-apk {background:rgba(245,158,11,.18);color:var(--amber)}
.b-linux{background:rgba(78,109,245,.18);color:#8fa8ff}
.arow-action{
  width:28px;height:28px;border-radius:50%;
  border:none;background:rgba(255,255,255,.08);
  color:var(--t2);font-size:13px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s;
}
.arow-action:hover{background:rgba(255,69,58,.25);color:var(--red)}

/* ── Empty state ─────────────────────────────────────────── */
.empty{
  text-align:center;padding:60px 32px;
  color:var(--t3);font-size:14px;line-height:1.7;
}
.empty-ic{font-size:48px;display:block;margin-bottom:14px;opacity:.5}

/* ── Import zone ─────────────────────────────────────────── */
.import-wrap{padding:0 16px}
.drop-zone{
  border:2px dashed var(--bdr-h);
  border-radius:var(--rXL);
  padding:52px 24px;
  text-align:center;
  cursor:pointer;
  transition:border-color .2s, background .2s;
  position:relative;
}
.drop-zone.drag-over{
  border-color:var(--accent);
  background:rgba(78,109,245,.07);
}
.drop-zone input[type=file]{
  position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;
}
.drop-ic{font-size:52px;margin-bottom:16px;display:block;opacity:.7}
.drop-title{font-size:17px;font-weight:600;margin-bottom:6px}
.drop-sub{font-size:13px;color:var(--t2);line-height:1.6}
.drop-types{
  display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:14px;
}
.type-pill{
  font-size:11px;font-weight:700;padding:4px 10px;
  border-radius:var(--rPill);
  background:rgba(255,255,255,.08);color:var(--t2);
  border:1px solid var(--bdr);
}

/* ── Progress / status ───────────────────────────────────── */
.status-box{
  margin-top:16px;border-radius:var(--rLG);
  padding:14px 16px;font-size:13px;
  display:none;
}
.status-box.show{display:block;animation:fadeIn .2s ease}
.status-box.loading{background:rgba(78,109,245,.12);border:1px solid rgba(78,109,245,.25);color:#a5b4fc}
.status-box.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.status-box.err{background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.25);color:var(--red)}
.prog-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin-top:10px;overflow:hidden}
.prog-fill{height:100%;background:var(--ag);border-radius:2px;transition:width .4s ease}

/* ── Settings ────────────────────────────────────────────── */
.settings-list{margin:0 16px}
.set-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:15px 16px;border-bottom:1px solid var(--bdr);
  cursor:default;
}
.set-row:last-child{border-bottom:none}
.set-label{font-size:15px;font-weight:500}
.set-val{font-size:13px;color:var(--t2);font-family:var(--mono)}
.set-row .btn-sm{cursor:pointer}
.btn-sm{
  font-size:12px;font-weight:700;padding:6px 14px;
  border-radius:var(--rPill);border:none;cursor:pointer;
  background:rgba(255,255,255,.09);color:var(--t1);
  transition:background .15s;
}
.btn-sm:hover{background:rgba(255,255,255,.15)}
.btn-sm.danger{background:rgba(244,63,94,.18);color:var(--red)}

/* ── Bottom sheet modal ──────────────────────────────────── */
.sheet-backdrop{
  display:none;position:fixed;inset:0;z-index:400;
  background:rgba(0,0,0,.65);backdrop-filter:blur(10px);
  align-items:flex-end;
}
.sheet-backdrop.open{display:flex;animation:bdIn .2s ease}
@keyframes bdIn{from{opacity:0}to{opacity:1}}
.sheet{
  width:100%;max-width:520px;margin:0 auto;
  background:#111122;
  border-radius:24px 24px 0 0;
  padding:20px 22px 40px;
  animation:sheetUp .28s cubic-bezier(.32,.72,0,1);
}
@keyframes sheetUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
.sheet-handle{
  width:38px;height:4px;border-radius:2px;
  background:rgba(255,255,255,.18);margin:0 auto 20px;
}
.sheet-app-row{display:flex;align-items:center;gap:16px;margin-bottom:18px}
.sheet-ic{
  width:68px;height:68px;border-radius:18px;font-size:34px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  background:var(--ag);box-shadow:0 6px 20px rgba(78,109,245,.45);
}
.sheet-name{font-size:20px;font-weight:700}
.sheet-meta{font-size:13px;color:var(--t2);margin-top:3px}
.sheet-desc{font-size:14px;color:var(--t2);line-height:1.65;margin-bottom:20px}
.btn-full{
  display:flex;align-items:center;justify-content:center;gap:8px;
  width:100%;padding:15px;border:none;border-radius:var(--rLG);
  font-size:16px;font-weight:700;cursor:pointer;
  transition:transform .14s,opacity .14s;
}
.btn-full:active{transform:scale(.97);opacity:.85}
.btn-primary{background:var(--ag);color:#fff;box-shadow:0 4px 18px rgba(78,109,245,.4)}
.btn-danger{background:rgba(244,63,94,.18);color:var(--red);margin-top:10px}
.btn-cancel{background:rgba(255,255,255,.08);color:var(--t2);margin-top:10px}

/* ── Toast ───────────────────────────────────────────────── */
.toast{
  position:fixed;bottom:90px;left:50%;z-index:500;
  transform:translateX(-50%) translateY(12px);
  background:rgba(18,18,32,.97);border:1px solid var(--bdr-h);
  border-radius:var(--rLG);padding:12px 20px;
  font-size:14px;font-weight:500;
  backdrop-filter:var(--blur);
  opacity:0;pointer-events:none;white-space:nowrap;
  transition:opacity .22s,transform .22s;
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ── Scrollbar ───────────────────────────────────────────── */
::-webkit-scrollbar{width:0;height:0}
</style>
</head>
<body>

<!-- Status bar -->
<div class="sbar">
  <span class="sbar-logo">Vault</span>
  <span id="clock">—</span>
  <div class="sbar-dot"></div>
</div>

<!-- ══════════ PAGE: IMPORT ══════════ -->
<div class="page active" id="pg-import">
  <div class="sec-head">
    <div class="sec-title">Import</div>
    <div class="sec-sub">Selecciona un archivo para instalar</div>
  </div>

  <div class="import-wrap">
    <div class="drop-zone card" id="drop-zone">
      <input type="file" id="file-input"
             accept=".apk,.zip,.tar.gz,.tgz,.liberty"
             onchange="Vault.onFileSelected(this)">
      <span class="drop-ic">📥</span>
      <div class="drop-title">Arrastra o toca para seleccionar</div>
      <div class="drop-sub">Compatible con APKs de Android<br>y paquetes de apps Linux</div>
      <div class="drop-types">
        <span class="type-pill">.apk</span>
        <span class="type-pill">.zip</span>
        <span class="type-pill">.tar.gz</span>
        <span class="type-pill">.liberty</span>
      </div>
    </div>

    <div class="status-box" id="status-box">
      <span id="status-msg">Procesando...</span>
      <div class="prog-bar"><div class="prog-fill" id="prog-fill" style="width:0%"></div></div>
    </div>
  </div>
</div>

<!-- ══════════ PAGE: MY APPS ══════════ -->
<div class="page" id="pg-myapps">
  <div class="sec-head">
    <div class="sec-title">My Apps</div>
    <div class="sec-sub" id="apps-count">Cargando...</div>
  </div>
  <div class="app-list card" id="apps-list">
    <div class="empty">
      <span class="empty-ic">📭</span>
      Aún no hay apps instaladas.<br>Ve a <strong>Import</strong> para añadir una.
    </div>
  </div>
</div>

<!-- ══════════ PAGE: SETTINGS ══════════ -->
<div class="page" id="pg-settings">
  <div class="sec-head">
    <div class="sec-title">Settings</div>
    <div class="sec-sub">Vault v1.0.0</div>
  </div>
  <div class="settings-list card">
    <div class="set-row">
      <span class="set-label">Servidor</span>
      <span class="set-val" id="set-port">:7070</span>
    </div>
    <div class="set-row">
      <span class="set-label">Volumen</span>
      <span class="set-val">~/.vault/alpine-data</span>
    </div>
    <div class="set-row">
      <span class="set-label">Alpine</span>
      <span class="set-val" id="set-alpine">–</span>
    </div>
    <div class="set-row">
      <span class="set-label">Apps instaladas</span>
      <span class="set-val" id="set-total">–</span>
    </div>
    <div class="set-row">
      <span class="set-label">Shortcuts</span>
      <span class="set-val">~/.shortcuts/</span>
    </div>
    <div class="set-row">
      <span class="set-label">Sincronizar shortcuts</span>
      <button class="btn-sm" onclick="Vault.syncShortcuts()">Sincronizar</button>
    </div>
    <div class="set-row">
      <span class="set-label">Limpiar caché tmp</span>
      <button class="btn-sm danger" onclick="Vault.clearTmp()">Limpiar</button>
    </div>
  </div>
</div>

<!-- Tab bar -->
<div class="tabbar">
  <button class="tab on" data-tab="import" onclick="Vault.nav('import',this)">
    <span class="tab-ic">📥</span>Import
  </button>
  <button class="tab" data-tab="myapps" onclick="Vault.nav('myapps',this)">
    <span class="tab-ic">📱</span>My Apps
  </button>
  <button class="tab" data-tab="settings" onclick="Vault.nav('settings',this)">
    <span class="tab-ic">⚙️</span>Settings
  </button>
</div>

<!-- Bottom sheet (app detail) -->
<div class="sheet-backdrop" id="sheet-bd" onclick="if(event.target===this)Vault.closeSheet()">
  <div class="sheet">
    <div class="sheet-handle"></div>
    <div class="sheet-app-row">
      <div class="sheet-ic" id="sh-icon">📦</div>
      <div>
        <div class="sheet-name" id="sh-name">App</div>
        <div class="sheet-meta" id="sh-meta">v1.0 · apk</div>
      </div>
    </div>
    <div class="sheet-desc" id="sh-desc"></div>
    <button class="btn-full btn-primary" id="sh-action" onclick="Vault.sheetAction()">
      ▶ Abrir / Reinstalar
    </button>
    <button class="btn-full btn-danger" onclick="Vault.deleteApp()">
      🗑 Eliminar del Vault
    </button>
    <button class="btn-full btn-cancel" onclick="Vault.closeSheet()">
      Cancelar
    </button>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
const Vault = (() => {
  let apps = [];
  let currentApp = null;
  let uploadCtrl = null;

  // ── Clock ──────────────────────────────────────────────
  function tick() {
    const d = new Date();
    const t = String(d.getHours()).padStart(2,'0') + ':' +
              String(d.getMinutes()).padStart(2,'0');
    document.getElementById('clock').textContent = t;
  }
  tick(); setInterval(tick, 15000);

  // ── Navigation ─────────────────────────────────────────
  function nav(tab, el) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    document.getElementById('pg-' + (tab === 'import' ? 'import' :
                                     tab === 'myapps' ? 'myapps' : 'settings'))
      .classList.add('active');
    el.classList.add('on');
    if (tab === 'myapps')    loadApps();
    if (tab === 'settings')  loadSettings();
  }

  // ── Toast ──────────────────────────────────────────────
  function toast(msg, dur = 2800) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
  }

  // ── Status box ─────────────────────────────────────────
  function setStatus(msg, type = 'loading', pct = null) {
    const box  = document.getElementById('status-box');
    const msgEl = document.getElementById('status-msg');
    const fill  = document.getElementById('prog-fill');
    box.className  = 'status-box show ' + type;
    msgEl.textContent = msg;
    if (pct !== null) fill.style.width = pct + '%';
  }
  function hideStatus() {
    document.getElementById('status-box').className = 'status-box';
  }

  // ── Drag & drop ─────────────────────────────────────────
  const dz = document.getElementById('drop-zone');
  ['dragenter','dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag-over'); })
  );
  ['dragleave','drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag-over'); })
  );
  dz.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });

  // ── File selected ───────────────────────────────────────
  function onFileSelected(input) {
    if (input.files[0]) uploadFile(input.files[0]);
  }

  // ── Upload ──────────────────────────────────────────────
  async function uploadFile(file) {
    setStatus(`Subiendo ${file.name}…`, 'loading', 10);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('filename', file.name);

    try {
      setStatus('Analizando archivo…', 'loading', 35);
      const r = await fetch('/api/install', { method: 'POST', body: fd });
      setStatus('Instalando…', 'loading', 70);
      const d = await r.json();

      if (d.success) {
        setStatus('✓ ' + d.message, 'ok', 100);
        toast('✓ ' + d.name + ' instalada');
        setTimeout(hideStatus, 4000);
        // Reset file input
        document.getElementById('file-input').value = '';
      } else {
        setStatus('✗ ' + (d.error || 'Error desconocido'), 'err', 100);
      }
    } catch (e) {
      setStatus('✗ Error de conexión: ' + e.message, 'err', 100);
    }
  }

  // ── Load apps ───────────────────────────────────────────
  async function loadApps() {
    try {
      const r = await fetch('/api/apps');
      const d = await r.json();
      apps = d.apps || [];
      renderApps();
      document.getElementById('apps-count').textContent =
        apps.length === 0 ? 'Sin apps instaladas' :
        apps.length === 1 ? '1 app instalada' :
        apps.length + ' apps instaladas';
    } catch(e) {
      console.error('loadApps:', e);
    }
  }

  function renderApps() {
    const el = document.getElementById('apps-list');
    if (!apps.length) {
      el.innerHTML = `<div class="empty">
        <span class="empty-ic">📭</span>
        Aún no hay apps instaladas.<br>Ve a <strong>Import</strong> para añadir una.
      </div>`;
      return;
    }
    el.innerHTML = apps.map(a => `
      <div class="arow" onclick="Vault.openSheet('${a.id}')">
        <div class="arow-ic">${a.icon || '📦'}</div>
        <div class="arow-info">
          <div class="arow-name">${a.name}</div>
          <div class="arow-meta">v${a.version || '1.0'} · ${a.category || a.type}</div>
        </div>
        <div class="arow-right">
          <span class="badge ${a.type === 'apk' ? 'b-apk' : 'b-linux'}">
            ${a.type === 'apk' ? 'APK' : 'Linux'}
          </span>
          <button class="arow-action" title="Eliminar"
                  onclick="event.stopPropagation();Vault.quickDelete('${a.id}','${a.name}')">
            ✕
          </button>
        </div>
      </div>`).join('');
  }

  // ── Bottom sheet ─────────────────────────────────────────
  function openSheet(id) {
    currentApp = apps.find(a => a.id === id);
    if (!currentApp) return;
    document.getElementById('sh-icon').textContent = currentApp.icon || '📦';
    document.getElementById('sh-name').textContent = currentApp.name;
    document.getElementById('sh-meta').textContent =
      `v${currentApp.version || '1.0'} · ${currentApp.type === 'apk' ? 'APK Android' : 'App Linux'}`;
    document.getElementById('sh-desc').textContent =
      currentApp.description || (currentApp.type === 'apk'
        ? 'APK de Android. Toca "Abrir instalador" para instalar en el sistema.'
        : 'App Linux instalada en Alpine. Usa el shortcut en tu pantalla para abrirla.');
    document.getElementById('sh-action').textContent =
      currentApp.type === 'apk' ? '📲 Abrir instalador Android' : '▶ Abrir shortcut';
    document.getElementById('sheet-bd').classList.add('open');
  }

  function closeSheet() {
    document.getElementById('sheet-bd').classList.remove('open');
    currentApp = null;
  }

  async function sheetAction() {
    if (!currentApp) return;
    if (currentApp.type === 'apk') {
      const r = await fetch(`/api/apps/${currentApp.id}/reinstall`, {method:'POST'});
      const d = await r.json();
      toast(d.message || 'Instalador abierto');
    } else {
      toast('Usa el shortcut "' + currentApp.name + '" en Termux:Widget');
    }
    closeSheet();
  }

  async function deleteApp() {
    if (!currentApp) return;
    const r = await fetch(`/api/apps/${currentApp.id}`, {method:'DELETE'});
    const d = await r.json();
    toast(d.message || 'Eliminado');
    closeSheet();
    loadApps();
  }

  async function quickDelete(id, name) {
    if (!confirm(`¿Eliminar "${name}" del Vault?`)) return;
    const r = await fetch(`/api/apps/${id}`, {method:'DELETE'});
    const d = await r.json();
    toast(d.message || 'Eliminado');
    loadApps();
  }

  // ── Settings ─────────────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch('/api/status');
      const d = await r.json();
      document.getElementById('set-alpine').textContent = d.alpine || '–';
      document.getElementById('set-total').textContent  = d.total  || '0';
      document.getElementById('set-port').textContent   = ':' + d.port;
    } catch(e) {}
  }

  async function syncShortcuts() {
    const r = await fetch('/api/sync-shortcuts', {method:'POST'});
    const d = await r.json();
    toast(d.message || 'Shortcuts sincronizados');
  }

  async function clearTmp() {
    const r = await fetch('/api/clear-tmp', {method:'POST'});
    const d = await r.json();
    toast(d.message || 'Caché limpiada');
  }

  // Init: cargar apps al iniciar
  document.addEventListener('DOMContentLoaded', loadApps);

  return { nav, onFileSelected, openSheet, closeSheet,
           sheetAction, deleteApp, quickDelete,
           syncShortcuts, clearTmp };
})();
</script>
</body>
</html>"""

# ═══════════════════════════════════════════════════════════════
# API ROUTES
# ═══════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return UI

@app.route('/api/apps')
def api_apps():
    return jsonify({'apps': all_apps(), 'total': len(all_apps())})

@app.route('/api/install', methods=['POST'])
def api_install():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No se recibió archivo'}), 400

    f            = request.files['file']
    original     = request.form.get('filename', f.filename)
    tmp_path     = UPLOAD_TMP / original
    f.save(str(tmp_path))

    name_lower = original.lower()

    try:
        if name_lower.endswith('.apk'):
            result = install_apk(tmp_path, original)
        elif any(name_lower.endswith(x) for x in
                 ('.zip', '.tar.gz', '.tgz', '.liberty')):
            result = install_zip(tmp_path, original)
        else:
            return jsonify({'success': False,
                            'error': f'Formato no soportado: {original}'}), 400

        # Sincronizar shortcuts al host
        _sync_shortcuts()
        return jsonify(result)

    except (APKError, ZipError) as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': f'Error interno: {e}'}), 500
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

@app.route('/api/apps/<app_id>/reinstall', methods=['POST'])
def api_reinstall(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({'error': 'App no encontrada'}), 404
    try:
        if app_data['type'] == 'apk':
            r = reinstall_apk_by_id(app_id, app_data)
            return jsonify(r)
        else:
            return jsonify({'message': f'Usa el shortcut "{app_data["name"]}" en Termux:Widget'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def reinstall_apk_by_id(app_id, app_data):
    from core import install_apk as _inst
    local = Path(app_data.get('local_path', ''))
    if not local.exists():
        return {'error': 'APK ya no está en el vault'}
    return _inst(local, app_data['filename'])

@app.route('/api/apps/<app_id>', methods=['DELETE'])
def api_delete(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({'error': 'App no encontrada'}), 404
    try:
        if app_data['type'] == 'apk':
            result = delete_apk(app_id)
        else:
            result = uninstall_linux(app_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/status')
def api_status():
    apps = all_apps()
    # Detectar versión de Alpine
    alpine_ver = '–'
    try:
        out = Path('/etc/alpine-release').read_text().strip()
        alpine_ver = 'Alpine ' + out
    except Exception:
        pass
    return jsonify({
        'status':  'ok',
        'port':    PORT,
        'total':   len(apps),
        'alpine':  alpine_ver,
        'uptime':  int(time.time()),
    })

@app.route('/api/sync-shortcuts', methods=['POST'])
def api_sync():
    n = _sync_shortcuts()
    return jsonify({'message': f'{n} shortcuts sincronizados en ~/.shortcuts/'})

@app.route('/api/clear-tmp', methods=['POST'])
def api_clear_tmp():
    removed = 0
    for f in UPLOAD_TMP.iterdir():
        try:
            f.unlink()
            removed += 1
        except Exception:
            pass
    return jsonify({'message': f'Caché limpiada ({removed} archivos)'})

# ─── Helpers ─────────────────────────────────────────────────

def _sync_shortcuts() -> int:
    """
    Copia los shortcuts del volumen Alpine (/home/vault/shortcuts/)
    al directorio de Termux:Widget (~/.shortcuts/) en el host.
    Funciona porque el volumen Alpine-data está bind-montado
    en $HOME/.vault/alpine-data/, accesible desde el host.
    """
    host_shortcuts = Path.home() / ".shortcuts"
    host_shortcuts.mkdir(exist_ok=True)
    n = 0
    for sc in SHORTCUTS.iterdir():
        if sc.suffix == '.sh':
            dst = host_shortcuts / sc.name
            try:
                shutil.copy2(sc, dst)
                dst.chmod(dst.stat().st_mode | 0o111)
                n += 1
            except Exception:
                pass
    return n

# ─── Main ─────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f"""
  ╔═══════════════════════════════╗
  ║  Vault v1.0  —  :{ PORT }        ║
  ║  http://localhost:{ PORT }       ║
  ╚═══════════════════════════════╝
""")
    # Sincronizar shortcuts al arrancar
    _sync_shortcuts()
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
