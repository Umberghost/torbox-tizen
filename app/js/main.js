/* main.js — registro de pantallas, router, barra de secciones, despacho de teclas y arranque. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

/* ================= Registro de pantallas ================= */
var screens = App.screens.all();   // id → def (registro en core.js)
App.bus.on("screens:change", function(){ if(booted) renderNav(); });

/* ================= Router ================= */
var mainEl;
var current = null;       // {id, params}
var stack = [];           // historial dentro de una sección
var zone = "content";     // "content" | "header"
var navIndex = 0;
var booted = false;

function screenEl(id){
  var el = document.getElementById("screen-" + id);
  if(!el){
    el = document.createElement("section");
    el.className = "screen";
    el.id = "screen-" + id;
    mainEl.appendChild(el);
  }
  return el;
}

function activate(id, params){
  var def = screens[id];
  if(!def){ App.hint(App.t("main.noScreen", {id: id})); return; }
  if(current){
    var prev = screens[current.id];
    var prevEl = document.getElementById("screen-" + current.id);
    if(prev && prev.hide){ try{ prev.hide(); }catch(e){ console.error(e); } }
    if(prevEl) prevEl.classList.remove("on");
  }
  var el = screenEl(id);
  if(!def._mounted){
    def._mounted = true;
    if(def.mount){ try{ def.mount(el); }catch(e){ console.error("[mount " + id + "]", e); } }
  }
  el.classList.add("on");
  current = { id: id, params: params || {} };
  zone = "content";
  syncNav();
  if(def.show){
    try{ def.show(params || {}, el); }catch(e){
      console.error("[show " + id + "]", e);
      App.ui.error(el, App.t("main.screenError"), e.message);
    }
  }
  App.setHintDefault(def.hint || DEFAULT_HINT);
  App.bus.emit("screen:show", { id: id, params: params || {} });
}

App.go = function(id, params){
  if(current) stack.push(current);
  activate(id, params);
};
App.replace = function(id, params){ activate(id, params); };
App.back = function(){
  if(!stack.length) return false;
  var prev = stack.pop();
  activate(prev.id, Object.assign({}, prev.params, { _back: true }));
  return true;
};
/* Cambiar de sección desde la barra: limpia el historial */
App.section = function(id, params){
  stack = [];
  activate(id, params);
};
App.current = function(){ return current ? current.id : null; };

/* ================= Rail lateral (rediseño 2.0) =================
 * Rail vertical con un icono SVG por sección. "zone header" = el foco está en el rail
 * (se mantiene el nombre por compatibilidad: body.zone-header, App.focusHeader()). */
