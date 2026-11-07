/* diag.js — diagnóstico de la plataforma al arrancar (sale en el Registro de la web del móvil).
 * Objetivo principal: averiguar si AVPlay (webapis) está disponible dentro de TizenBrew
 * y, si no, intentar cargar webapis.js desde rutas conocidas del sistema.
 */
(function(){
"use strict";
var App = window.App;

function keys(o, n){
  try{ return Object.keys(o).slice(0, n || 40).join(","); }catch(e){ return "?"; }
}
function hasAv(){ try{ return !!(window.webapis && webapis.avplay && typeof webapis.avplay.open === "function"); }catch(e){ return false; } }

/* Rutas candidatas de webapis.js (en apps empaquetadas $WEBAPIS lo resuelve la TV) */
var CANDIDATES = [
  "file:///usr/share/webapis/webapis/webapis.js",
  "file:///usr/share/wrt/webapis/webapis/webapis.js",
  "file:///usr/apps/webapis/webapis/webapis.js",
  "/webapis/webapis.js"
];

function tryLoad(list, done){
  if(hasAv() || !list.length){ done(); return; }
  var src = list[0];
  var s = document.createElement("script");
  var t = setTimeout(function(){ s.onload = s.onerror = null; console.info("[diag] webapis " + src + " → timeout"); tryLoad(list.slice(1), done); }, 3000);
  s.onload = function(){ clearTimeout(t); console.info("[diag] webapis " + src + " → cargado · avplay=" + hasAv()); tryLoad(list.slice(1), done); };
  s.onerror = function(){ clearTimeout(t); console.info("[diag] webapis " + src + " → error"); tryLoad(list.slice(1), done); };
  s.src = src;
  document.head.appendChild(s);
}

function run(){
  var info = [];
  info.push("url=" + location.href);
  info.push("referrer=" + (document.referrer || "-"));
  info.push("tizen=" + (typeof window.tizen) + (window.tizen ? " [" + keys(window.tizen, 60) + "]" : ""));
  info.push("webapis=" + (typeof window.webapis) + (window.webapis ? " [" + keys(window.webapis) + "]" : ""));
  info.push("xwalk=" + (typeof window.xwalk) + " extension=" + (typeof window.extension));
  var scr = Array.prototype.map.call(document.scripts, function(s){ return s.src; }).filter(function(x){ return /webapis/i.test(x); });
  info.push("scripts webapis=" + (scr.join(" | ") || "-"));
  try{ if(window.tizen && tizen.systeminfo) info.push("plataforma=" + tizen.systeminfo.getCapability("http://tizen.org/feature/platform.version")); }catch(e){ info.push("plataforma=? " + e.message); }
  try{ if(window.tizen && tizen.application) info.push("appId=" + tizen.application.getCurrentApplication().appInfo.id); }catch(e){}
  console.info("[diag] " + info.join(" · "));
  console.info("[diag] avplay disponible al arrancar: " + hasAv());
  if(!hasAv()){
    tryLoad(CANDIDATES.slice(), function(){
      console.info("[diag] avplay disponible tras probar rutas: " + hasAv() +
        (hasAv() ? "" : " → se usará <video> (sin MKV/HEVC). Plan B: app empaquetada."));
    });
  }
  // Códecs que dice soportar <video>
  try{
    var v = document.createElement("video");
    var tests = { "mp4 h264": 'video/mp4; codecs="avc1.640028"', "mp4 hevc": 'video/mp4; codecs="hvc1.1.6.L120.90"',
                  "mkv": "video/x-matroska", "webm vp9": 'video/webm; codecs="vp9"', "hls": "application/vnd.apple.mpegurl" };
    var res = Object.keys(tests).map(function(k){ return k + "=" + (v.canPlayType(tests[k]) || "no"); });
    console.info("[diag] <video> canPlayType: " + res.join(", "));
  }catch(e){}
}

App.bus.on("app:ready", function(){ setTimeout(run, 500); });
})();

/* ================= App.caps — ¿puede la TV reproducir este archivo? =================
 * check(nombre) → {ok, reasons:[claves i18n], info:{container, video, audio, dv, hdr}}
 * learnFail(nombre) apunta la combinación que falló (MEDIA_ERR_4 / error de códec) y la oculta en adelante.
 */
(function(){
"use strict";
var App = window.App;
var LEARN_KEY = "badFormats";

function parse(name){
  var n = String(name || "").toLowerCase();
  var ext = (n.match(/\.([a-z0-9]{2,4})(\?|$)/) || [])[1] || "";
  var container = /^(mkv|mp4|m4v|avi|wmv|ts|m2ts|mov|webm|flv|iso|rar|zip|mpg|mpeg)$/.test(ext) ? ext :
                  (/\bbdmv\b|\bblu-?ray\.?iso\b|\biso\b/.test(n) ? "iso" : "");
  var video = /\b(hevc|x\.?265|h\.?265)\b/.test(n) ? "hevc" : /\b(av1)\b/.test(n) ? "av1" :
              /\b(x\.?264|h\.?264|avc)\b/.test(n) ? "h264" : /\b(xvid|divx)\b/.test(n) ? "xvid" :
              /\bvp9\b/.test(n) ? "vp9" : "";
  var audio = /\btrue-?hd\b|\batmos\b.*\btruehd\b/.test(n) ? "truehd" :
              /\bdts(-?hd|-?x|-?ma)?\b/.test(n) ? "dts" :
              /\b(e-?ac-?3|ddp|dd\+|dd5\.1\+)\b/.test(n) ? "eac3" :
              /\b(ac-?3|dd5\.?1|dd2\.?0|\bdd\b)\b/.test(n) ? "ac3" :
              /\baac\b/.test(n) ? "aac" : /\bflac\b/.test(n) ? "flac" : /\bopus\b/.test(n) ? "opus" : "";
  var dv = /\b(dv|dovi|dolby\.?vision)\b/.test(n);
  var hdr = /\bhdr(10)?(\+|plus)?\b/.test(n);
  return { container: container, video: video, audio: audio, dv: dv, hdr: hdr };
}
function sig(i){ return [i.container || "?", i.video || "?", i.audio || "?"].join("+"); }
function avplay(){ try{ return !!(window.webapis && webapis.avplay); }catch(e){ return false; } }

App.caps = {
  parse: parse,
  check: function(name){
    var i = parse(name), r = [];
    if(i.container === "iso" || i.container === "rar" || i.container === "zip") r.push("caps.disc");
    if(i.audio === "dts") r.push("caps.dts");
    if(i.audio === "truehd") r.push("caps.truehd");
    if(i.dv && !i.hdr) r.push("caps.dv");
    if(!avplay()){
      if(/^(avi|wmv|flv|mpg|mpeg)$/.test(i.container) || i.video === "xvid") r.push("caps.oldFormat");
    }
    var learned = App.store.get(LEARN_KEY, {});
    if(learned[sig(i)] && sig(i) !== "?+?+?") r.push("caps.learned");
    return { ok: !r.length, reasons: r, info: i };
  },
  learnFail: function(name){
    var i = parse(name), s = sig(i);
    if(s === "?+?+?") return;
    var learned = App.store.get(LEARN_KEY, {});
    learned[s] = Date.now();
    App.store.set(LEARN_KEY, learned);
    console.info("[caps] formato marcado como no compatible: " + s);
  },
  forget: function(){ App.store.remove(LEARN_KEY); },
  hideUnsupported: function(){ return App.settings.get("hideUnsupported") !== false; }
};
})();
