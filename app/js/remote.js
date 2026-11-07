/* remote.js — ajustes desde el móvil/PC a través de service.js.
 * La TV consulta /tv/pending cada 3 s, aplica lo recibido y publica un resumen
 * (claves enmascaradas) en /tv/snapshot para que la web muestre el estado actual.
 * Muestra un aviso con la URL y el PIN en las pantallas de configuración y Ajustes.
 */
(function(){
"use strict";

var App = window.App;
var info = null;           // {pin, ips, port}
var timer = null;
var bannerEl = null;
var SHOW_ON = { setup: true, settings: true };

function mask(v){
  v = String(v || "");
  if(!v) return "";
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "••••" + v.slice(-4);
}

function base(){ return App.net.PROXY; }

function pushSnapshot(){
  if(!App.net.usingProxy()) return;
  var s = App.settings.all();
  var snap = {
    torboxToken: mask(s.torboxToken), tmdbKey: mask(s.tmdbKey),
    defaultSource: s.defaultSource, audioLang: s.audioLang, subLang: s.subLang,
    subSize: s.subSize, autoplayNext: s.autoplayNext, liveListUrl: s.liveListUrl
  };
  fetch(base() + "/tv/snapshot", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap)
  }).catch(function(){});
}

function apply(settings){
  var keys = Object.keys(settings || {});
  if(!keys.length) return;
  var tokenChanged = false;
  keys.forEach(function(k){
    App.settings.set(k, settings[k]);
    if(k === "torboxToken") tokenChanged = true;
  });
  if(tokenChanged){
    App.torbox.invalidate();
    if(App.current() === "setup" || App.current() === "library"){
      App.section(App.screens.get("library") ? "library" : "settings");
    }
  }
  if(keys.indexOf("tmdbKey") >= 0) App.bus.emit("meta:keychange");
  App.ui.toast("Ajustes recibidos del móvil ✓");
  pushSnapshot();
}

function poll(){
  fetch(base() + "/tv/pending").then(function(r){ return r.json(); }).then(function(j){
    if(j && j.pending && j.pending.settings) apply(j.pending.settings);
  }).catch(function(){});
}

function loadInfo(){
  return fetch(base() + "/tv/state").then(function(r){ return r.json(); }).then(function(j){
    info = j; renderBanner(); App.bus.emit("remote:info", info);
    return info;
  }).catch(function(){ return null; });
}

App.remote = {
  info: function(){ return info; },
  url: function(){
    if(!info || !info.ips || !info.ips.length) return "";
    return "http://" + info.ips[0] + ":" + info.port;
  }
};

/* ---- Aviso en pantalla ---- */
function renderBanner(){
  if(!bannerEl){
    bannerEl = document.createElement("div");
    bannerEl.className = "remote-banner";
    document.body.appendChild(bannerEl);
  }
  var url = App.remote.url();
  if(!info || !url){ bannerEl.classList.remove("on"); return; }
  bannerEl.innerHTML =
    '<span class="rb-title">Configura desde el móvil o el PC</span>' +
    '<span class="rb-url">' + App.esc(url) + '</span>' +
    '<span class="rb-pin">PIN <b>' + App.esc(info.pin) + '</b></span>';
  syncBanner();
}
function syncBanner(){
  if(!bannerEl) return;
  var show = !!(info && App.remote.url() && SHOW_ON[App.current()]);
  bannerEl.classList.toggle("on", show);
}

function start(){
  App.net.checkProxy().then(function(ok){
    if(!ok) return;
    loadInfo().then(pushSnapshot);
    poll();
    timer = setInterval(poll, 3000);
    // La pantalla actual cambia sin evento: comprobar a menudo es barato
    setInterval(syncBanner, 500);
  });
}

App.bus.on("settings:change", App.debounce(pushSnapshot, 500));
App.bus.on("app:ready", start);

})();
