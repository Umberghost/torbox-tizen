/* follow.js — seguir series + descarga automática de episodios nuevos.
 * App.follow = { list, isFollowing, toggle, upcoming, check }
 *   list() → [{imdbId, name, poster, since}]
 *   toggle({imdbId, name, poster}) → boolean (true = ahora se sigue)
 *   upcoming() → Promise<[{imdbId, name, poster, season, episode, title, released}]>  (±14 días)
 *   check(manual) → Promise<n>  episodios añadidos (el motor lo lanza cada 6 h si followAuto)
 * Emite 'follow:change' y 'follow:added' {show, season, episode}.
 * Textos en app/i18n/search.js (claves "follow.*" y "search.follow.*").
 */
(function(){
"use strict";

var App = window.App;
var t = function(k, v){ return App.t(k, v); };

var KEY = "follow", DONE = "followDone", LAST = "followLast";
var EVERY = 6 * 3600000;          // motor cada 6 h
var WINDOW = 14 * 86400000;       // ventana de episodios recientes / próximos
var GRACE = 2 * 86400000;         // episodio emitido hasta 2 días antes de seguir también cuenta
var busy = false;

if(App.settings.define) App.settings.define("followAuto", true);

function load(){ var l = App.store.get(KEY, []); return Array.isArray(l) ? l : []; }
function save(l){ App.store.set(KEY, l); App.bus.emit("follow:change", { list: l }); }
function pad2(n){ n = String(n); return n.length < 2 ? "0" + n : n; }

function indexOf(l, id){
  for(var i = 0; i < l.length; i++) if(l[i].imdbId === id) return i;
  return -1;
}

function list(){ return load(); }
function isFollowing(id){ return indexOf(load(), id) >= 0; }

function toggle(o){
  if(!o || !o.imdbId) return false;
  var l = load(), i = indexOf(l, o.imdbId);
  if(i >= 0){ l.splice(i, 1); save(l); return false; }
  l.push({ imdbId: o.imdbId, name: o.name || "", poster: o.poster || "", since: Date.now() });
  save(l);
  // al empezar a seguir, comprobar pronto por si ya hay un episodio nuevo
  setTimeout(function(){ if(App.settings.get("followAuto")) check(false); }, 4000);
  return true;
}

function metaOf(id){
  if(!App.meta || typeof App.meta.title !== "function") return Promise.resolve(null);
  return Promise.resolve().then(function(){ return App.meta.title("series", id); }).catch(function(){ return null; });
}
function ts(v){ var x = Date.parse(v.released || ""); return isNaN(x) ? 0 : x; }
function epValid(v){ return v && Number(v.season) > 0 && v.episode !== undefined && v.episode !== null && !isNaN(Number(v.episode)); }

function upcoming(){
  var now = Date.now();
  return Promise.all(load().map(function(sh){
    return metaOf(sh.imdbId).then(function(m){
      if(!m) return [];
      return (m.videos || []).filter(function(v){
        var x = ts(v);
        return epValid(v) && x && x >= now - WINDOW && x <= now + WINDOW;
      }).map(function(v){
        return { imdbId: sh.imdbId, name: sh.name || m.name || "", poster: sh.poster || m.poster || "",
                 season: Number(v.season), episode: Number(v.episode), title: v.name || "", released: v.released };
      });
    });
  })).then(function(all){
    var out = [];
    all.forEach(function(a){ out = out.concat(a); });
    return out.sort(function(a, b){ return Date.parse(a.released) - Date.parse(b.released); });
  });
}

/* ---------------- Motor de descarga automática ---------------- */

function doneMap(){ var d = App.store.get(DONE, {}); return d && typeof d === "object" ? d : {}; }
function markDone(key){
  var d = doneMap(), now = Date.now();
  d[key] = now;
  Object.keys(d).forEach(function(k){ if(now - d[k] > 60 * 86400000) delete d[k]; });   // limpiar antiguos
  App.store.set(DONE, d);
}

function announce(show, v, cached, title){
  var msg = t("follow.autoAdded", { title: title });
  App.ui.toast(msg, 6000);
  if(App.notify && typeof App.notify.send === "function"){
    try{ App.notify.send(t("follow.notifyTitle"), title + (cached ? "" : " · " + t("follow.downloading"))); }catch(e){}
  }
  App.bus.emit("follow:added", { show: show, season: Number(v.season), episode: Number(v.episode) });
}

/* Procesa un episodio: true si se añadió a TorBox, false si aún no hay fuente */
function processEpisode(show, m, v){
  var S = Number(v.season), E = Number(v.episode);
  var key = show.imdbId + ":" + S + ":" + E;
  var sid = key;
  return App.search.fetchStreams("series", sid, true).then(function(r){
    var pick = App.search.bestStream(r.visible);
    var cached = !!pick;
    if(!pick || !pick.hash){ pick = App.search.bestDownload ? App.search.bestDownload(r.visible) : null; cached = false; }
    if(!pick || !pick.hash){ console.info("[follow] sin fuente todavía:", key); return false; }
    var name = pick.filename || pick.release || (show.name + " S" + pad2(S) + "E" + pad2(E));
    var magnet = "magnet:?xt=urn:btih:" + pick.hash + "&dn=" + encodeURIComponent(name);
    var title = t("follow.epTitle", { name: show.name || m.name || "", s: pad2(S), e: pad2(E) });
    return App.torbox.addMagnet(magnet, name).then(function(){
      App.torbox.invalidate();
      markDone(key);
      if(!cached && App.watch && typeof App.watch.track === "function"){
        App.watch.track({ hash: pick.hash, name: name, title: title,
                          meta: { type: "series", imdbId: show.imdbId, season: S, episode: E } });
      }
      announce(show, v, cached, title);
      return true;
    });
  }).catch(function(e){ console.warn("[follow] " + key + ":", e && e.message); return false; });
}

function checkShow(show){
  return metaOf(show.imdbId).then(function(m){
    if(!m) return 0;
    var now = Date.now(), done = doneMap();
    var eps = (m.videos || []).filter(function(v){
      var x = ts(v);
      return epValid(v) && x && x <= now && x >= now - WINDOW && x >= (show.since || 0) - GRACE &&
             !done[show.imdbId + ":" + Number(v.season) + ":" + Number(v.episode)];
    }).sort(function(a, b){ return ts(a) - ts(b); });
    var added = 0;
    return eps.reduce(function(p, v){
      return p.then(function(){ return processEpisode(show, m, v).then(function(ok){ if(ok) added++; }); });
    }, Promise.resolve()).then(function(){ return added; });
  });
}

function check(manual){
  if(busy) return Promise.resolve(0);
  var l = load();
  if(!l.length || !App.search || !App.torbox || !App.torbox.hasToken() || !App.search.addons || !App.search.addons().length){
    return Promise.resolve(0);
  }
  busy = true;
  var total = 0;
  return l.reduce(function(p, show){
    return p.then(function(){ return checkShow(show).then(function(n){ total += n; }).catch(function(e){ console.warn("[follow]", e && e.message); }); });
  }, Promise.resolve()).then(function(){
    busy = false;
    App.store.set(LAST, Date.now());
    return total;
  }, function(){ busy = false; return total; });
}

function tick(){
  if(!App.settings.get("followAuto")) return;
  var last = Number(App.store.get(LAST, 0)) || 0;
  if(Date.now() - last < EVERY) return;
  check(false);
}
setTimeout(tick, 45000);               // tras el arranque
setInterval(tick, 30 * 60000);         // y revisa cada 30 min si ya toca (cada 6 h efectivas)

App.follow = { list: list, isFollowing: isFollowing, toggle: toggle, upcoming: upcoming, check: check };

/* ---------------- Ajustes ---------------- */

function manageFollowed(){
  var l = load();
  if(!l.length){ App.ui.toast(t("follow.listEmpty"), 3500); return; }
  App.ui.menu(t("follow.menuTitle"), l.map(function(sh){ return { label: sh.name || sh.imdbId, value: sh.imdbId }; })).then(function(id){
    if(!id) return;
    var sh = l[indexOf(l, id)];
    App.ui.confirm(t("follow.unfollowTitle", { name: sh ? sh.name : id }), t("follow.unfollowText"), t("follow.unfollow"), t("ui.cancel"))
      .then(function(ok){ if(ok){ toggle({ imdbId: id }); App.ui.toast(t("search.follow.removed", { name: sh ? sh.name : "" }), 3000); } });
  });
}

if(App.settingsUI){
  App.settingsUI.add("settings.group.search", { id: "followAuto", type: "bool",
    label: function(){ return t("follow.auto"); }, desc: function(){ return t("follow.auto.desc"); } });
  App.settingsUI.add("settings.group.search", { id: "followList", type: "action",
    label: function(){ return t("follow.list") + " (" + load().length + ")"; }, desc: function(){ return t("follow.list.desc"); },
    run: manageFollowed });
  App.settingsUI.add("settings.group.search", { id: "followNow", type: "action",
    label: function(){ return t("follow.now"); }, desc: function(){ return t("follow.now.desc"); },
    run: function(){
      App.ui.toast(t("follow.checking"), 2500);
      check(true).then(function(n){
        App.ui.toast(n ? t("follow.nowDone", { n: n }) : t("follow.nothing"), 4000);
      });
    } });
}

})();
