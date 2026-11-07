/* main.js — registro de pantallas, router, barra de secciones, despacho de teclas y arranque. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

/* ================= Registro de pantallas ================= */
var screens = App.screens.all();   // id → def (registro en core.js)
App.bus.on("screens:change", function(){ if(booted) renderNav(); });

/* ================= Router ================= */
var mainEl, navEl;
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

/* ================= Barra de secciones ================= */
var DEFAULT_HINT = "";  // se calcula con App.t al arrancar

function renderNav(){
  if(!navEl) return;
  var list = App.screens.navList();
  navEl.innerHTML = list.map(function(s){
    return '<div class="tab" data-id="' + App.esc(s.id) + '">' + App.esc(s.label || s.id) + '</div>';
  }).join("");
  syncNav();
}
function syncNav(){
  if(!navEl) return;
  var tabs = navEl.children;
  var activeId = current ? current.id : null;
  // si estamos en una subpantalla, se marca la sección de la que venimos
  var sectionId = activeId;
  if(activeId && screens[activeId] && !screens[activeId].nav){
    for(var i = stack.length - 1; i >= 0; i--){
      if(screens[stack[i].id] && screens[stack[i].id].nav){ sectionId = stack[i].id; break; }
    }
    if(screens[activeId].section) sectionId = screens[activeId].section;
  }
  for(var j = 0; j < tabs.length; j++){
    var t = tabs[j];
    t.classList.toggle("active", t.dataset.id === sectionId);
    t.classList.toggle("focused", zone === "header" && j === navIndex);
    if((t.classList.contains("active") && zone !== "header") || (zone === "header" && j === navIndex)){
      if(App.ui.scrollIntoView) App.ui.scrollIntoView(t);
    }
  }
  document.body.classList.toggle("zone-header", zone === "header");
}

App.focusHeader = function(){
  var list = App.screens.navList();
  var cur = current ? current.id : null;
  navIndex = 0;
  list.forEach(function(s, i){ if(s.id === cur) navIndex = i; });
  // si estamos en subpantalla, apunta a la sección marcada
  var act = navEl.querySelector(".tab.active");
  if(act){ for(var i = 0; i < navEl.children.length; i++) if(navEl.children[i] === act) navIndex = i; }
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

function headerKey(k){
  var list = App.screens.navList();
  if(k === K.LEFT || k === K.RIGHT){
    navIndex = (navIndex + (k === K.RIGHT ? 1 : -1) + list.length) % list.length;
    var target = list[navIndex];
    if(target && (!current || target.id !== current.id)){
      App.section(target.id);
      zone = "header";
      var def = screens[target.id];
      if(def && def.blur){ try{ def.blur(); }catch(e){} }
    }
    syncNav();
    return;
  }
  if(k === K.DOWN || k === K.OK){
    var t = list[navIndex];
    if(t && (!current || t.id !== current.id)) App.section(t.id);
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
  if(k === K.UP){ e.preventDefault(); App.focusHeader(); return; }
  // Atajos de color globales
  if(k === K.BLUE && screens.settings){ e.preventDefault(); App.section("settings"); return; }
  if(k === K.YELLOW && screens.search){ e.preventDefault(); App.section("search"); return; }
}

/* ================= Pantalla de configuración inicial ================= */
App.screens.register({
  id: "setup", label: "Setup", nav: false,
  get hint(){ return App.t("setup.hint"); },
  mount: function(el){
    el.innerHTML =
      '<div class="center"><div class="box setup-box">' +
        '<h2>' + App.esc(App.t("setup.title")) + '</h2>' +
        '<p>' + App.esc(App.t("setup.text")) + '</p>' +
        '<input id="tokenInput" class="input focusable" type="text" autocomplete="off" spellcheck="false" placeholder="' + App.esc(App.t("setup.placeholder")) + '">' +
        '<div class="btn focusable" id="saveBtn">' + App.esc(App.t("setup.save")) + '</div>' +
        '<div class="setup-lang muted">' + App.esc(App.t("setup.langHint")) + '</div>' +
      '</div></div>';
    var input = el.querySelector("#tokenInput");
    input.addEventListener("keydown", function(ev){
      if(ev.keyCode === 13){ ev.preventDefault(); ev.stopPropagation(); save(); }
    });
    this._el = el;
  },
  show: function(){
    var el = this._el;
    var input = el.querySelector("#tokenInput");
    input.value = App.settings.get("torboxToken") || "";
    this._f = 0; this.paint();
  },
  paint: function(){
    var el = this._el, input = el.querySelector("#tokenInput"), btn = el.querySelector("#saveBtn");
    input.classList.toggle("focused", this._f === 0);
    btn.classList.toggle("focused", this._f === 1);
    if(this._f === 0) input.focus(); else input.blur();
  },
  focus: function(){ this.paint(); },
  onKey: function(k){
    if(k === K.DOWN){ this._f = 1; this.paint(); return true; }
    if(k === K.UP){ this._f = 0; this.paint(); return true; }
    if(k === K.OK && this._f === 1){ save(); return true; }
    if(App.isBack(k)){
      if(this._f === 0 && k === K.BACKSPACE) return false;
      if(App.torbox.hasToken()){ App.section(firstSection()); }
      return true;
    }
    return this._f === 0 && (k === K.LEFT || k === K.RIGHT); // dejar mover el cursor
  }
});

function save(){
  var v = document.getElementById("tokenInput").value.trim();
  if(!v){ App.hint(App.t("setup.needKey")); return; }
  App.settings.set("torboxToken", v);
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
function applyMobile(){
  var narrow = window.innerWidth < 1000 || window.innerHeight > window.innerWidth;
  document.body.classList.toggle("mobile", narrow);
  document.body.classList.toggle("portrait", window.innerHeight > window.innerWidth);
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

/* ================= Arranque ================= */
function boot(){
  DEFAULT_HINT = App.t("main.hint");
  document.documentElement.lang = App.i18n.lang();
  mainEl = document.getElementById("main");
  navEl = document.getElementById("nav");
  App.registerKeys();
  booted = true;
  renderNav();
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  initMobile();
  // Clic de ratón (útil al probar en PC): seleccionar pestaña
  navEl.addEventListener("click", function(ev){
    var t = ev.target.closest ? ev.target.closest(".tab") : null;
    if(t) App.section(t.dataset.id);
  });
  if(App.profile.needsSelect()) App.section("profiles");
  else startApp();
  /* Botón Atrás flotante fuera de la TV (móvil / PC con ratón) */
  if(!App.isTizen()){
    var bb = document.createElement("div");
    bb.className = "touch-back";
    bb.textContent = "←";
    bb.title = App.t("ui.back");
    bb.addEventListener("click", function(){
      onKeyDown({ keyCode: K.ESC, preventDefault: function(){}, stopPropagation: function(){} });
    });
    document.body.appendChild(bb);
  }
  App.bus.emit("app:ready");
  /* Avisa al cargador (tizen-app/index.html): arranque correcto → no hacer rollback */
  try{ if(typeof window.__tbBooted === "function") window.__tbBooted(App.version); }catch(e){}
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
