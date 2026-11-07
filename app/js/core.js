/* core.js — namespace App, almacenamiento, ajustes, bus de eventos, helpers y teclas. */
(function(){
"use strict";

var App = window.App = window.App || {};
App.version = "2.4.0";

/* ---------------- Registro (log) ----------------
 * Guarda los últimos mensajes de consola y errores para verlos desde la web del
 * móvil (remote.js los publica en service.js). App.log(nivel, ...args) también vale.
 */
var LOG_MAX = 400;
var logBuf = [];
var logSeq = 0;
function fmtArg(a){
  if(a instanceof Error) return a.message + (a.stack ? "\n" + String(a.stack).split("\n").slice(1, 4).join("\n") : "");
  if(typeof a === "object"){ try{ return JSON.stringify(a); }catch(e){ return String(a); } }
  return String(a);
}
function pushLog(level, args){
  var msg = Array.prototype.map.call(args, fmtArg).join(" ");
  if(msg.length > 2000) msg = msg.slice(0, 2000) + "…";
  logBuf.push({ n: ++logSeq, t: Date.now(), l: level, m: msg });
  if(logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
}
App.log = function(level){ pushLog(level || "info", Array.prototype.slice.call(arguments, 1)); };
App.logs = function(since){ since = since || 0; return logBuf.filter(function(e){ return e.n > since; }); };
App.logSeq = function(){ return logSeq; };
["log", "info", "warn", "error"].forEach(function(level){
  var orig = console[level];
  console[level] = function(){
    pushLog(level === "log" ? "info" : level, arguments);
    if(orig) try{ orig.apply(console, arguments); }catch(e){}
  };
});
window.addEventListener("error", function(ev){
  pushLog("error", ["[JS] " + (ev.message || "error") + (ev.filename ? " @ " + String(ev.filename).split("/").pop() + ":" + ev.lineno : "")]);
});
window.addEventListener("unhandledrejection", function(ev){
  var r = ev.reason;
  pushLog("error", ["[Promise] " + (r && r.message ? r.message : fmtArg(r))]);
});
pushLog("info", ["TorBox " + App.version + " · " + navigator.userAgent]);

/* ---------------- Teclas ---------------- */
App.K = {
  LEFT:37, UP:38, RIGHT:39, DOWN:40, OK:13,
  BACK:10009, BACK_LG:461, ESC:27, BACKSPACE:8,
  PLAY:415, PAUSE:19, PLAYPAUSE:10252, STOP:413, FF:417, RW:412,
  PREV:10232, NEXT:10233, CHUP:427, CHDOWN:428,
  RED:403, GREEN:404, YELLOW:405, BLUE:406, INFO:457,
  D0:48, D1:49, D2:50, D3:51, D4:52, D5:53, D6:54, D7:55, D8:56, D9:57
};
App.isBack = function(k){
  var K = App.K;
  return k===K.BACK || k===K.BACK_LG || k===K.ESC || k===K.BACKSPACE;
};
App.digit = function(k){ return (k>=48 && k<=57) ? k-48 : (k>=96 && k<=105 ? k-96 : -1); };

/* Registrar teclas del mando (TizenBrew también usa "keys" de package.json). */
App.registerKeys = function(){
  try{
    if(window.tizen && tizen.tvinputdevice){
      ["MediaPlayPause","MediaPlay","MediaPause","MediaStop","MediaRewind","MediaFastForward",
       "MediaTrackPrevious","MediaTrackNext","ChannelUp","ChannelDown",
       "ColorF0Red","ColorF1Green","ColorF2Yellow","ColorF3Blue","Info",
       "0","1","2","3","4","5","6","7","8","9"]
        .forEach(function(k){ try{ tizen.tvinputdevice.registerKey(k); }catch(e){} });
    }
  }catch(e){}
};

/* ---------------- Almacenamiento ---------------- */
var PREFIX = "tb_";
App.store = {
  get: function(key, def){
    try{
      var raw = localStorage.getItem(PREFIX+key);
      return raw === null ? def : JSON.parse(raw);
    }catch(e){ return def; }
  },
  set: function(key, val){
    try{
      if(val === undefined || val === null) localStorage.removeItem(PREFIX+key);
      else localStorage.setItem(PREFIX+key, JSON.stringify(val));
    }catch(e){ /* cuota llena: ignorar */ }
  },
  remove: function(key){ try{ localStorage.removeItem(PREFIX+key); }catch(e){} }
};

/* ---------------- Bus de eventos ---------------- */
var handlers = {};
App.bus = {
  on: function(evt, fn){ (handlers[evt] = handlers[evt] || []).push(fn); },
  off: function(evt, fn){
    var l = handlers[evt]; if(!l) return;
    var i = l.indexOf(fn); if(i >= 0) l.splice(i, 1);
  },
  emit: function(evt, data){
    (handlers[evt] || []).slice().forEach(function(fn){
      try{ fn(data); }catch(e){ console.error("[bus] "+evt, e); }
    });
  }
};

/* ---------------- Registro de pantallas ----------------
 * Vive en core.js para que las pantallas (que cargan antes que main.js) puedan registrarse.
 */
var screenDefs = {}, screenOrder = [];
App.screens = {
  register: function(def){
    if(!def || !def.id) throw new Error("screen sin id");
    screenDefs[def.id] = def;
    if(screenOrder.indexOf(def.id) < 0) screenOrder.push(def.id);
    App.bus.emit("screens:change", def.id);
  },
  get: function(id){ return screenDefs[id]; },
  all: function(){ return screenDefs; },
  navList: function(){
    return screenOrder.map(function(id){ return screenDefs[id]; })
      .filter(function(s){ return s.nav; })
      .sort(function(a, b){ return (a.order || 99) - (b.order || 99); });
  }
};

/* ---------------- Ajustes ---------------- */
var DEFAULTS = {
  torboxToken: "",
  tmdbKey: "",
  defaultSource: "all",          // all | torrents | usenet | webdl
  autoplayNext: true,
  subLang: "spa",                // ISO 639-2 preferido
  audioLang: "spa",
  subSize: "m",                  // s | m | l
  uiLanguage: "en",              // idioma de la interfaz (en | es)
  contentLanguage: "auto",       // idioma de sinopsis/episodios: auto (= interfaz) | en | es
  uiLang: "es-ES",               // OBSOLETO: usar App.i18n.tmdbLang()
  liveListUrl: "https://www.tdtchannels.com/lists/tv.json",
  appIds: {},                    // { tivify: "...", atresplayer: "...", mitele: "..." }
  stremioAddon: "",              // URL del manifest.json de un add-on de Stremio (Torrentio, Comet, AIOStreams…)
  autoPlayBest: true,            // Buscar: OK en episodio/película reproduce la mejor fuente en caché
  prefQuality: "1080p",          // 2160p | 1080p | 720p — calidad preferida para la mejor fuente
  maxSizeGB: 0,                  // 0 = sin límite; tamaño máximo para la mejor fuente
  prefAudio: "es",               // es (castellano) | lat | en | any — idioma preferido en fuentes
  openSubs: true,                // subtítulos de OpenSubtitles (add-on de Stremio) si no hay otros
  notifyReady: true,             // avisar cuando una descarga enviada termine
  hideUnsupported: true,         // ocultar fuentes/archivos con formato que la TV no reproduce
  traktClientId: "",             // app de Trakt del usuario (trakt.tv/oauth/applications)
  traktClientSecret: "",
  traktAuth: null                // {access_token, refresh_token, expires_at}
};
var settings = App.store.get("settings", {});
/* Migración del token de la v1 */
try{
  var legacy = localStorage.getItem("torbox_token");
  if(legacy && !settings.torboxToken){ settings.torboxToken = legacy; App.store.set("settings", settings); }
}catch(e){}

App.settings = {
  define: function(k, def){ if(!(k in DEFAULTS)) DEFAULTS[k] = def; },
  get: function(k){ return (k in settings) ? settings[k] : DEFAULTS[k]; },
  set: function(k, v){
    settings[k] = v; App.store.set("settings", settings);
    App.bus.emit("settings:change", {key:k, value:v});
  },
  all: function(){
    var o = {}, k;
    for(k in DEFAULTS) o[k] = DEFAULTS[k];
    for(k in settings) o[k] = settings[k];
    return o;
  },
  defaults: function(){ var o = {}; for(var k in DEFAULTS) o[k] = DEFAULTS[k]; return o; },
  resetKey: function(k){
    delete settings[k]; App.store.set("settings", settings);
    App.bus.emit("settings:change", {key:k, value:DEFAULTS[k]});
  },
  reset: function(){ settings = {}; App.store.set("settings", settings); App.bus.emit("settings:change", {}); }
};

/* ---------------- Idiomas (i18n) ----------------
 * App.t("modulo.clave", {var}) → texto en el idioma de la interfaz (uiLanguage),
 * con caída a inglés y luego a la propia clave. Cada módulo registra sus textos
 * en app/i18n/<modulo>.js con App.i18n.add("en", {...}) y App.i18n.add("es", {...}).
 * Variables: "Hola {name}" + {name:"Ana"}. Plurales: claves ".one" / ".other" con {n}.
 */
var dicts = {};
App.i18n = {
  LANGS: [
    { code: "en", label: "English", tmdb: "en-US", iso3: "eng" },
    { code: "es", label: "Español", tmdb: "es-ES", iso3: "spa" }
  ],
  add: function(lang, table){
    var d = dicts[lang] = dicts[lang] || {};
    for(var k in table) d[k] = table[k];
  },
  lang: function(){
    var l = App.settings ? App.settings.get("uiLanguage") : "en";
    return dicts[l] ? l : "en";
  },
  /* Idioma del contenido (sinopsis, episodios): "auto" = el de la interfaz */
  contentLang: function(){
    var c = App.settings ? App.settings.get("contentLanguage") : "auto";
    return (!c || c === "auto") ? App.i18n.lang() : c;
  },
  /* Código TMDB (es-ES, en-US…) del idioma de contenido */
  tmdbLang: function(){
    var c = App.i18n.contentLang();
    for(var i = 0; i < App.i18n.LANGS.length; i++) if(App.i18n.LANGS[i].code === c) return App.i18n.LANGS[i].tmdb;
    return "en-US";
  },
  has: function(key){ var d = dicts[App.i18n.lang()]; return !!(d && key in d); }
};
App.t = function(key, vars){
  var l = App.i18n.lang();
  if(vars && typeof vars.n === "number"){
    var pk = key + (vars.n === 1 ? ".one" : ".other");
    if((dicts[l] && pk in dicts[l]) || (dicts.en && pk in dicts.en)) key = pk;
  }
  var s = (dicts[l] && dicts[l][key] !== undefined) ? dicts[l][key] :
          (dicts.en && dicts.en[key] !== undefined) ? dicts.en[key] : key;
  if(vars) s = String(s).replace(/\{(\w+)\}/g, function(m, k){ return vars[k] !== undefined ? vars[k] : m; });
  return s;
};

/* Cambiar el idioma de la interfaz recarga la app (los textos se pintan al montar) */
App.bus.on("settings:change", function(c){
  if(c && (c.key === "uiLanguage" || c.key === "contentLanguage")){
    try{ App.store.remove("metacache"); }catch(e){}
    setTimeout(function(){ location.reload(); }, 300);
  }
});

/* ---------------- Helpers ---------------- */
App.esc = function(s){
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
};
App.fmtSize = function(b){
  if(!b && b !== 0) return "";
  var u = ["B","KB","MB","GB","TB"], i = 0; b = Number(b);
  while(b >= 1024 && i < u.length-1){ b /= 1024; i++; }
  return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + " " + u[i];
};
function pad2(n){ n = String(n); return n.length < 2 ? "0"+n : n; }
App.fmtTime = function(s){
  s = Math.max(0, Math.floor(s || 0));
  var h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60;
  return h ? h+":"+pad2(m)+":"+pad2(x) : m+":"+pad2(x);
};
App.isVideo = function(f){
  var n = String(f.short_name || f.name || "").toLowerCase();
  if(f.mimetype && /^video\//.test(f.mimetype)) return true;
  return /\.(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|mts|flv|wmv|mpg|mpeg)$/.test(n);
};
App.isSubtitle = function(f){
  return /\.(srt|vtt|ass|ssa|sub)$/i.test(String(f.short_name || f.name || ""));
};
App.baseName = function(f){
  var n = String(f.short_name || f.name || "");
  n = n.split("/").pop();
  return n.replace(/\.[^.]+$/, "");
};
App.debounce = function(fn, ms){
  var t;
  return function(){
    var a = arguments, self = this;
    clearTimeout(t); t = setTimeout(function(){ fn.apply(self, a); }, ms);
  };
};
App.isTizen = function(){ return !!(window.tizen || /Tizen/i.test(navigator.userAgent)); };

/* ---------------- Red: proxy CORS ----------------
 * La API de TorBox solo admite CORS desde torbox.app. service.js (serviceFile de
 * TizenBrew) levanta un proxy en 127.0.0.1:8095. App.net.fetch lo usa si responde;
 * si no, intenta directo (por si el runtime de la TV no aplica CORS).
 */
var TV_PROXY = "http://127.0.0.1:8095";
var PROXY = TV_PROXY;
var NEEDS_PROXY = /^https?:\/\/([a-z0-9-]+\.)*(torbox\.app|tb-cdn\.[a-z]+|tb-cdn\.st)(\/|:|$)/i;
var proxyState = null;      // null = sin comprobar, true/false
var proxyCheck = null;
/* Candidatos: si la app la sirve el Cloudflare Worker (u otro host propio), su mismo origen;
 * en la TV / PC local, el servicio de TizenBrew (127.0.0.1:8095). */
function proxyCandidates(){
  var c = [];
  var h = location.hostname;
  if(/^https?:$/.test(location.protocol) && h && h !== "127.0.0.1" && h !== "localhost") c.push(location.origin);
  if(location.protocol !== "https:") c.push(TV_PROXY);
  return c;
}
function ping(base){
  return new Promise(function(resolve){
    var done = false;
    var t = setTimeout(function(){ if(!done){ done = true; resolve(null); } }, 1500);
    fetch(base + "/ping").then(function(r){ return r.json(); }).then(function(j){
      if(done) return; done = true; clearTimeout(t);
      resolve(j && j.ok ? j : null);
    }).catch(function(){ if(done) return; done = true; clearTimeout(t); resolve(null); });
  });
}

App.net = {
  PROXY: PROXY,
  service: "",               // "torbox-tizen" (TV) | "torbox-worker" (nube) | ""
  checkProxy: function(){
    if(proxyCheck) return proxyCheck;
    var cands = proxyCandidates();
    proxyCheck = (function next(i){
      if(i >= cands.length){ proxyState = false; return Promise.resolve(false); }
      return ping(cands[i]).then(function(j){
        if(!j) return next(i + 1);
        PROXY = App.net.PROXY = cands[i];
        App.net.service = j.service || "";
        proxyState = true;
        console.info("[net] proxy: " + PROXY + " (" + App.net.service + ")");
        return true;
      });
    })(0);
    return proxyCheck;
  },
  usingProxy: function(){ return proxyState === true; },
  /* Igual que fetch(url, init), pero enruta por el proxy las URLs de TorBox */
  fetch: function(url, init){
    if(!NEEDS_PROXY.test(url)){
      // Otros dominios (p. ej. CDN de descargas para subtítulos): directo y, si CORS
      // lo bloquea (TypeError), reintento por el proxy si está disponible.
      return fetch(url, init).catch(function(e){
        return App.net.checkProxy().then(function(ok){
          if(!ok) throw e;
          return fetch(PROXY + "/proxy?url=" + encodeURIComponent(url), init);
        });
      });
    }
    return App.net.checkProxy().then(function(ok){
      if(ok) return fetch(PROXY + "/proxy?url=" + encodeURIComponent(url), init);
      return fetch(url, init).catch(function(e){
        var err = new Error(App.t("core.corsBlocked"));
        err.cors = true; err.cause = e;
        throw err;
      });
    });
  }
};

/* ---------------- Hint de cabecera ---------------- */
var hintTimer, hintDefault = "";
App.setHintDefault = function(msg){
  hintDefault = msg || "";
  var el = document.getElementById("hint");
  if(el && !hintTimer) el.textContent = hintDefault;
};
App.hint = function(msg, ms){
  var el = document.getElementById("hint"); if(!el) return;
  el.textContent = msg; el.classList.add("flash");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(function(){
    hintTimer = null; el.classList.remove("flash"); el.textContent = hintDefault;
  }, ms || 3500);
};

})();
