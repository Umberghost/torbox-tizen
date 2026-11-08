/* transcode.js — versión convertida por el servicio (HLS) para reproducir en el navegador.
 * El <video> del navegador no abre bien MKV con audio AC3/DTS, ni deja elegir pistas de audio o ver
 * subtítulos incrustados. TorBox (/stream/createstream) y Real-Debrid (/streaming/transcode) convierten
 * el archivo en sus servidores a HLS. Solo se usa sin AVPlay (PC/móvil); en la tele no cambia nada.
 * Si algo falla, el reproductor sigue con el archivo original. */
(function(){
"use strict";

var App = window.App;
var t = function(k, p){ return App.t(k, p); };
var TB_TYPE = { torrents: "torrent", usenet: "usenet", webdl: "webdownload" };
var VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i;
var BROWSER_OK_RE = /\.(mp4|m4v|webm|mov)$/i;

App.settings.define("browserTranscode", "auto");

function mode(){ return App.settings.get("browserTranscode") || "auto"; }
function hasAvplay(){ return !!(App.player && App.player.hasAvplay && App.player.hasAvplay()); }

function fileName(o){
  var m = (o && o.meta) || {};
  var n = m.filename || m.fileName || "";
  if(!n && o && o.url){ try{ n = decodeURIComponent(String(o.url).split("?")[0].split("/").pop() || ""); }catch(e){} }
  return n;
}

/* ¿Se puede intentar? (servicio y datos suficientes) */
function possible(o){
  if(!o || o.live || hasAvplay() || mode() === "off") return false;
  var m = o.meta || {};
  if(TB_TYPE[m.source] && m.itemId !== undefined && m.fileId !== undefined) return App.torbox.hasToken();
  if(m.source === "rd") return !!(App.torbox.rdTranscode && App.settings.get("rdToken"));
  if(m.source === "stremio" && m.hash) return App.torbox.hasToken() && (!m.svc || m.svc === "TB");
  return false;
}

/* ¿Conviene usarla de entrada? auto = archivos que el navegador no suele abrir bien (MKV, AVI…) */
function wanted(o){
  if(!possible(o)) return false;
  if(o._tcForce || mode() === "always") return true;
  var n = fileName(o);
  return !n || !BROWSER_OK_RE.test(n);
}

function langOf(a){ return String((a && (a.language || a.lang)) || "").toLowerCase().slice(0, 2); }
function trackLabel(a, i){
  var lang = (a && (a.language_full || a.languageFull || a.language)) || "";
  var parts = [];
  if(a && a.title && String(a.title).toLowerCase() !== String(lang).toLowerCase()) parts.push(a.title);
  if(lang) parts.unshift(lang.charAt(0).toUpperCase() + lang.slice(1));
  if(a && a.codec) parts.push(String(a.codec).toUpperCase() + (a.channels ? " " + a.channels + "ch" : ""));
  return parts.join(" · ") || ("#" + (i + 1));
}

/* ---------- TorBox ---------- */
function videoFiles(item){
  return (item.files || []).filter(function(f){ return VIDEO_RE.test(f.short_name || f.name || ""); });
}
function pickFile(item, m){
  var files = item.files || [], want = String(m.filename || "").toLowerCase(), f = null;
  if(want) f = files.filter(function(x){
    var n = String(x.short_name || x.name || "").toLowerCase();
    return n === want || n.slice(-want.length) === want;
  })[0];
  if(!f && m.fileIdx !== undefined && m.fileIdx !== null) f = files.filter(function(x){ return String(x.id) === String(m.fileIdx); })[0];
  if(!f){
    var v = videoFiles(item).sort(function(a, b){ return (b.size || 0) - (a.size || 0); });
    f = v[0] || null;
  }
  return f;
}
/* Fuente de un add-on (Torrentio/Comet con TorBox): localizar el torrent por hash en la cuenta;
 * si no está, añadirlo (si está en caché de TorBox es instantáneo). */
function tbIdsFromHash(m){
  var hash = String(m.hash).toLowerCase();
  function find(fresh){
    return App.torbox.list("torrents", { all: true, fresh: fresh }).then(function(list){
      return list.filter(function(d){ return d && String(d.hash || "").toLowerCase() === hash; })[0] || null;
    });
  }
  return find(false).then(function(it){ return it || find(true); }).then(function(it){
    if(it) return it;
    var mag = "magnet:?xt=urn:btih:" + hash;
    return (App.torbox.addMagnetTo ? App.torbox.addMagnetTo("TB", mag) : App.torbox.addMagnet(mag)).then(function(){
      return new Promise(function(r){ setTimeout(r, 1500); });
    }).then(function(){ return find(true); });
  }).then(function(it){
    if(!it || !it.files || !it.files.length) throw new Error("torrent sin archivos todavía");
    var f = pickFile(it, m);
    if(!f) throw new Error("sin archivo de vídeo");
    return { id: it.id, fileId: f.id, type: "torrent" };
  });
}
function tbIds(o){
  var m = o.meta || {};
  if(TB_TYPE[m.source]) return Promise.resolve({ id: m.itemId, fileId: m.fileId, type: TB_TYPE[m.source] });
  return tbIdsFromHash(m);
}
function tbCreate(ids, audio, sub){
  var q = "/stream/createstream?id=" + encodeURIComponent(ids.id) + "&file_id=" + encodeURIComponent(ids.fileId) +
          "&type=" + encodeURIComponent(ids.type) + "&chosen_audio_index=" + (audio || 0) +
          (sub !== null && sub !== undefined ? "&chosen_subtitle_index=" + sub : "");
  return App.torbox.api(q).then(function(j){
    var d = j.data || j;
    if(!d || !d.hls_url) throw new Error("sin hls_url");
    return d;
  });
}
function tbSession(o){
  return tbIds(o).then(function(ids){
    return tbCreate(ids, 0, null).then(function(d){
      var md = d.metadata || {};
      var audios = (md.audios || []).map(function(a, i){ return { index: i, lang: langOf(a), label: trackLabel(a, i) }; });
      var subs = (md.subtitles || []).map(function(s, i){ return { index: i, lang: langOf(s), label: trackLabel(s, i) }; });
      var s = {
        kind: "tb", label: "TorBox", url: d.hls_url, audios: audios, subs: subs, audio: 0, sub: null,
        select: function(audio, sub){
          return tbCreate(ids, audio, sub).then(function(d2){ s.audio = audio; s.sub = sub; s.url = d2.hls_url; return d2.hls_url; });
        }
      };
      // Audio en el idioma preferido (Ajustes → Reproducción) si no es la primera pista
      var pref = String(App.settings.get("audioLang") || "").toLowerCase().slice(0, 2);
      var want = pref ? audios.filter(function(a){ return a.lang === pref; })[0] : null;
      if(want && want.index !== 0) return s.select(want.index, null).then(function(){ return s; }, function(){ return s; });
      return s;
    });
  });
}

/* ---------- Real-Debrid ---------- */
function rdSession(o){
  return App.torbox.rdTranscode(o.url).then(function(url){
    // Las pistas de audio van dentro del HLS: las lista hls.js (menú Audio normal)
    return { kind: "rd", label: "Real-Debrid", url: url, audios: [], subs: [], audio: 0, sub: null, select: null };
  });
}

function withTimeout(p, ms){
  return new Promise(function(resolve, reject){
    var to = setTimeout(function(){ reject(new Error("timeout")); }, ms);
    p.then(function(v){ clearTimeout(to); resolve(v); }, function(e){ clearTimeout(to); reject(e); });
  });
}

function prepare(o){
  var m = o.meta || {};
  var p = m.source === "rd" ? rdSession(o) : tbSession(o);
  return withTimeout(p, 25000).then(function(s){
    console.info("[transcode] " + s.kind + " HLS listo (" + s.audios.length + " audios, " + s.subs.length + " subs)");
    return s;
  }).catch(function(e){
    console.warn("[transcode] no disponible: " + (e && e.message));
    return null;
  });
}

App.transcode = { possible: possible, wanted: wanted, prepare: prepare, mode: mode };

if(App.settingsUI){
  App.settingsUI.add("settings.group.player", { id: "browserTranscode", type: "menu",
    label: function(){ return t("tc.set"); }, desc: function(){ return t("tc.set.desc"); },
    options: function(){ return [
      { label: t("tc.opt.auto"), value: "auto" }, { label: t("tc.opt.always"), value: "always" }, { label: t("tc.opt.off"), value: "off" }
    ]; } });
}

})();
