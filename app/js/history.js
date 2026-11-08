/* history.js — historial de reproducción para "Continuar viendo". */
(function(){
"use strict";

var App = window.App;
var KEY = "history";
var MAX = 300;
var WATCHED_AT = 0.9;

var data = App.store.get(KEY, {});
if(!data || typeof data !== "object") data = {};

var persist = App.debounce(function(){ App.store.set(KEY, data); }, 400);

function purge(){
  var keys = Object.keys(data);
  if(keys.length <= MAX) return;
  keys.sort(function(a, b){ return (data[a].updated || 0) - (data[b].updated || 0); });
  keys.slice(0, keys.length - MAX).forEach(function(k){ delete data[k]; });
}

/* Quitar deja una marca {removed:true, updated} en vez de borrar: así el sync de Cuenta Faro
 * (que fusiona por entrada y gana la más reciente) no vuelve a traer lo quitado desde otro dispositivo. */
function live(e){ return e && !e.removed ? e : null; }

function changed(key){
  persist();
  App.bus.emit("history:change", { key: key });
}

App.history = {
  get: function(key){ return live(data[key]); },

  /* {unfinished:true} → solo empezadas y no vistas. Ordenado por más reciente. */
  list: function(opts){
    opts = opts || {};
    var out = Object.keys(data).map(function(k){ return data[k]; }).filter(live);
    if(opts.unfinished){
      out = out.filter(function(e){
        return !e.watched && e.pos > 30 && e.key.indexOf("live:") !== 0;
      });
    }
    out.sort(function(a, b){ return (b.updated || 0) - (a.updated || 0); });
    return out;
  },

  save: function(entry){
    if(!entry || !entry.key) return;
    var prev = live(data[entry.key]) || {};
    var e = {
      key: entry.key,
      pos: entry.pos !== undefined ? entry.pos : (prev.pos || 0),
      dur: entry.dur || prev.dur || 0,
      updated: Date.now(),
      title: entry.title || prev.title || "",
      subtitle: entry.subtitle !== undefined ? entry.subtitle : (prev.subtitle || ""),
      poster: entry.poster || prev.poster || "",
      watched: entry.watched !== undefined ? entry.watched : !!prev.watched,
      meta: entry.meta || prev.meta || {}
    };
    if(e.dur > 0 && e.pos / e.dur >= WATCHED_AT) e.watched = true;
    data[entry.key] = e;
    purge();
    changed(entry.key);
    return e;
  },

  markWatched: function(key){
    var e = live(data[key]); if(!e) return;
    e.watched = true; e.pos = e.dur || e.pos; e.updated = Date.now();
    changed(key);
  },

  remove: function(key){
    if(!live(data[key])) return;
    data[key] = { key: key, removed: true, updated: Date.now() };
    changed(key);
  },

  isWatched: function(key){ var e = live(data[key]); return !!(e && e.watched); },

  progress: function(key){
    var e = live(data[key]);
    if(!e) return 0;
    if(e.watched) return 1;
    return e.dur > 0 ? Math.max(0, Math.min(1, e.pos / e.dur)) : 0;
  },

  /* Entrada que llega de otro dispositivo (sync/copia): se aplica solo si es más reciente; respeta las marcas de quitado. */
  applyRemote: function(r){
    if(!r || !r.key) return false;
    var cur = data[r.key];
    if(cur && (cur.updated || 0) >= (r.updated || 0)) return false;
    if(r.removed){
      if(!cur) return false;
      data[r.key] = { key: r.key, removed: true, updated: r.updated || Date.now() };
    }else{
      data[r.key] = {
        key: r.key, pos: r.pos || 0, dur: r.dur || 0, updated: r.updated || Date.now(),
        title: r.title || "", subtitle: r.subtitle || "", poster: r.poster || "",
        watched: !!r.watched, meta: r.meta || {}
      };
    }
    purge();
    changed(r.key);
    return true;
  },

  clear: function(){
    var now = Date.now();
    Object.keys(data).forEach(function(k){ data[k] = { key: k, removed: true, updated: now }; });
    changed(null);
  }
};

})();