var DEFAULT_HINT = "";  // se calcula con App.t al arrancar
var railEl, headerEl, hintbarEl, statusEl, clockEl;
var RAIL_ORDER = ["home", "search", "library", "live", "downloads"];
var RAIL_HIDDEN = ["continue", "settings"];   // 'continue' sale del rail; settings va abajo
function ico(p, w){ return '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
var ICONS = {
  home: ico('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', 2.2),
  search: ico('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  library: ico('<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="M17.5 5l3.5 14"/>'),
  live: ico('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/>'),
  downloads: ico('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  settings: ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  other: ico('<circle cx="12" cy="12" r="8"/>')
};

/* Entradas del rail: [{id, label, icon}] en orden de navegación (arriba→abajo; ajustes al final) */
function railEntries(){
  var list = App.screens.navList().filter(function(s){ return RAIL_HIDDEN.indexOf(s.id) < 0; });
  list.sort(function(a, b){
    var ia = RAIL_ORDER.indexOf(a.id), ib = RAIL_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  var out = list.map(function(s){ return { id: s.id, label: s.label || s.id, icon: ICONS[s.id] || ICONS.other }; });
  if(screens.settings && screens.settings.nav){
    out.push({ id: "settings", label: screens.settings.label || "settings", icon: ICONS.settings, bottom: true });
  }
  return out;
}
function profileInitial(){
  try{
    if(!App.profile) return "";
    var cur = App.profile.current(), l = App.profile.list(), name = "";
    l.forEach(function(p){ if(p.id === cur) name = p.name; });
    return (name || "?").charAt(0).toUpperCase();
  }catch(e){ return ""; }
}
var railList = [];
function renderNav(){
  if(!railEl) return;
  railList = railEntries();
  var html = '<div class="rail-brand"><svg width="44" height="44" viewBox="0 0 104 104" role="img" aria-label="Faro"><rect x="4" y="4" width="96" height="96" rx="28" fill="#1C2430"/><path d="M33 23h40v12H45v10h22v12H45v24H33z" fill="#F2F5F8"/><path d="M57 63l16 9-16 9z" fill="var(--accent)"/></svg></div>';
  var bottomDone = false;
  railList.forEach(function(s){
    if(s.bottom && !bottomDone){ html += '<div class="rail-spacer"></div>'; bottomDone = true; }
    html += '<div class="rail-item" data-id="' + App.esc(s.id) + '" aria-label="' + App.esc(s.label) + '">' + s.icon +
      '<span class="rail-tip">' + App.esc(s.label) + '</span></div>';
  });
  if(!bottomDone) html += '<div class="rail-spacer"></div>';
  var ini = profileInitial();
  if(ini) html += '<div class="rail-avatar" aria-hidden="true">' + App.esc(ini) + '</div>';
  railEl.innerHTML = html;
  syncNav();
}
function activeSectionId(){
  var activeId = current ? current.id : null;
  var sectionId = activeId;
  if(activeId && screens[activeId] && !screens[activeId].nav){
    for(var i = stack.length - 1; i >= 0; i--){
      if(screens[stack[i].id] && screens[stack[i].id].nav){ sectionId = stack[i].id; break; }
    }
    if(screens[activeId].section) sectionId = screens[activeId].section;
  }
  if(sectionId === "continue") sectionId = "home";   // 'continue' vive en Inicio
  return sectionId;
}
function syncNav(){
  if(!railEl) return;
  var items = railEl.querySelectorAll(".rail-item");
  var sectionId = activeSectionId();
  for(var j = 0; j < items.length; j++){
    var t = items[j];
    t.classList.toggle("active", t.getAttribute("data-id") === sectionId);
    t.classList.toggle("focused", zone === "header" && j === navIndex);
  }
  document.body.classList.toggle("zone-header", zone === "header");
}

App.focusHeader = function(){
  if(!railEl) return;
  if(!railList.length) railList = railEntries();
  var sec = activeSectionId();
  navIndex = 0;
  railList.forEach(function(s, i){ if(s.id === sec) navIndex = i; });
  zone = "header";
  var def = current && screens[current.id];
  if(def && def.blur){ try{ def.blur(); }catch(e){} }
  syncNav();
};
App.focusContent = function(){ focusContent(); };
function focusContent(){
  zone = "content";
  syncNav();
  var def = current && screens[current.id];
  if(def && def.focus){ try{ def.focus(); }catch(e){ console.error(e); } }
}

/* Mover por el rail cambia de sección con un pequeño retardo (vista previa) */
var railTimer = null;
function railApply(){
  clearTimeout(railTimer); railTimer = null;
  var t = railList[navIndex];
  if(t && t.id !== activeSectionId()){
    App.section(t.id);
    zone = "header";
    var def = screens[t.id];
    if(def && def.blur){ try{ def.blur(); }catch(e){} }
    syncNav();
  }
}
function headerKey(k){
  if(k === K.UP || k === K.DOWN){
    if(!railList.length) return;
    navIndex = Math.max(0, Math.min(railList.length - 1, navIndex + (k === K.DOWN ? 1 : -1)));
    syncNav();
    clearTimeout(railTimer);
    railTimer = setTimeout(railApply, 250);
    return;
  }
  if(k === K.RIGHT || k === K.OK){
    railApply();
    focusContent();
    return;
  }
  if(App.isBack(k)){
    App.ui.confirm(App.t("main.exitTitle"), "", App.t("main.exit"), App.t("ui.cancel")).then(function(yes){
      if(!yes) return;
      try{ tizen.application.getCurrentApplication().exit(); }
      catch(e){ try{ window.history.back(); }catch(e2){} }
    });
  }
}

/* ================= Cabecera mínima + barra de pista ================= */
function pad2(n){ return n < 10 ? "0" + n : "" + n; }
function updateStatus(){
  if(!statusEl) return;
  var ok = false;
  try{ ok = !!(App.torbox && App.torbox.hasToken && App.torbox.hasToken()); }catch(e){}
  statusEl.className = "hdr-status" + (ok ? " ok" : "");
  statusEl.innerHTML = '<i></i><span>' + App.esc(App.t(ok ? "shell.connected" : "shell.disconnected")) + '</span>';
  if(clockEl){ var d = new Date(); clockEl.textContent = pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
}
function buildShell(){
  var app = document.getElementById("app");
  headerEl = app.querySelector("header");
  var hintEl = document.getElementById("hint");
  headerEl.innerHTML = '<div id="headerLeft"></div><div class="spacer"></div>' +
    '<div class="hdr-status" id="hdrStatus"></div><div class="hdr-clock num" id="hdrClock"></div>';
  statusEl = document.getElementById("hdrStatus");
  clockEl = document.getElementById("hdrClock");
  railEl = document.createElement("nav");
  railEl.id = "rail";
  railEl.setAttribute("aria-label", "Sections");
  app.insertBefore(railEl, app.firstChild);
  hintbarEl = document.createElement("div");
  hintbarEl.id = "hintbar";
  if(!hintEl){ hintEl = document.createElement("div"); hintEl.id = "hint"; hintEl.className = "hint"; }
  hintbarEl.appendChild(hintEl);
  var pill = document.createElement("div");
  pill.className = "hint-pill";
  /* PC/móvil: en vez de "Mantén OK" (mando de TV) se indica el clic derecho */
  pill.innerHTML = '<b>' + App.esc(App.t(App.isTizen() ? "shell.holdOk" : "shell.rightClick")) + '</b><span>' + App.esc(App.t("shell.moreOptions")) + '</span>';
  hintbarEl.appendChild(pill);
  app.appendChild(hintbarEl);
  updateStatus();
  setInterval(updateStatus, 30000);
  App.bus.on("settings:change", function(c){ if(!c || !c.key || c.key === "torboxToken") updateStatus(); });
}
/* La píldora "Mantén OK" ya está en la barra: se quita del texto del hint */
(function(){
  var orig = App.setHintDefault;
  App.setHintDefault = function(msg){
    /* Fuera de la TV los consejos de mando (◄ ▲▼ OK) no sirven: consejo único de ratón/teclado */
    if(!App.isTizen() && msg) return orig(App.t("shell.deskHint"));
    orig(String(msg || "").replace(/\s*[·•]\s*(Hold OK|Mantén OK)[^·•]*$/i, ""));
  };
  /* Con la barra de pista oculta (móvil/táctil) los avisos se mostrarían en ningún sitio: pasan a toast */
  if(!App.isTizen()){
    var origHint = App.hint;
    App.hint = function(msg, ms){
      var hb = document.getElementById("hintbar");
      if(hb && window.getComputedStyle(hb).display === "none" && msg && App.ui && App.ui.toast) App.ui.toast(msg, ms || 3000);
      else origHint(msg, ms);
    };
  }
})();

/* ================= Menú contextual (A1) =================
 * Se abre con OK mantenido (>= 600 ms), la tecla TOOLS (10135) o Menu (10133 / tecla de contexto en PC).
 * Cada pantalla puede definir actions() → [{label, run}]; si no, menú global.
 */
var HOLD_MS = 600;
function globalActions(){
  var a = [];
  if(screens.search) a.push({ label: App.t("main.act.search"), run: function(){ App.section("search"); } });
  if(screens.settings) a.push({ label: App.t("main.act.settings"), run: function(){ App.section("settings"); } });
  a.push({ label: App.t("main.act.reload"), run: function(){ location.reload(); } });
  return a;
}
App.openMenu = function(){
  if(App.ui.isModalOpen() || (App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen())) return;
  var def = current && screens[current.id], acts = null;
  if(zone === "content" && def && typeof def.actions === "function"){
    try{ acts = def.actions(); }catch(err){ console.error("[actions " + current.id + "]", err); }
  }
  if(!Array.isArray(acts) || !acts.length) acts = globalActions();
  acts = acts.filter(function(a){ return a && a.label; });
  App.ui.menu(App.t("main.options"), acts.map(function(a, i){ return { label: a.label, value: i, selected: !!a.selected }; })).then(function(i){
    if(i === null || i === undefined || !acts[i] || typeof acts[i].run !== "function") return;
    try{
      var r = acts[i].run();
      if(r && r.catch) r.catch(function(err){ console.error("[action]", err); });
    }catch(err){ console.error("[action]", err); }
  });
};

/* OK mantenido: el OK normal se retrasa hasta soltar la tecla; solo para teclas reales (isTrusted) en la
 * zona de contenido, sin modal/teclado/reproductor/input. */
var okHold = null;   // {t, ev, fired}
function canHoldOK(){
  if(App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen()) return false;
  if(App.ui.isModalOpen()) return false;
  if(App.player && App.player.isActive && App.player.isActive()) return false;
  if(zone !== "content") return false;
  var ae = document.activeElement;
  if(ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return false;
  return !(current && (current.id === "setup" || current.id === "profiles"));
}
function fireHold(){
  okHold.fired = true;
  App.openMenu();
}
function onKeyDown(e){
  if(e.keyCode === K.OK && e.isTrusted === true){
    if(okHold && Date.now() - okHold.t > 4000) okHold = null;   // keyup perdido
    if(okHold){                                   // tecla mantenida: repetición de keydown
      e.preventDefault(); e.stopPropagation();
      if(!okHold.fired && Date.now() - okHold.t >= HOLD_MS) fireHold();
      return;
    }
    if(canHoldOK()){
      okHold = { t: Date.now(), ev: e, fired: false };
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }
  dispatchKey(e);
}
function onKeyUp(e){
  if(e.keyCode !== K.OK || !okHold) return;
  var h = okHold; okHold = null;
  e.preventDefault(); e.stopPropagation();
  if(h.fired) return;
  if(Date.now() - h.t >= HOLD_MS){ okHold = h; fireHold(); okHold = null; return; }   // keyup tardío
  dispatchKey(h.ev);
}

/* ================= Teclado ================= */
function dispatchKey(e){
  var k = e.keyCode;

  // 1) Teclado en pantalla
  if(App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen()){
    if(App.ui.keyboard.onKey(k, e) !== false) e.preventDefault();
    return;
  }
  /* PC/móvil con teclado: R/G/Y/B = botones de color, I = Info, M = menú (sin modificadores ni campo de texto) */
  if(!App.isTizen() && !(e.ctrlKey || e.metaKey || e.altKey)){
    var ae0 = document.activeElement;
    if(!(ae0 && (ae0.tagName === "INPUT" || ae0.tagName === "TEXTAREA"))){
      var PCK = { 82: K.RED, 71: K.GREEN, 89: K.YELLOW, 66: K.BLUE, 73: K.INFO, 77: K.MENU };
      if(PCK[k]) k = PCK[k];
    }
  }
  // 2) Modal
  if(App.ui.isModalOpen()){
    App.ui.modalKey(k, e); e.preventDefault(); return;
  }
  // 3) Reproductor
  if(App.player && App.player.isActive && App.player.isActive()){
    if(App.player.onKey(k, e) !== false) e.preventDefault();
    return;
  }
  // 3b) Aviso "ya está listo" de App.watch (no modal: solo se queda OK/Atrás si lo gestiona)
  if(App.watch && App.watch.onKey){
    try{ if(App.watch.onKey(k, e) === true){ e.preventDefault(); return; } }catch(err){ console.error(err); }
  }
  // 3c) Menú contextual: TOOLS / Menu
  if(k === K.TOOLS || k === K.MENU || k === K.CONTEXT){ e.preventDefault(); App.openMenu(); return; }
  // 4) Input nativo con foco: dejar escribir, pero no tragarse flechas verticales
  var ae = document.activeElement;
  var typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");

  // 5) Cabecera
  if(zone === "header"){ headerKey(k); e.preventDefault(); return; }

  // 6) Pantalla actual
  var def = current && screens[current.id];
  var handled = false;
  if(def && def.onKey){
    try{ handled = def.onKey(k, e) === true; }catch(err){ console.error("[onKey " + current.id + "]", err); }
  }
  if(handled){ e.preventDefault(); return; }
  if(typing && k !== K.UP && k !== K.DOWN && !App.isBack(k) && k !== K.OK) return;
  if(typing && k === K.BACKSPACE) return;

  if(App.isBack(k)){
    e.preventDefault();
    if(!App.back()) App.focusHeader();
    return;
  }
  if(k === K.LEFT){ e.preventDefault(); App.focusHeader(); return; }   // borde izquierdo → rail
  if(k === K.UP || k === K.DOWN || k === K.RIGHT){ e.preventDefault(); return; }
  // Atajos de color globales
  if(k === K.BLUE && screens.settings){ e.preventDefault(); App.section("settings"); return; }
  if(k === K.YELLOW && screens.search){ e.preventDefault(); App.section("search"); return; }
}

/* ================= Pantalla de configuración inicial ================= */
App.screens.register({
  id: "setup", label: "Setup", nav: false,
  get hint(){ return App.t("setup.hint"); },
  /* Foco: 0 = selector de servicio (◄► cambia), 1 = campo de clave, 2 = botón guardar */
  mount: function(el){
    el.innerHTML =
      '<div class="center"><div class="box setup-box">' +
        '<div class="setup-prov"><span class="muted" id="provLbl"></span>' +
          '<div class="chip focusable" id="provBtn"></div></div>' +
        '<h2 id="setupTitle"></h2>' +
        '<p id="setupText"></p>' +
        '<input id="tokenInput" class="input focusable" type="text" autocomplete="off" spellcheck="false">' +
        '<div class="btn focusable" id="saveBtn">' + App.esc(App.t("setup.save")) + '</div>' +
        '<div class="setup-lang muted">' + App.esc(App.t("setup.langHint")) + '</div>' +
      '</div></div>';
    var input = el.querySelector("#tokenInput");
    input.addEventListener("keydown", function(ev){
      if(ev.keyCode === 13){ ev.preventDefault(); ev.stopPropagation(); save(); }
    });
    var self = this;
    el.querySelector("#provBtn").addEventListener("click", function(){ self.toggleProv(); });
    this._el = el;
  },
  prov: function(){ return App.settings.get("debridProvider") === "realdebrid" ? "realdebrid" : "torbox"; },
  toggleProv: function(){
    var input = this._el.querySelector("#tokenInput");
    // guardar lo escrito en el servicio actual antes de cambiar
    App.settings.set(this.prov() === "realdebrid" ? "rdToken" : "torboxToken", input.value.trim());
    App.settings.set("debridProvider", this.prov() === "realdebrid" ? "torbox" : "realdebrid");
    this.texts();
  },
  texts: function(){
    var el = this._el, rdMode = this.prov() === "realdebrid";
    el.querySelector("#provLbl").textContent = App.t("setup.provider");
    el.querySelector("#provBtn").textContent = "◄  " + (rdMode ? "Real-Debrid" : "TorBox") + "  ►";
    el.querySelector("#setupTitle").textContent = App.t(rdMode ? "setup.rd.title" : "setup.title");
    el.querySelector("#setupText").textContent = App.t(rdMode ? "setup.rd.text" : "setup.text");
    var input = el.querySelector("#tokenInput");
    input.placeholder = App.t(rdMode ? "setup.rd.placeholder" : "setup.placeholder");
    input.value = App.settings.get(rdMode ? "rdToken" : "torboxToken") || "";
  },
  show: function(){ this.texts(); this._f = 1; this.paint(); },
  paint: function(){
    var el = this._el, input = el.querySelector("#tokenInput");
    el.querySelector("#provBtn").classList.toggle("focused", this._f === 0);
    input.classList.toggle("focused", this._f === 1);
    el.querySelector("#saveBtn").classList.toggle("focused", this._f === 2);
    if(this._f === 1) input.focus(); else input.blur();
  },
  focus: function(){ this.paint(); },
  onKey: function(k){
    if(k === K.DOWN){ this._f = Math.min(2, this._f + 1); this.paint(); return true; }
    if(k === K.UP){ this._f = Math.max(0, this._f - 1); this.paint(); return true; }
    if(this._f === 0 && (k === K.LEFT || k === K.RIGHT || k === K.OK)){ this.toggleProv(); return true; }
    if(k === K.OK && this._f === 2){ save(); return true; }
    if(App.isBack(k)){
      if(this._f === 1 && k === K.BACKSPACE) return false;
      if(App.torbox.hasToken()){ App.section(firstSection()); }
      return true;
    }
    return this._f === 1 && (k === K.LEFT || k === K.RIGHT); // dejar mover el cursor
  }
});

function save(){
  var v = document.getElementById("tokenInput").value.trim();
  if(!v){ App.hint(App.t("setup.needKey")); return; }
  App.settings.set(App.settings.get("debridProvider") === "realdebrid" ? "rdToken" : "torboxToken", v);
  App.torbox.invalidate();
  document.getElementById("tokenInput").blur();
  App.section(firstSection());
}
App.openSetup = function(){ App.section("setup"); };

function firstSection(){
  var list = App.screens.navList();
  if(screens.home) return "home";
  return screens.library ? "library" : (list[0] ? list[0].id : "setup");
}

/* ================= Selector de perfil al arrancar (TODO 6) ================= */
var pick = { el: null, grid: null, list: [] };
App.screens.register({
  id: "profiles", label: "Profiles", nav: false,
  get hint(){ return App.t("profile.pickHint"); },
  mount: function(el){ pick.el = el; },
  show: function(){
    pick.list = App.profile.list();
    pick.el.innerHTML = '<div class="center"><div class="box"><h2>' + App.esc(App.t("profile.pickTitle")) + '</h2>' +
      pick.list.map(function(p, i){
        return '<div class="row focusable" data-i="' + i + '"><div class="title">' + App.esc(p.name) + '</div>' +
          (p.hasPin ? '<span class="badge">PIN</span>' : '') + '</div>';
      }).join("") + '</div></div>';
    var cur = App.profile.current(), idx = 0;
    pick.list.forEach(function(p, i){ if(p.id === cur) idx = i; });
    pick.grid = new App.ui.FocusGrid(pick.el, { onSelect: function(i){ choose(pick.list[i]); }, onEdge: function(){ return true; } });
    pick.grid.focus(idx, true);
  },
  focus: function(){ if(pick.grid) pick.grid.focus(pick.grid.index, true); },
  onKey: function(k){
    if(App.isBack(k)) return true;
    return pick.grid ? pick.grid.handleKey(k) : false;
  }
});
function choose(p, pin){
  var r = App.profile.choose(p.id, pin);
  if(r === "pin"){
    if(pin !== undefined) App.ui.toast(App.t("profile.wrongPin"));
    App.ui.keyboard.open({ title: App.t("profile.enterPin", {name: p.name}), value: "", secret: true,
      onDone: function(v){ choose(p, String(v || "").trim()); } });
    return;
  }
  if(r === "same") startApp();
}
function startApp(){
  if(App.torbox.hasToken()) App.section(firstSection());
  else App.section("setup");
}

/* ================= Modo móvil (TODO 13) =================
 * En el móvil (Worker / navegador) el viewport pasa a device-width y body.mobile activa el CSS compacto.
 * En la TV (Tizen) o en pantallas anchas todo queda como estaba (viewport 1920).
 */
function isPhoneDevice(){
  if(App.isTizen()) return false;
  var sw = Math.min(window.screen ? screen.width : 9999, window.screen ? screen.height : 9999);
  return sw < 700 || /Android.*Mobile|iPhone|iPod|Mobile Safari/i.test(navigator.userAgent);
}
/* Clases de body para el diseño adaptable (fuera de la TV nunca cambian el aspecto en Tizen):
 *   mobile   → ventana estrecha (<1000 px) o vertical
 *   portrait → vertical
 *   touch    → pantalla táctil como puntero principal (móvil/tablet)
 *   desk     → navegador de escritorio con ratón y ventana ancha (no TV, no mobile) */
function applyMobile(){
  var tv = App.isTizen();
  var narrow = !tv && (window.innerWidth < 1000 || window.innerHeight > window.innerWidth);
  var coarse = false;
  try{ coarse = window.matchMedia("(pointer: coarse)").matches; }catch(e){}
  var cl = document.body.classList;
  cl.toggle("mobile", narrow);
  cl.toggle("portrait", !tv && window.innerHeight > window.innerWidth);
  cl.toggle("touch", !tv && coarse);
  cl.toggle("desk", !tv && !narrow && !coarse);
}
function initMobile(){
  if(isPhoneDevice()){
    var m = document.querySelector('meta[name="viewport"]');
    if(!m){ m = document.createElement("meta"); m.name = "viewport"; document.head.appendChild(m); }
    m.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
  }
  applyMobile();
  window.addEventListener("resize", App.debounce(applyMobile, 150));
  window.addEventListener("orientationchange", function(){ setTimeout(applyMobile, 200); });
}

/* ================= Entrada PC / táctil (solo fuera de la TV) =================
 * - Pulsación larga (550 ms) sobre un .focusable = enfocar + menú de opciones (como mantener OK).
 * - Atrás del navegador/Android = App.back() (una entrada "guardia" en el historial).
 * - Flechas flotantes en las filas horizontales con el ratón (la rueda normal sigue siendo vertical;
 *   Mayús+rueda o el gesto horizontal del trackpad también las desplazan). */
function setupNonTvInput(){
  /* ---- Pulsación larga ---- */
  var LP_MS = 550, lp = null, suppressUntil = 0;
  function gridOf(el){
    var n = el.parentNode;
    while(n && n !== document){ if(n._fg) return n._fg; n = n.parentNode; }
    return null;
  }
  function lpCancel(){ if(lp){ clearTimeout(lp.timer); lp = null; } }
  document.addEventListener("touchstart", function(ev){
    lpCancel();
    if(ev.touches.length !== 1) return;
    var tg = ev.target, el = tg && tg.closest ? tg.closest(".focusable") : null;
    if(!el || el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
    if(App.player && App.player.isActive && App.player.isActive()) return;
    var t = ev.touches[0];
    lp = { x: t.clientX, y: t.clientY, el: el, timer: setTimeout(function(){
      var node = lp && lp.el; lp = null;
      if(!node || !document.body.contains(node)) return;
      suppressUntil = Date.now() + 900;
      var g = gridOf(node);
      if(g){
        g.refresh(false);
        var i = g.items.indexOf(node);
        if(i >= 0){
          if(document.body.classList.contains("zone-header")) focusContent();
          g.focus(i);
        }
      }
      try{ if(navigator.vibrate) navigator.vibrate(15); }catch(e){}
      App.openMenu();
    }, LP_MS) };
  }, { passive: true });
  document.addEventListener("touchmove", function(ev){
    if(!lp) return;
    var t = ev.touches[0];
    if(Math.abs(t.clientX - lp.x) > 10 || Math.abs(t.clientY - lp.y) > 10) lpCancel();
  }, { passive: true });
  document.addEventListener("touchend", lpCancel, { passive: true });
  document.addEventListener("touchcancel", lpCancel, { passive: true });
  /* El clic que sigue a la pulsación larga no debe abrir el elemento */
  document.addEventListener("click", function(ev){
    if(Date.now() < suppressUntil){ ev.preventDefault(); ev.stopPropagation(); }
  }, true);

  /* ---- Atrás del navegador / Android ---- */
  var GUARD = { faro: 2 };
  function sig(){
    var m = document.getElementById("main");
    return [current ? current.id : "", stack.length, App.ui.isModalOpen() ? 1 : 0,
      (App.player && App.player.isActive && App.player.isActive()) ? 1 : 0, m ? m.innerHTML.length : 0].join("|");
  }
  try{
    history.replaceState({ faro: 1 }, "", location.href);
    history.pushState(GUARD, "", location.href);
  }catch(e){ return; }
  window.addEventListener("popstate", function(ev){
    if(ev.state && ev.state.faro === 2) return;   // avance hasta la entrada guardia: nada que hacer
    var busy = App.ui.isModalOpen() || (App.player && App.player.isActive && App.player.isActive()) ||
      (App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen());
    var atHome = current && current.id === "home" && !stack.length;
    if(!busy && atHome){ history.back(); return; }   // raíz: dejar que el navegador salga
    if(zone === "header" && !busy){ zone = "content"; syncNav(); }
    var before = sig();
    onKeyDown({ keyCode: K.ESC, preventDefault: function(){}, stopPropagation: function(){} });
    if(!busy && sig() === before && current && current.id !== "home"){ App.section("home"); }
    try{ history.pushState(GUARD, "", location.href); }catch(e){}
  });

  /* ---- Flechas de fila con el ratón ---- */
  if(window.matchMedia && !window.matchMedia("(pointer: coarse)").matches){
    var arrows = document.createElement("div");
    arrows.className = "row-arrows";
    arrows.innerHTML = '<div class="ra ra-l" aria-hidden="true">‹</div><div class="ra ra-r" aria-hidden="true">›</div>';
    document.body.appendChild(arrows);
    var rowEl = null, hideT = null;
    function place(){
      if(!rowEl || !document.body.contains(rowEl) || !document.body.classList.contains("desk")){ arrows.classList.remove("on"); return; }
      var r = rowEl.getBoundingClientRect();
      var canL = rowEl.scrollLeft > 4, canR = rowEl.scrollLeft < rowEl.scrollWidth - rowEl.clientWidth - 4;
      if(r.height < 40 || (!canL && !canR)){ arrows.classList.remove("on"); return; }
      arrows.style.top = r.top + "px"; arrows.style.height = r.height + "px";
      arrows.style.left = r.left + "px"; arrows.style.width = r.width + "px";
      arrows.querySelector(".ra-l").style.visibility = canL ? "visible" : "hidden";
      arrows.querySelector(".ra-r").style.visibility = canR ? "visible" : "hidden";
      arrows.classList.add("on");
    }
    document.addEventListener("mouseover", function(ev){
      var h = ev.target && ev.target.closest ? ev.target.closest(".hscroll") : null;
      if(h){ clearTimeout(hideT); if(h !== rowEl){ rowEl = h; } place(); }
      else if(!(ev.target.closest && ev.target.closest(".row-arrows"))){
        clearTimeout(hideT); hideT = setTimeout(function(){ rowEl = null; arrows.classList.remove("on"); }, 120);
      }
    });
    document.addEventListener("scroll", function(){ if(rowEl) place(); }, true);
    arrows.addEventListener("click", function(ev){
      var t = ev.target; if(!rowEl || !t || !t.classList) return;
      var d = t.classList.contains("ra-l") ? -1 : t.classList.contains("ra-r") ? 1 : 0;
      if(d) rowEl.scrollBy ? rowEl.scrollBy({ left: d * rowEl.clientWidth * 0.8, behavior: "smooth" }) : (rowEl.scrollLeft += d * rowEl.clientWidth * 0.8);
    });
  }
}

/* ================= Arranque ================= */
function boot(){
  DEFAULT_HINT = App.t("main.hint");
  document.documentElement.lang = App.i18n.lang();
  mainEl = document.getElementById("main");
  buildShell();
  App.registerKeys();
  booted = true;
  renderNav();
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  initMobile();
  // Clic de ratón (útil al probar en PC): seleccionar pestaña
  railEl.addEventListener("click", function(ev){
    var t = ev.target.closest ? ev.target.closest(".rail-item") : null;
    if(t){ App.section(t.getAttribute("data-id")); zone = "content"; syncNav(); }
  });
  if(App.profile.needsSelect()) App.section("profiles");
  else startApp();
  /* Botón Atrás flotante fuera de la TV (móvil / PC con ratón) */
  if(!App.isTizen()){
    var bb = document.createElement("div");
    bb.className = "touch-back";
    bb.textContent = "←";
    bb.title = App.t("ui.back");
    bb.setAttribute("role", "button");
    bb.setAttribute("aria-label", App.t("ui.back"));
    bb.addEventListener("click", function(){
      onKeyDown({ keyCode: K.ESC, preventDefault: function(){}, stopPropagation: function(){} });
    });
    /* Va dentro de la cabecera (nunca tapa el contenido); en Inicio, sin nada a lo que volver, se oculta */
    var hl = document.getElementById("headerLeft");
    (hl || document.body).appendChild(bb);
    function syncBackBtn(){
      var atRoot = current && current.id === "home" && !stack.length;
      bb.classList.toggle("is-hidden", !!atRoot);
    }
    App.bus.on("screen:show", syncBackBtn);
    syncBackBtn();
    setupNonTvInput();
    /* Clic derecho = menú de opciones (como mantener OK) */
    document.addEventListener("contextmenu", function(ev){
      var tg = ev.target;
      if(tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA")) return;
      ev.preventDefault();
      if(App.player && App.player.isActive && App.player.isActive()) return;
      App.openMenu();
    });
    /* Aviso único con los atajos del teclado del PC */
    var tipKey = "pcKeysTip1";
    var shown = false;
    try{ shown = localStorage.getItem(tipKey) === "1"; }catch(e){}
    var coarse = false; try{ coarse = window.matchMedia("(pointer: coarse)").matches; }catch(e){}
    if(!shown && !coarse){
      setTimeout(function(){ App.ui.toast(App.t("main.pcKeys"), 12000); }, 2500);
      try{ localStorage.setItem(tipKey, "1"); }catch(e){}
    }
  }
  App.bus.emit("app:ready");
  /* Avisa al cargador (tizen-app/index.html): arranque correcto → no hacer rollback */
  try{ if(typeof window.__tbBooted === "function") window.__tbBooted(App.version); }catch(e){}
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
