/* remote.js — control desde el móvil/PC a través de service.js (TV) y sincronización vía Worker.
 * - Long-poll de /tv/pending: aplica ajustes y ejecuta acciones (add, play, playUrl, control, key, import, export).
 * - Publica un resumen de ajustes en /tv/snapshot y el estado del reproductor en /tv/status (cada 2 s mientras reproduce).
 * - Banner con URL, PIN y código QR (http://IP:8095/?pin=XXXX).
 * - Sync de "Continuar viendo" vía Worker (KV) o `syncUrl`.
 * Textos i18n: registrados aquí mismo (prefijo remote.).
 */
(function(){
"use strict";

var App = window.App;
var info = null;           // {pin, ips, port}
var bannerEl = null;
var SHOW_ON = { setup: true, settings: true };
var polling = false;

App.i18n.add("en", {
  "remote.playingTitle": "Playing on TV",
  "remote.play": "Playing {title}",
  "remote.playFailed": "Could not play: {msg}",
  "remote.keyUnknown": "Unknown key",
  "remote.notPlaying": "Nothing is playing",
  "remote.imported": "Settings imported ({n} items)",
  "remote.importedReport": "Imported: {settings} settings, {history} history entries, {favs} favourites, {follow} followed series.",
  "remote.importFailed": "Import failed: {msg}",
  "remote.exported": "Backup ready",
  "remote.scan": "Scan with your phone",
  "remote.syncOk": "Watch history synced"
});
App.i18n.add("es", {
  "remote.playingTitle": "Reproduciendo en la TV",
  "remote.play": "Reproduciendo {title}",
  "remote.playFailed": "No se pudo reproducir: {msg}",
  "remote.keyUnknown": "Tecla desconocida",
  "remote.notPlaying": "No se está reproduciendo nada",
  "remote.imported": "Ajustes importados ({n} elementos)",
  "remote.importedReport": "Importado: {settings} ajustes, {history} entradas de historial, {favs} favoritos, {follow} series seguidas.",
  "remote.importFailed": "Error al importar: {msg}",
  "remote.exported": "Copia de seguridad lista",
  "remote.scan": "Escanea con el móvil",
  "remote.syncOk": "Historial sincronizado"
});
App.i18n.add("ca", {
  "remote.playingTitle": "Reproduint a la TV",
  "remote.play": "Reproduint {title}",
  "remote.playFailed": "No s'ha pogut reproduir: {msg}",
  "remote.keyUnknown": "Tecla desconeguda",
  "remote.notPlaying": "No s'està reproduint res",
  "remote.imported": "Ajustos importats ({n} elements)",
  "remote.importedReport": "Importat: {settings} ajustos, {history} entrades d'historial, {favs} preferits, {follow} sèries seguides.",
  "remote.importFailed": "Error en importar: {msg}",
  "remote.exported": "Còpia de seguretat llesta",
  "remote.scan": "Escaneja amb el mòbil",
  "remote.syncOk": "Historial sincronitzat"
});
App.i18n.add("gl", {
  "remote.playingTitle": "Reproducindo na TV",
  "remote.play": "Reproducindo {title}",
  "remote.playFailed": "Non se puido reproducir: {msg}",
  "remote.keyUnknown": "Tecla descoñecida",
  "remote.notPlaying": "Non se está reproducindo nada",
  "remote.imported": "Axustes importados ({n} elementos)",
  "remote.importedReport": "Importado: {settings} axustes, {history} entradas de historial, {favs} favoritos, {follow} series seguidas.",
  "remote.importFailed": "Erro ao importar: {msg}",
  "remote.exported": "Copia de seguridade lista",
  "remote.scan": "Escanea co móbil",
  "remote.syncOk": "Historial sincronizado"
});
App.i18n.add("eu", {
  "remote.playingTitle": "Telebistan erreproduzitzen",
  "remote.play": "{title} erreproduzitzen",
  "remote.playFailed": "Ezin izan da erreproduzitu: {msg}",
  "remote.keyUnknown": "Tekla ezezaguna",
  "remote.notPlaying": "Ez dago ezer erreproduzitzen",
  "remote.imported": "Ezarpenak inportatu dira ({n} elementu)",
  "remote.importedReport": "Inportatuta: {settings} ezarpen, {history} historial-sarrera, {favs} gogoko, {follow} jarraitutako serie.",
  "remote.importFailed": "Errorea inportatzean: {msg}",
  "remote.exported": "Babeskopia prest",
  "remote.scan": "Eskaneatu telefonoarekin",
  "remote.syncOk": "Historiala sinkronizatu da"
});
App.i18n.add("pt", {
  "remote.playingTitle": "A reproduzir na TV",
  "remote.play": "A reproduzir {title}",
  "remote.playFailed": "Não foi possível reproduzir: {msg}",
  "remote.keyUnknown": "Tecla desconhecida",
  "remote.notPlaying": "Nada está a ser reproduzido",
  "remote.imported": "Definições importadas ({n} elementos)",
  "remote.importedReport": "Importado: {settings} definições, {history} entradas de histórico, {favs} favoritos, {follow} séries seguidas.",
  "remote.importFailed": "Falha ao importar: {msg}",
  "remote.exported": "Cópia de segurança pronta",
  "remote.scan": "Leia com o telemóvel",
  "remote.syncOk": "Histórico sincronizado"
});
App.i18n.add("fr", {
  "remote.playingTitle": "Lecture sur la TV",
  "remote.play": "Lecture de {title}",
  "remote.playFailed": "Lecture impossible : {msg}",
  "remote.keyUnknown": "Touche inconnue",
  "remote.notPlaying": "Aucune lecture en cours",
  "remote.imported": "Réglages importés ({n} éléments)",
  "remote.importedReport": "Importé : {settings} réglages, {history} entrées d'historique, {favs} favoris, {follow} séries suivies.",
  "remote.importFailed": "Échec de l'importation : {msg}",
  "remote.exported": "Sauvegarde prête",
  "remote.scan": "Scannez avec votre téléphone",
  "remote.syncOk": "Historique synchronisé"
});

/* Claves que se pueden importar (mismas que acepta service.js) */
var IMPORT_KEYS = ["torboxToken", "tmdbKey", "defaultSource", "autoplayNext", "subLang", "audioLang", "subSize",
  "liveListUrl", "stremioAddon", "stremioAddons", "liveExtraLists", "uiLanguage", "contentLanguage", "autoPlayBest",
  "prefQuality", "maxSizeGB", "prefAudio", "hideUnsupported", "openSubs", "notifyReady", "traktClientId",
  "traktClientSecret", "ntfyTopic", "followAuto", "syncUrl"];
var LIST_KEYS = { stremioAddons: 1, liveExtraLists: 1 };

function mask(v){
  v = String(v || "");
  if(!v) return "";
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "••••" + v.slice(-4);
}
/* Las URLs de add-ons suelen llevar la API key dentro: enseñar solo el host y el final */
function maskUrl(u){
  u = String(u || "");
  var m = /^(https?:\/\/[^\/]+\/)(.*)$/.exec(u);
  if(!m) return u.slice(0, 24) + "…";
  return m[2].length > 16 ? m[1] + "…" + m[2].slice(-14) : u;
}

function base(){ return App.net.PROXY; }
function isTvService(){ return App.net.usingProxy() && App.net.service === "torbox-tizen"; }

function pushSnapshot(){
  if(!isTvService()) return;
  var s = App.settings.all();
  var snap = {
    torboxToken: mask(s.torboxToken), tmdbKey: mask(s.tmdbKey),
    stremioAddon: s.stremioAddon ? maskUrl(s.stremioAddon) : "",
    stremioAddons: (s.stremioAddons || []).map(maskUrl),
    liveExtraLists: (s.liveExtraLists || []).map(maskUrl),
    traktClientId: mask(s.traktClientId), traktClientSecret: mask(s.traktClientSecret),
    traktLinked: !!(App.trakt && App.trakt.isLinked && App.trakt.isLinked()),
    appVersion: App.version
  };
  ["defaultSource", "audioLang", "subLang", "subSize", "autoplayNext", "liveListUrl", "uiLanguage", "contentLanguage",
   "autoPlayBest", "prefQuality", "maxSizeGB", "prefAudio", "hideUnsupported", "openSubs", "notifyReady",
   "ntfyTopic", "followAuto"]
    .forEach(function(k){ snap[k] = s[k]; });
  fetch(base() + "/tv/snapshot", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap)
  }).catch(function(){});
}

