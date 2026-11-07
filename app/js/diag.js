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
