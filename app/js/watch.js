/* watch.js — vigila descargas enviadas a TorBox y avisa cuando terminan.
 * App.watch.track({hash, name, title, meta, playOpts})
 * App.watch.onKey(k) → bool   (main.js lo consulta antes que la pantalla actual)
 * Emite 'watch:ready' {entry, item}.
 */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var KEY = "watch";
var MAX = 20;
var TTL = 48 * 3600 * 1000;
var INTERVAL = 30000;
var NOTICE_MS = 20000;

var timer = null, busy = false;
var queue = [];          // avisos pendientes {entry, item}
var current = null;      // aviso visible
var noticeEl = null, noticeT = null;

function load(){
  var l = App.store.get(KEY, []);
  if(!Array.isArray(l)) l = [];
  var now = Date.now();
  return l.filter(function(e){ return e && now - (e.at || 0) < TTL; });
}
function save(l){ App.store.set(KEY, l.slice(-MAX)); }
function norm(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function track(o){
  if(!o || (!o.hash && !o.name)) return;
  var l = load();
  var hash = o.hash ? String(o.hash).toLowerCase() : "";
  l = l.filter(function(e){ return !(hash && e.hash === hash) && !(!hash && o.name && e.name === o.name); });
  l.push({ hash: hash, name: o.name || "", title: o.title || o.name || "", meta: o.meta || {},
           playOpts: o.playOpts || null, at: Date.now() });
  save(l);
  App.ui.toast(App.t("watch.tracking"));
  schedule(5000);
}

function schedule(ms){
  clearTimeout(timer);
  timer = setTimeout(check, ms || INTERVAL);
}

function finished(item){
  if(App.torbox.isFinished) return App.torbox.isFinished(item);
  return item && item.download_finished === true;
}

function check(){
  timer = null;
  var l = load();
  save(l);
  if(!l.length) return;
  if(App.settings.get("notifyReady") === false || !App.torbox.hasToken()){ schedule(); return; }
  if(busy){ schedule(); return; }
  busy = true;
  var needAll = l.some(function(e){ return !e.hash; });
  var sources = needAll ? App.torbox.SOURCES : App.torbox.SOURCES.filter(function(x){ return x === "torrents" || x === "rd"; });
  Promise.all(sources.map(function(src){
    return App.torbox.list(src, { all: true, fresh: true }).catch(function(){ return []; });
  })).then(function(lists){
    var items = [];
    lists.forEach(function(x){ items = items.concat(x || []); });
    var remaining = [];
    l.forEach(function(e){
      var it = null;
      for(var i = 0; i < items.length && !it; i++){
        var x = items[i];
        if(e.hash && x.hash && String(x.hash).toLowerCase() === e.hash) it = x;
        else if(!e.hash && e.name && norm(x.name) === norm(e.name)) it = x;
      }
      if(it && finished(it) && it.files && it.files.length) ready(e, it);
      else remaining.push(e);
    });
    save(remaining);
  }).catch(function(e){
    console.warn("[watch] " + e.message);
  }).then(function(){
    busy = false;
    if(load().length) schedule();
  });
}

function ready(entry, item){
  console.info("[watch] listo: " + (entry.title || entry.name));
  App.torbox.invalidate();
  App.bus.emit("watch:ready", { entry: entry, item: item });
  App.ui.toast(App.t("watch.toast", { title: entry.title || item.name }), 5000);
  if(App.notify && typeof App.notify.send === "function"){
    try{ App.notify.send(App.t("watch.notifyTitle"), App.t("watch.notifyBody", { title: entry.title || item.name })); }catch(e){}
  }
  queue.push({ entry: entry, item: item });
  showNext();
}

/* ---- Aviso no modal ---- */
function showNext(){
  if(current || !queue.length) return;
  if(App.player && App.player.isActive && App.player.isActive()) return; // se muestra al cerrar
  current = queue.shift();
  if(!noticeEl){
    noticeEl = document.createElement("div");
    noticeEl.className = "watch-notice";
    document.body.appendChild(noticeEl);
  }
  var title = current.entry.title || current.item.name || "";
  noticeEl.innerHTML =
    '<div class="watch-check">✓</div>' +
    '<div class="watch-text"><div class="watch-title">' + App.esc(App.t("watch.ready", { title: title })) + '</div>' +
    '<div class="watch-keys">' + App.esc(App.t("watch.keys")) + '</div></div>';
  noticeEl.classList.add("on");
  clearTimeout(noticeT);
  noticeT = setTimeout(dismiss, NOTICE_MS);
}
function dismiss(){
  clearTimeout(noticeT);
  if(noticeEl) noticeEl.classList.remove("on");
  current = null;
  setTimeout(showNext, 400);
}

function openCurrent(){
  var c = current;
  dismiss();
  if(!c) return;
  var item = c.item, e = c.entry;
  var src = item._source || "torrents";
  var vids = (item.files || []).filter(function(f){ return App.isVideo(f); });
  if(vids.length === 1){
    var f = vids[0];
    App.ui.toast(App.t("watch.opening", { title: e.title || item.name }));
    App.torbox.link(src, item.id, f.id).then(function(url){
      var meta = {};
      var m = e.meta || {};
      for(var k in m) meta[k] = m[k];
      meta.source = src; meta.itemId = item.id; meta.fileId = f.id;
      meta.filename = f.short_name || f.name;
      var opts = { title: e.title || item.name, url: url, key: App.torbox.key(src, item.id, f.id), meta: meta };
      if(meta.season !== undefined && meta.episode !== undefined && meta.season !== null){
        opts.subtitle = "S" + meta.season + "·E" + meta.episode;
      }
      if(e.playOpts){ for(var p in e.playOpts) if(opts[p] === undefined) opts[p] = e.playOpts[p]; }
      App.player.play(opts);
    }).catch(function(err){ App.hint(App.t("watch.playFailed", { msg: err.message })); });
    return;
  }
  if(App.screens.get("files")) App.go("files", { item: item, source: src });
  else App.section("library");
}

function onKey(k){
  if(!current) return false;
  if(k === K.OK){ openCurrent(); return true; }
  if(App.isBack(k)){ dismiss(); return true; }
  return false;
}

App.bus.on("player:close", function(){ setTimeout(showNext, 600); });
App.bus.on("app:ready", function(){ if(load().length) schedule(8000); });

App.watch = {
  track: track,
  onKey: onKey,
  isShowing: function(){ return !!current; },
  pending: function(){ return load(); },
  checkNow: function(){ schedule(10); }
};

})();