/* Aplica el valor recibido de un ajuste; las listas llegan como {ops:[…]} */
function applyOne(k, v){
  if(LIST_KEYS[k] && v && v.ops){
    var cur = (App.settings.get(k) || []).slice();
    v.ops.forEach(function(o){
      if(o.op === "add"){ if(cur.indexOf(o.value) < 0) cur.push(o.value); }
      else if(o.op === "remove"){ if(o.index >= 0 && o.index < cur.length) cur.splice(o.index, 1); }
      else if(o.op === "set"){ cur = o.value.slice(); }
    });
    App.settings.set(k, cur);
    return;
  }
  App.settings.set(k, v);
}

function apply(settings){
  var keys = Object.keys(settings || {});
  if(!keys.length) return;
  var tokenChanged = false;
  keys.forEach(function(k){
    applyOne(k, settings[k]);
    if(k === "torboxToken") tokenChanged = true;
  });
  if(tokenChanged){
    App.torbox.invalidate();
    if(App.current() === "setup" || App.current() === "library"){
      App.section(App.screens.get("library") ? "library" : "settings");
    }
  }
  if(keys.indexOf("tmdbKey") >= 0) App.bus.emit("meta:keychange");
  App.ui.toast(App.t("remote.received"));
  pushSnapshot();
}

