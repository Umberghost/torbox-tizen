/* screens/downloads.js — todas las descargas (las 3 fuentes) con progreso y acciones. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var tb = App.torbox;
var t = App.t;
var REFRESH_MS = 5000;

var HIDE_KEY = "dlHideDone";
var CLEARED_KEY = "dlCleared";   // completadas quitadas de la lista (siguen en TorBox y en la Biblioteca)
var s = { el: null, grid: null, items: null, error: "", timer: null, visible: false, busy: false, focusKey: null,
          hideDone: !!App.store.get(HIDE_KEY, false), cleared: App.store.get(CLEARED_KEY, []) || [] };
function isCleared(d){ return s.cleared.indexOf(itemKey(d)) >= 0; }

function prog(d){
  var p = Number(d.progress || 0);
  if(p > 1) p = p / 100;
  if(tb.isFinished(d)) p = 1;
  return Math.max(0, Math.min(1, p));
}

/* → {label, cls} */
function status(d){
  var st = String(d.download_state || d.state || "").toLowerCase();
  if(/error|fail|invalid|missing|stalled.*\(no/.test(st) && !/completed/.test(st)){
    if(/stalled/.test(st)) return { label: t("downloads.st.noSources"), cls: "warn", key: "stalled" };
    return { label: t("downloads.st.error"), cls: "err", key: "error" };
  }
  if(/paused/.test(st)) return { label: t("downloads.st.paused"), cls: "muted", key: "paused" };
  if(/cached/.test(st)) return { label: t("downloads.st.cached"), cls: "ok", key: "done" };
  if(/upload|seed/.test(st)) return { label: t("downloads.st.seeding"), cls: "ok", key: "done" };
  if(/queue|pending|waiting|checking|meta/.test(st)) return { label: t("downloads.st.queued"), cls: "muted", key: "queued" };
  if(tb.isFinished(d) || /completed|finished/.test(st)) return { label: t("downloads.st.done"), cls: "ok", key: "done" };
  if(/download|stalled/.test(st)) return { label: /stalled/.test(st) ? t("downloads.st.stalled") : t("downloads.st.downloading"), cls: "act", key: "downloading" };
  return { label: st ? st.charAt(0).toUpperCase() + st.slice(1) : t("downloads.st.unknown"), cls: "muted", key: "other" };
}

function fmtSpeed(b){ b = Number(b || 0); return b > 0 ? App.fmtSize(b) + "/s" : ""; }
function fmtEta(sec){
  sec = Number(sec || 0);
  if(!(sec > 0) || sec > 86400 * 30) return "";
  if(sec >= 3600) return t("downloads.eta.h", {h: Math.floor(sec / 3600), m: Math.floor(sec % 3600 / 60)});
  if(sec >= 60) return t("downloads.eta.m", {m: Math.floor(sec / 60)});
  return t("downloads.eta.s", {s: Math.round(sec)});
}
function itemKey(d){ return d._source + ":" + d.id; }

/* Título bonito: App.parse + App.meta (solo caché; la consulta a TMDB se hace tras pintar) */
function parsedOf(d){ return App.parse ? App.parse.name(d.name || "") : { title: d.name || "", year: null, season: null, episode: null, type: "movie" }; }
function prettyTitle(d){
  var p = parsedOf(d);
  if(!p.title) return d.name || "";
  var m = App.meta && App.meta.peek ? App.meta.peek({ title: p.title, year: p.year, type: p.type }) : null;
  var base = m && m.title ? m.title : p.title;
  if(p.type === "tv"){
    if(p.season) base += " · " + (p.episode ? t("downloads.pretty.ep", { s: p.season, e: (p.episode < 10 ? "0" : "") + p.episode }) : t("downloads.pretty.season", { s: p.season }));
  } else {
    var y = (m && m.year) || p.year;
    if(y) base += " (" + y + ")";
  }
  return base;
}
var asked = {};
function lookupPretty(list){
  if(!App.meta || !App.meta.hasKey || !App.meta.hasKey()) return;
  list.forEach(function(d){
    var p = parsedOf(d), nk = p.type + ":" + p.title + ":" + p.year;
    if(!p.title || asked[nk]) return;
    if(App.meta.peek({ title: p.title, year: p.year, type: p.type }) !== undefined) return;
    asked[nk] = true;
    App.meta.lookup({ title: p.title, year: p.year, type: p.type }).then(function(){
      if(!s.visible) return;
      Array.prototype.forEach.call(s.el.querySelectorAll(".dl-row"), function(row){
        var dd = findItem(row.getAttribute("data-k"));
        var el = row.querySelector(".dl-title");
        if(dd && el) el.textContent = prettyTitle(dd);
      });
    });
  });
}

function load(silent){
  if(s.busy) return;
  s.busy = true;
  if(!silent && !s.items) App.ui.loading(s.el, t("downloads.loading"));
  Promise.all(tb.SOURCES.map(function(src){
    return tb.list(src, { all: true, fresh: true }).then(function(l){ return { ok: true, l: l }; })
      .catch(function(e){ return { ok: false, e: e, l: [] }; });
  })).then(function(res){
    s.busy = false;
    if(!s.visible) return;
    var all = [], errs = res.filter(function(r){ return !r.ok; });
    res.forEach(function(r){ all = all.concat(r.l.filter(Boolean)); });
    if(errs.length === res.length){ s.error = errs[0].e.message; s.items = null; }
    else {
      s.error = "";
      s.items = sortItems(all);
      // Purgar de dlCleared lo que ya no existe en TorBox (solo si cargaron las 3 fuentes)
      if(!errs.length && s.cleared.length){
        var live = {};
        all.forEach(function(d){ live[itemKey(d)] = true; });
        var kept = s.cleared.filter(function(k){ return live[k]; });
        if(kept.length !== s.cleared.length){ s.cleared = kept; App.store.set(CLEARED_KEY, kept); }
      }
    }
    render();
  });
}

function sortItems(list){
  var rank = { downloading: 0, stalled: 1, queued: 2, paused: 3, error: 4, other: 5, done: 6 };
  return list.sort(function(a, b){
    var ra = rank[status(a).key], rb = rank[status(b).key];
    if(ra !== rb) return ra - rb;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

function render(){
  if(s.grid && s.grid.current()) s.focusKey = s.grid.current().getAttribute("data-k");
  if(s.error && !s.items){
    s.el.innerHTML = '<div class="center err"><h2>' + App.esc(t("downloads.loadError")) + '</h2><p>' + App.esc(s.error) +
                     '</p><div class="btn focusable" data-k="retry">' + App.esc(t("ui.retry")) + '</div></div>';
  } else if(!s.items || !s.items.length){
    s.el.innerHTML = '<div class="center"><h2>' + App.esc(t("downloads.empty")) + '</h2><p>' + App.esc(t("downloads.emptyText")) + '</p></div>';
  } else {
    var visible = s.items.filter(function(d){ return !isCleared(d); });
    var active = visible.filter(function(d){ return status(d).key !== "done"; }).length;
    var doneCount = visible.length - active;
    var clearedCount = s.items.length - visible.length;
    var shown = s.hideDone ? visible.filter(function(d){ return status(d).key !== "done"; }) : visible;
    var html = '<div class="scroll dl">' +
      '<div class="section-title">' + App.esc(t("downloads.count", {n: visible.length})) + '<span class="muted">' +
        App.esc(active ? t("downloads.active", {n: active}) : t("downloads.allDone")) + '</span></div>' +
      /* Barra de acciones: enfocable con el D-pad (▲ desde la primera descarga) */
      '<div class="chips dl-actions">' +
        '<div class="chip dl-toggle focusable' + (s.hideDone ? ' active' : '') + '" data-k="toggleDone">' +
          '<span class="dl-check">' + (s.hideDone ? '☑' : '☐') + '</span> ' + App.esc(t("downloads.hideDone")) + '</div>' +
        (doneCount ? '<div class="chip focusable" data-k="clearDone">✓ ' + App.esc(t("downloads.clearDone", {n: doneCount})) + '</div>' : '') +
        (clearedCount ? '<div class="chip dl-small focusable" data-k="showCleared">' + App.esc(t("downloads.showCleared", {n: clearedCount})) + '</div>' : '') +
        (s.hideDone && doneCount ? '<span class="dl-hidden muted">' + App.esc(t("downloads.hiddenCount", {n: doneCount})) + '</span>' : '') +
      '</div>';
    if(!shown.length) html += '<div class="dl-none muted">' + App.esc(t(visible.length ? "downloads.noneActive" : "downloads.noneVisible")) + '</div>';
    shown.forEach(function(d){
      var st = status(d), p = prog(d);
      var extra = [];
      if(st.key === "downloading"){
        var sp = fmtSpeed(d.download_speed), eta = fmtEta(d.eta);
        if(sp) extra.push("↓ " + sp);
        if(eta) extra.push(t("downloads.left", {eta: eta}));
        if(d.seeds !== undefined && d._source === "torrents") extra.push(t("downloads.seeds", {n: d.seeds}));
      }
      var nFiles = (d.files || []).length;
      var pretty = prettyTitle(d);
      html += '<div class="row dl-row focusable" data-k="' + App.esc(itemKey(d)) + '">' +
        '<div class="dl-main">' +
          '<div class="dl-line"><div class="title dl-title">' + App.esc(pretty || d.name || t("downloads.noName")) + '</div>' +
            '<span class="dl-status dl-' + st.cls + '">' + st.label + '</span></div>' +
          (pretty && pretty !== d.name ? '<div class="dl-release">' + App.esc(d.name || "") + '</div>' : '') +
          '<div class="progress dl-bar"><i style="width:' + (p * 100).toFixed(1) + '%"></i></div>' +
          '<div class="dl-sub num">' +
            '<span class="dl-src">' + App.esc(tb.SOURCE_LABEL[d._source] || d._source) + '</span>' +
            '<span>' + Math.round(p * 100) + ' %</span>' +
            '<span>' + App.fmtSize(d.size) + '</span>' +
            (nFiles ? '<span>' + App.esc(t("downloads.files", {n: nFiles})) + '</span>' : '') +
            extra.map(function(x){ return '<span>' + App.esc(x) + '</span>'; }).join("") +
          '</div>' +
        '</div></div>';
    });
    html += '<div class="legend dl-legend"><span><i class="red"></i>' + App.esc(t("downloads.delete")) + '</span><span><i class="green"></i>' + App.esc(t("downloads.refresh")) + '</span><span>' + App.esc(t("downloads.okOptions")) + '</span></div>';
    html += '</div>';
    setTimeout(function(){ lookupPretty(shown); }, 0);
    var scrollTop = 0, sc = s.el.querySelector(".scroll");
    if(sc) scrollTop = sc.scrollTop;
    s.el.innerHTML = html;
    sc = s.el.querySelector(".scroll"); if(sc) sc.scrollTop = scrollTop;
  }
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect });
  var idx = 0;
  if(s.focusKey){
    s.grid.items.forEach(function(el, i){ if(el.getAttribute("data-k") === s.focusKey) idx = i; });
  }
  s.grid.index = idx; s.grid.paint();
  if(document.body.classList.contains("zone-header") || App.ui.isModalOpen()) s.grid.blur();
}

function findItem(key){
  if(!s.items) return null;
  for(var i = 0; i < s.items.length; i++) if(itemKey(s.items[i]) === key) return s.items[i];
  return null;
}

function playItem(d){
  var vids = (d.files || []).filter(App.isVideo);
  if(!vids.length){ App.ui.toast(t("downloads.noVideo")); return; }
  var choose = vids.length === 1 ? Promise.resolve(vids[0]) :
    App.ui.menu(t("downloads.chooseFile"), vids.map(function(f){
      return { label: (f.short_name || f.name) + "  ·  " + App.fmtSize(f.size), value: f };
    }));
  choose.then(function(f){
    if(!f) return;
    App.ui.toast(t("downloads.preparing"));
    tb.link(d._source, d.id, f.id).then(function(url){
      if(!App.player){ App.ui.toast(t("downloads.noPlayer")); return; }
      App.player.play({
        title: App.baseName(f), subtitle: d.name, url: url,
        key: tb.key(d._source, d.id, f.id),
        meta: { source: d._source, itemId: d.id, fileId: f.id }
      });
    }).catch(function(e){ App.ui.toast(t("downloads.errorMsg", {msg: e.message}), 5000); });
  });
}

function remove(d){
  App.ui.confirm(t("downloads.deleteConfirm"), d.name, t("downloads.delete"), t("ui.cancel")).then(function(yes){
    if(!yes) return;
    tb.control(d._source, d.id, "delete").then(function(){
      App.ui.toast(t("downloads.deleted"));
      s.items = s.items.filter(function(x){ return x !== d; });
      render(); load(true);
    }).catch(function(e){ App.ui.toast(t("downloads.deleteError", {msg: e.message}), 5000); });
  });
}

/* "Limpiar completados": SOLO las quita de esta lista (no borra nada de TorBox) */
function clearDone(){
  if(!s.items) return;
  var keys = s.items.filter(function(d){ return status(d).key === "done" && !isCleared(d); }).map(itemKey);
  if(!keys.length){ App.ui.toast(t("downloads.noneDone")); return; }
  s.cleared = s.cleared.concat(keys);
  App.store.set(CLEARED_KEY, s.cleared);
  App.ui.toast(t("downloads.clearedToast", {n: keys.length}), 3500);
  render();
}
function showCleared(){
  s.cleared = [];
  App.store.set(CLEARED_KEY, []);
  App.ui.toast(t("downloads.shownAgain"));
  render();
}

function onSelect(i, el){
  var key = el.getAttribute("data-k");
  if(key === "retry"){ s.items = null; load(); return; }
  if(key === "toggleDone"){ s.hideDone = !s.hideDone; App.store.set(HIDE_KEY, s.hideDone); render(); return; }
  if(key === "clearDone"){ clearDone(); return; }
  if(key === "showCleared"){ showCleared(); return; }
  var d = findItem(key); if(!d) return;
  var acts = itemActions(d).concat(globalActions());
  var opts = acts.map(function(a, i){ return { label: a.label, value: i }; });
  opts.push({ label: t("ui.cancel"), value: null });
  App.ui.menu(prettyTitle(d) || d.name || t("downloads.item"), opts).then(function(v){
    if(v === null || v === undefined) return;
    acts[v].run();
  });
}

function controlOp(d, v){
  tb.control(d._source, d.id, v).then(function(){
    App.ui.toast(v === "pause" ? t("downloads.paused") : v === "resume" ? t("downloads.resumed") : t("downloads.doneMsg"));
    load(true);
  }).catch(function(e){ App.ui.toast(t("downloads.errorMsg", {msg: e.message}), 5000); });
}

/* Acciones de un elemento (las usan el menú OK y actions() de A1) */
function itemActions(d){
  var st = status(d), out = [];
  if(st.key === "done" && (d.files || []).some(App.isVideo)) out.push({ label: "▶ " + t("downloads.play"), run: function(){ playItem(d); } });
  if(d._source !== "webdl" && st.key !== "done"){
    if(st.key === "paused") out.push({ label: t("downloads.resume"), run: function(){ controlOp(d, "resume"); } });
    else out.push({ label: t("downloads.pause"), run: function(){ controlOp(d, "pause"); } });
  }
  if(d._source === "torrents" && (st.key === "stalled" || st.key === "downloading")){
    out.push({ label: t("downloads.reannounce"), run: function(){ controlOp(d, "reannounce"); } });
    if(d.hash) out.push({ label: t("downloads.moreTrackers"), run: function(){ retryTrackers(d); } });
  }
  out.push({ label: t("downloads.delete"), run: function(){ remove(d); } });
  return out;
}
/* Acciones de la lista (ocultar/limpiar completados, actualizar) */
function globalActions(){
  var out = [];
  out.push({ label: t(s.hideDone ? "downloads.act.showDone" : "downloads.act.hideDone"), run: function(){
    s.hideDone = !s.hideDone; App.store.set(HIDE_KEY, s.hideDone); render(); } });
  if(s.items && s.items.some(function(d){ return status(d).key === "done" && !isCleared(d); }))
    out.push({ label: t("downloads.act.clearDone"), run: clearDone });
  if(s.cleared.length) out.push({ label: t("downloads.act.showCleared"), run: showCleared });
  out.push({ label: t("downloads.refresh"), run: function(){ App.ui.toast(t("downloads.refreshing"), 1200); load(true); } });
  return out;
}

/* Volver a añadir el torrent atascado con una lista amplia de trackers públicos (ngosang/trackerslist) */
var TRACKERS_URL = "https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt";
function retryTrackers(d){
  App.ui.confirm(t("downloads.moreTrackers"), t("downloads.moreTrackersText"), t("downloads.moreTrackersGo"), t("ui.cancel"))
    .then(function(ok){
      if(!ok) return;
      App.ui.toast(t("downloads.moreTrackersWorking"), 2500);
      App.net.fetch(TRACKERS_URL).then(function(r){ return r.text(); }).catch(function(){ return ""; }).then(function(txt){
        var trs = String(txt || "").split(/\s+/).filter(function(x){ return /^(udp|https?|wss?):\/\//i.test(x); }).slice(0, 60);
        var magnet = "magnet:?xt=urn:btih:" + d.hash + (d.name ? "&dn=" + encodeURIComponent(d.name) : "") +
          trs.map(function(x){ return "&tr=" + encodeURIComponent(x); }).join("");
        console.info("[downloads] reintento con " + trs.length + " trackers: " + d.name);
        return tb.control(d._source, d.id, "delete").then(function(){
          return tb.addMagnet(magnet, d.name || undefined);
        });
      }).then(function(){
        App.ui.toast(t("downloads.moreTrackersDone"), 5000);
        load(true);
      }).catch(function(e){
        App.ui.toast(t("downloads.errorMsg", {msg: e.message}), 5000);
        load(true);
      });
    });
}

function startTimer(){
  stopTimer();
  s.timer = setInterval(function(){
    if(s.visible && !App.ui.isModalOpen() && !(App.player && App.player.isActive && App.player.isActive())) load(true);
  }, REFRESH_MS);
}
function stopTimer(){ if(s.timer){ clearInterval(s.timer); s.timer = null; } }

App.screens.register({
  id: "downloads", label: t("nav.downloads"), nav: true, order: 50,
  get hint(){ return t("downloads.hint"); },
  mount: function(el){ s.el = el; },
  show: function(){ s.visible = true; load(false); startTimer(); },
  hide: function(){ s.visible = false; stopTimer(); },
  focus: function(){ if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  actions: function(){
    var cur = s.grid && s.grid.current();
    var d = cur && findItem(cur.getAttribute("data-k"));
    return (d ? itemActions(d) : []).concat(globalActions());
  },
  onKey: function(k){
    if(k === K.GREEN){ App.ui.toast(t("downloads.refreshing"), 1200); load(true); return true; }
    if(k === K.RED){
      var cur = s.grid && s.grid.current();
      var d = cur && findItem(cur.getAttribute("data-k"));
      if(d) remove(d);
      return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
