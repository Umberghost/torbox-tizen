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
  if(!def){ App.hint("Pantalla no disponible: " + id); return; }
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
      App.ui.error(el, "Error en la pantalla", e.message);
    }
  }
  App.setHintDefault(def.hint || DEFAULT_HINT);
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
var DEFAULT_HINT = "▲▼◄► moverse · OK elegir · Atrás volver";

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
    App.ui.confirm("¿Salir de TorBox?", "", "Salir", "Cancelar").then(function(yes){
      if(!yes) return;
      try{ tizen.application.getCurrentApplication().exit(); }
      catch(e){ try{ window.history.back(); }catch(e2){} }
    });
  }
}

/* ================= Teclado ================= */
function onKeyDown(e){
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
  id: "setup", label: "Configuración", nav: false,
  hint: "Escribe tu API key · ▼ botón · OK guardar",
  mount: function(el){
    el.innerHTML =
      '<div class="center"><div class="box setup-box">' +
        '<h2>Conecta tu cuenta de TorBox</h2>' +
        '<p>Pega tu API key (torbox.app → Settings → API). Se guarda solo en esta TV.</p>' +
        '<input id="tokenInput" class="input focusable" type="text" autocomplete="off" spellcheck="false" placeholder="API key">' +
        '<div class="btn focusable" id="saveBtn">Guardar y entrar</div>' +
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
  if(!v){ App.hint("Introduce una API key"); return; }
  App.settings.set("torboxToken", v);
  App.torbox.invalidate();
  document.getElementById("tokenInput").blur();
  App.section(firstSection());
}
App.openSetup = function(){ App.section("setup"); };

function firstSection(){
  var list = App.screens.navList();
  return screens.library ? "library" : (list[0] ? list[0].id : "setup");
}

/* ================= Arranque ================= */
function boot(){
  mainEl = document.getElementById("main");
  navEl = document.getElementById("nav");
  App.registerKeys();
  booted = true;
  renderNav();
  document.addEventListener("keydown", onKeyDown, true);
  // Clic de ratón (útil al probar en PC): seleccionar pestaña
  navEl.addEventListener("click", function(ev){
    var t = ev.target.closest ? ev.target.closest(".tab") : null;
    if(t) App.section(t.dataset.id);
  });
  if(App.torbox.hasToken()) App.section(firstSection());
  else App.section("setup");
  App.bus.emit("app:ready");
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