function report(id, ok, message, data){
  var body = { id: id, ok: ok, message: message };
  if(data !== undefined) body.data = data;
  fetch(base() + "/tv/actionresult", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }).catch(function(){});
}

/* ---- Teclas simuladas ---- */
var KEYMAP = {
  up: 38, down: 40, left: 37, right: 39, ok: 13, enter: 13, back: 10009, esc: 27,
  play: 415, pause: 19, playpause: 10252, stop: 413, ff: 417, rw: 412, prev: 10232, next: 10233,
  chup: 427, chdown: 428, red: 403, green: 404, yellow: 405, blue: 406, info: 457, menu: 10133, tools: 10135,
  d0: 48, d1: 49, d2: 50, d3: 51, d4: 52, d5: 53, d6: 54, d7: 55, d8: 56, d9: 57
};
function fireKey(code){
  var target = document.activeElement || document.body || document;
  ["keydown", "keyup"].forEach(function(type){
    var ev;
    try{ ev = new KeyboardEvent(type, { bubbles: true, cancelable: true }); }
    catch(e){ ev = document.createEvent("Event"); ev.initEvent(type, true, true); }
    try{
      Object.defineProperty(ev, "keyCode", { get: function(){ return code; } });
      Object.defineProperty(ev, "which", { get: function(){ return code; } });
      Object.defineProperty(ev, "key", { get: function(){ return code === 13 ? "Enter" : ""; } });
    }catch(e){}
    target.dispatchEvent(ev);
  });
}
function pressKey(name){
  name = String(name || "").toLowerCase();
  if(name === "home"){
    if(App.player && App.player.isActive && App.player.isActive()) App.player.stop();
    var home = App.screens.get("home") ? "home" : (App.screens.get("library") ? "library" : null);
    if(home && App.section) App.section(home);
    return true;
  }
  if(!(name in KEYMAP)) return false;
  fireKey(KEYMAP[name]);
  return true;
}

/* ---- Copia de seguridad ---- */
function buildBackup(){
  var s = App.settings.all(), out = {};
  IMPORT_KEYS.forEach(function(k){ if(s[k] !== undefined) out[k] = s[k]; });
  return {
    app: "torbox-tizen", format: 1, version: App.version, at: Date.now(),
    settings: out,
    history: (App.history && App.history.list) ? App.history.list() : [],
    liveFavs: App.store.get("live_favs", []),
    follow: (App.follow && App.follow.list) ? App.follow.list() : []
  };
}
function mergeHistory(list){
  var n = 0;
  if(!App.history || !list || !list.length) return 0;
  list.forEach(function(r){
    if(!r || !r.key) return;
    var cur = App.history.get(r.key);
    if(cur && (cur.updated || 0) >= (r.updated || 0)) return;
    var e = App.history.save({
      key: r.key, pos: r.pos || 0, dur: r.dur || 0, title: r.title, subtitle: r.subtitle,
      poster: r.poster, watched: !!r.watched, meta: r.meta
    });
    if(e){ e.updated = r.updated || e.updated; n++; }   // save() devuelve la entrada viva: conservar su fecha original
  });
  return n;
}
function importBackup(d){
  var res = { settings: 0, history: 0, favs: 0, follow: 0 };
  var st = d.settings || {};
  IMPORT_KEYS.forEach(function(k){
    if(!(k in st)) return;
    var v = st[k];
    if(LIST_KEYS[k]){ if(!Array.isArray(v)) return; }
    App.settings.set(k, v); res.settings++;
  });
  if(d.history && d.history.length) res.history = mergeHistory(d.history);
  if(d.liveFavs && Array.isArray(d.liveFavs)){ App.store.set("live_favs", d.liveFavs); res.favs = d.liveFavs.length; }
  if(d.follow && Array.isArray(d.follow) && App.follow && App.follow.toggle){
    d.follow.forEach(function(f){
      if(f && f.imdbId && !App.follow.isFollowing(f.imdbId)){ App.follow.toggle({ imdbId: f.imdbId, name: f.name, poster: f.poster }); res.follow++; }
    });
  }
  App.torbox.invalidate();
  App.bus.emit("meta:keychange");
  App.bus.emit("history:change");
  pushSnapshot();
  return res;
}

function runAction(a){
  if(!a) return;
  if(a.type === "add"){
    if(!App.torbox.hasToken()){ report(a.id, false, App.t("remote.noKey")); return; }
    console.info("[remoto] añadir enlace:", String(a.link).slice(0, 80));
    App.torbox.addLink(a.link, a.name).then(function(r){
      var what = App.t("remote.kind." + r.kind);
      var name = (r.data && (r.data.name || r.data.hash)) || "";
      App.ui.toast(App.t("remote.addedToast", {what: what}));
      report(a.id, true, App.t("remote.addedReport", {what: what, name: name ? ": " + name : ""}));
      App.bus.emit("torbox:added", r);
    }).catch(function(e){
      console.warn("[remoto] error al añadir:", e.message);
      App.ui.toast(App.t("remote.addFailed", {msg: e.message}));
      report(a.id, false, App.t("remote.addFailed", {msg: e.message}));
    });
    return;
  }
  if(a.type === "play"){
    console.info("[remoto] play", a.mediaType, a.imdbId, a.season, a.episode);
    if(!App.search || !App.search.playTitle){ report(a.id, false, App.t("remote.playFailed", {msg: "search"})); return; }
    Promise.resolve(App.search.playTitle({
      type: a.mediaType, id: a.imdbId, season: a.season, episode: a.episode
    })).then(function(){
      report(a.id, true, App.t("remote.play", {title: a.title || a.imdbId}));
    }).catch(function(e){
      report(a.id, false, App.t("remote.playFailed", {msg: (e && e.message) || ""}));
    });
    return;
  }
  if(a.type === "playUrl"){
    console.info("[remoto] playUrl", String(a.url).slice(0, 80));
    try{
      App.player.play({ title: a.title || a.url.split("/").pop().split("?")[0] || "URL", url: a.url, key: "url:" + a.url.slice(0, 120) });
      report(a.id, true, App.t("remote.play", {title: a.title || a.url.slice(0, 60)}));
    }catch(e){ report(a.id, false, App.t("remote.playFailed", {msg: e.message})); }
    return;
  }
  if(a.type === "control"){
    if(!App.player || !App.player.control){ report(a.id, false, App.t("remote.notPlaying")); return; }
    try{ App.player.control(a.cmd, a.arg); report(a.id, true, "OK"); publishStatus(true); }
    catch(e){ report(a.id, false, e.message); }
    return;
  }
  if(a.type === "key"){
    report(a.id, pressKey(a.key), "");
    return;
  }
  if(a.type === "import"){
    try{
      var r = importBackup(a.data || {});
      App.ui.toast(App.t("remote.imported", {n: r.settings + r.history + r.favs + r.follow}));
      report(a.id, true, App.t("remote.importedReport", r));
    }catch(e){
      report(a.id, false, App.t("remote.importFailed", {msg: e.message}));
    }
    return;
  }
  if(a.type === "export"){
    try{ report(a.id, true, App.t("remote.exported"), buildBackup()); }
    catch(e){ report(a.id, false, e.message); }
  }
}

/* ---- Long-poll: las teclas del móvil llegan al instante ---- */
function pollLoop(){
  if(polling) return;
  polling = true;
  (function next(){
    fetch(base() + "/tv/pending?wait=1").then(function(r){ return r.json(); }).then(function(j){
      if(j && j.pending && j.pending.settings) apply(j.pending.settings);
      if(j && j.actions) j.actions.forEach(function(a){ try{ runAction(a); }catch(e){ console.error("[remoto]", e); } });
      setTimeout(next, 30);
    }).catch(function(){ setTimeout(next, 3000); });
  })();
}

/* Registro: enviar lo nuevo cada 3 s */
var sentLog = 0, logBusy = false;
function pushLogs(){
  if(logBusy || App.logSeq() <= sentLog) return;
  var batch = App.logs(sentLog);
  if(!batch.length) return;
  logBusy = true;
  fetch(base() + "/tv/logs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch)
  }).then(function(){ sentLog = batch[batch.length - 1].n; })
    .catch(function(){}).then(function(){ logBusy = false; });
}

/* Estado del reproductor → /tv/status cada 2 s mientras reproduce (y una vez al parar) */
var lastActive = false;
function publishStatus(force){
  if(!isTvService() || !App.player || !App.player.status) return;
  var st;
  try{ st = App.player.status(); }catch(e){ return; }
  if(!st) return;
  if(!st.active && !lastActive && !force) return;
  lastActive = !!st.active;
  fetch(base() + "/tv/status", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(st)
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
  },
  /* URL con el PIN incluido (la usa el QR) */
  pinUrl: function(){
    var u = App.remote.url();
    return u && info ? u + "/?pin=" + encodeURIComponent(info.pin) : "";
  }
};

/* ---- Aviso en pantalla (con QR) ---- */
function drawQr(canvas, text){
  try{
    var qr = window.qrcode(0, "M");
    qr.addData(text); qr.make();
    var n = qr.getModuleCount(), px = 4, quiet = 2, size = (n + quiet * 2) * px;
    canvas.width = size; canvas.height = size;
    var c = canvas.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, size, size);
    c.fillStyle = "#000";
    for(var r = 0; r < n; r++) for(var q = 0; q < n; q++){
      if(qr.isDark(r, q)) c.fillRect((q + quiet) * px, (r + quiet) * px, px, px);
    }
    return true;
  }catch(e){ console.warn("[qr] " + e.message); return false; }
}
var qrFor = "";
function renderBanner(){
  if(!bannerEl){
    bannerEl = document.createElement("div");
    bannerEl.className = "remote-banner";
    document.body.appendChild(bannerEl);
  }
  var url = App.remote.url();
  if(!info || !url){ bannerEl.classList.remove("on"); return; }
  bannerEl.innerHTML =
    '<canvas class="rb-qr" style="width:150px;height:150px;border-radius:8px;image-rendering:pixelated;flex:none" aria-label="' + App.esc(App.t("remote.scan")) + '"></canvas>' +
    '<span style="display:flex;flex-direction:column;gap:8px">' +
    '<span class="rb-title">' + App.esc(App.t("remote.banner")) + '</span>' +
    '<span class="rb-url">' + App.esc(url) + '</span>' +
    '<span class="rb-pin">' + App.esc(App.t("remote.pin")) + ' <b>' + App.esc(info.pin) + '</b></span></span>';
  var cv = bannerEl.querySelector(".rb-qr");
  if(window.qrcode && !drawQr(cv, App.remote.pinUrl())) cv.style.display = "none";
  qrFor = App.remote.pinUrl();
  syncBanner();
}
function syncBanner(){
  if(!bannerEl) return;
  var show = !!(info && App.remote.url() && SHOW_ON[App.current()]);
  bannerEl.classList.toggle("on", show);
}

/* ---- Sync de "Continuar viendo" entre dispositivos (Worker con KV o syncUrl) ---- */
function cyrb(str, seed){
  var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for(var i = 0; i < str.length; i++){
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}
/* Clave secreta: derivada de la API key de TorBox (nunca se envía la key) */
function syncSecret(){
  var tk = App.settings.get("torboxToken");
  if(!tk) return "";
  return "tb" + cyrb(String(tk), 1) + cyrb(String(tk), 7) + cyrb(String(tk), 13);
}
function syncBase(){
  var u = String(App.settings.get("syncUrl") || "").trim().replace(/\/+$/, "");
  if(u) return u;
  if(App.net.service === "torbox-worker") return App.net.PROXY;
  return "";
}
var syncBusy = false;
function syncHistory(){
  var b = syncBase(), sec = syncSecret();
  if(!b || !sec || syncBusy || !App.history || !App.history.list) return;
  syncBusy = true;
  var local = App.history.list().slice(0, 300);
  fetch(b + "/sync/" + sec, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: local })
  }).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(j){
    var n = mergeHistory((j && j.entries) || []);
    if(n){ console.info("[sync] " + n + " entradas actualizadas"); App.bus.emit("history:change"); }
  }).catch(function(e){ console.warn("[sync] " + e.message); })
    .then(function(){ syncBusy = false; });
}
var syncSoon = App.debounce(syncHistory, 45000);

function start(){
  App.net.checkProxy().then(function(ok){
    if(ok && App.net.service === "torbox-tizen"){
      loadInfo().then(pushSnapshot);
      pollLoop();
      setInterval(pushLogs, 3000);
      setInterval(function(){ publishStatus(false); }, 2000);
      pushLogs();
      setInterval(syncBanner, 500);          // la pantalla actual cambia sin evento
    }
    if(syncBase()){
      setTimeout(syncHistory, 4000);
      App.bus.on("history:change", syncSoon);
      App.bus.on("player:close", function(){ setTimeout(syncHistory, 1500); });
    }
  });
}

App.bus.on("settings:change", App.debounce(pushSnapshot, 500));
App.bus.on("app:ready", start);

})();
