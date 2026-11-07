/* screens/settings.js — pantalla de Ajustes (textos en app/i18n/settings.js). */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var S = App.settings;
var t = App.t;

var PKG_URL = "https://cdn.jsdelivr.net/gh/Umberghost/torbox-tizen/package.json";
var VER_CACHE_MS = 3600000;

/* Ajustes que se pueden restablecer con ROJO (los valores salen de core.js) */
var RESETTABLE = ["defaultSource", "autoplayNext", "subLang", "audioLang", "subSize", "liveListUrl",
  "uiLanguage", "contentLanguage", "autoPlayBest", "prefQuality", "maxSizeGB", "prefAudio",
  "hideUnsupported", "openSubs", "notifyReady"];
var APPS = [
  { id: "tivify", label: "Tivify" },
  { id: "atresplayer", label: "Atresplayer" },
  { id: "mitele", label: "Mitele / Mediaset Infinity" }
];

function trackLangs(){
  return [
    { label: t("settings.lang.spa"), value: "spa" },
    { label: t("settings.lang.eng"), value: "eng" },
    { label: t("settings.lang.none"), value: "" }
  ];
}
function mask(v){
  v = String(v || "");
  if(!v) return t("settings.notSet");
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "••••••" + v.slice(-4);
}
function labelOf(list, v){
  for(var i = 0; i < list.length; i++) if(list[i].value === v) return list[i].label;
  return v === "" ? "—" : String(v);
}
function appId(id){ var m = S.get("appIds") || {}; return m[id] || ""; }
function setAppId(id, v){
  var m = Object.assign({}, S.get("appIds") || {});
  if(v) m[id] = v; else delete m[id];
  S.set("appIds", m);
}

/* ---------- Versión nueva disponible ---------- */
function cmpVer(a, b){
  var pa = String(a || "0").split("."), pb = String(b || "0").split(".");
  for(var i = 0; i < Math.max(pa.length, pb.length); i++){
    var x = parseInt(pa[i] || "0", 10) || 0, y = parseInt(pb[i] || "0", 10) || 0;
    if(x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
var verState = { checked: 0, latest: null };
function checkVersion(){
  if(Date.now() - verState.checked < VER_CACHE_MS) return;
  verState.checked = Date.now();
  App.net.fetch(PKG_URL + "?t=" + Math.floor(Date.now() / VER_CACHE_MS)).then(function(r){ return r.json(); }).then(function(j){
    if(j && j.version){ verState.latest = String(j.version); if(App.current() === "settings" && s.grid) render(); }
  }).catch(function(e){ console.warn("[settings] version check failed:", e.message); });
}

/* ---------- Diagnóstico ---------- */
function showDiag(){
  var av = false;
  try{ av = !!(window.webapis && webapis.avplay); }catch(e){}
  var url = App.remote && App.remote.url ? App.remote.url() : "";
  var logs = (App.logs ? App.logs(0) : []).filter(function(e){ return e.l === "warn" || e.l === "error"; }).slice(-15);
  var rowsHtml = [
    [t("settings.diag.version"), App.version],
    [t("settings.diag.engine"), av ? t("settings.diag.avplayYes") : t("settings.diag.avplayNo")],
    [t("settings.diag.proxy"), App.net.usingProxy() ? t("settings.diag.on") : t("settings.diag.off")],
    [t("settings.diag.remote"), url || "—"],
    [t("settings.diag.lang"), App.i18n.lang() + " / " + App.i18n.contentLang()],
    [t("settings.diag.ua"), navigator.userAgent]
  ].map(function(r){
    return '<div class="set-diag-row"><b>' + App.esc(r[0]) + '</b><span>' + App.esc(r[1]) + '</span></div>';
  }).join("");
  var logHtml = logs.length ? logs.map(function(e){
    var d = new Date(e.t);
    return '<div class="set-diag-log ' + (e.l === "error" ? "e" : "w") + '">' +
      App.esc(d.toLocaleTimeString() + " " + e.m) + '</div>';
  }).join("") : '<div class="muted">' + App.esc(t("settings.diag.noLogs")) + '</div>';
  App.ui.modal({
    title: t("settings.diag.title"), wide: true,
    html: '<div class="set-diag">' + rowsHtml + '</div>' +
      '<div class="set-diag-sub">' + App.esc(t("settings.diag.recent")) + '</div>' +
      '<div class="set-diag-logs">' + logHtml + '</div>',
    buttons: [{ label: t("ui.close"), value: true }]
  });
}

/* ---------- Trakt ---------- */
function traktValue(){
  if(!App.trakt) return t("settings.trakt.unavailable");
  try{
    var st = App.trakt.status ? App.trakt.status() : null;
    if(st && typeof st === "object") return st.linked ? (st.user ? t("settings.trakt.linkedAs", {user: st.user}) : t("settings.trakt.linked")) : t("settings.trakt.notLinked");
    if(typeof st === "string") return st;
    return App.trakt.isLinked && App.trakt.isLinked() ? t("settings.trakt.linked") : t("settings.trakt.notLinked");
  }catch(e){ return "—"; }
}
function traktAction(){
  if(!App.trakt){ App.ui.toast(t("settings.trakt.unavailable")); return; }
  var linked = App.trakt.isLinked && App.trakt.isLinked();
  if(linked){
    return App.ui.confirm(t("settings.trakt.unlinkTitle"), "", t("settings.trakt.unlink"), t("ui.cancel")).then(function(y){
      if(y && App.trakt.unlink){ var p = App.trakt.unlink(); if(p && p.then) return p; }
    });
  }
  if(App.trakt.link){ var p = App.trakt.link(); if(p && p.then) return p; }
}

/* Definición de filas. type: secret | text | menu | bool | action | appid */
function rows(){
  var langOpts = App.i18n.LANGS.map(function(l){ return { label: l.label, value: l.code }; });
  var r = [
    { group: t("settings.group.account") },
    { id: "torboxToken", type: "secret", label: t("settings.torboxToken"),
      desc: t("settings.torboxToken.desc"),
      value: function(){ return mask(S.get("torboxToken")); },
      after: function(){ App.torbox.invalidate(); } },
    { id: "tmdbKey", type: "secret", label: t("settings.tmdbKey"),
      desc: t("settings.tmdbKey.desc"),
      value: function(){ return mask(S.get("tmdbKey")); },
      after: function(){ App.bus.emit("meta:keychange"); } },

    { group: t("settings.group.language") },
    { id: "uiLanguage", type: "menu", label: t("settings.uiLanguage"), desc: t("settings.uiLanguage.desc"),
      options: langOpts },
    { id: "contentLanguage", type: "menu", label: t("settings.contentLanguage"), desc: t("settings.contentLanguage.desc"),
      options: [{ label: t("settings.contentLanguage.auto"), value: "auto" }].concat(langOpts) },

    { group: t("settings.group.search") },
    { id: "stremioAddon", type: "text", label: t("settings.stremioAddon"),
      desc: t("settings.stremioAddon.desc"),
      value: function(){ var v = S.get("stremioAddon") || ""; return v ? v.replace(/^https?:\/\//, "").slice(0, 28) + "…" : t("settings.notSet"); } },
    { id: "autoPlayBest", type: "bool", label: t("settings.autoPlayBest"), desc: t("settings.autoPlayBest.desc") },
    { id: "prefQuality", type: "menu", label: t("settings.prefQuality"), desc: t("settings.prefQuality.desc"),
      options: [{ label: "4K (2160p)", value: "2160p" }, { label: "1080p", value: "1080p" }, { label: "720p", value: "720p" }] },
    { id: "maxSizeGB", type: "menu", label: t("settings.maxSizeGB"), desc: t("settings.maxSizeGB.desc"),
      options: [{ label: t("settings.maxSizeGB.none"), value: 0 }, { label: "2 GB", value: 2 }, { label: "4 GB", value: 4 },
                { label: "8 GB", value: 8 }, { label: "15 GB", value: 15 }, { label: "30 GB", value: 30 }] },
    { id: "prefAudio", type: "menu", label: t("settings.prefAudio"), desc: t("settings.prefAudio.desc"),
      options: [{ label: t("settings.prefAudio.es"), value: "es" }, { label: t("settings.prefAudio.lat"), value: "lat" },
                { label: t("settings.prefAudio.en"), value: "en" }, { label: t("settings.prefAudio.any"), value: "any" }] },
    { id: "hideUnsupported", type: "bool", label: t("settings.hideUnsupported"), desc: t("settings.hideUnsupported.desc") },
    { id: "forgetFormats", type: "action", label: t("settings.forgetFormats"), desc: t("settings.forgetFormats.desc"),
      run: function(){ if(App.caps && App.caps.forget) App.caps.forget(); App.ui.toast(t("settings.forgetFormats.done")); } },

    { group: t("settings.group.library") },
    { id: "defaultSource", type: "menu", label: t("settings.defaultSource"),
      desc: t("settings.defaultSource.desc"),
      options: [{ label: t("settings.source.all"), value: "all" }, { label: "Torrents", value: "torrents" },
                { label: "Usenet", value: "usenet" }, { label: "Web", value: "webdl" }] },

    { group: t("settings.group.playback") },
    { id: "autoplayNext", type: "bool", label: t("settings.autoplayNext"), desc: t("settings.autoplayNext.desc") },
    { id: "subLang", type: "menu", label: t("settings.subLang"), desc: t("settings.subLang.desc"), options: trackLangs() },
    { id: "audioLang", type: "menu", label: t("settings.audioLang"), desc: t("settings.audioLang.desc"), options: trackLangs() },
    { id: "subSize", type: "menu", label: t("settings.subSize"), desc: "",
      options: [{ label: t("settings.subSize.s"), value: "s" }, { label: t("settings.subSize.m"), value: "m" },
                { label: t("settings.subSize.l"), value: "l" }] },
    { id: "openSubs", type: "bool", label: t("settings.openSubs"), desc: t("settings.openSubs.desc") },
    { id: "notifyReady", type: "bool", label: t("settings.notifyReady"), desc: t("settings.notifyReady.desc") },

    { group: "Trakt" },
    { id: "traktLink", type: "action", label: t("settings.trakt.link"), desc: t("settings.trakt.link.desc"),
      value: traktValue, run: traktAction },
    { id: "traktClientId", type: "secret", label: t("settings.traktClientId"), desc: t("settings.traktClientId.desc"),
      value: function(){ return mask(S.get("traktClientId")); } },
    { id: "traktClientSecret", type: "secret", label: t("settings.traktClientSecret"), desc: "",
      value: function(){ return mask(S.get("traktClientSecret")); } },

    { group: t("settings.group.live") },
    { id: "liveListUrl", type: "text", label: t("settings.liveListUrl"),
      desc: t("settings.liveListUrl.desc"),
      value: function(){ return S.get("liveListUrl"); },
      after: function(){ App.store.remove("live_cache"); } }
  ];
  APPS.forEach(function(a){
    r.push({ id: "app:" + a.id, type: "appid", app: a, label: t("settings.appId", {app: a.label}),
      desc: t("settings.appId.desc"),
      value: function(){ return appId(a.id) || t("settings.appId.auto"); } });
  });
  r.push(
    { group: t("settings.group.data") },
    { id: "diagnostics", type: "action", label: t("settings.diag.title"), desc: t("settings.diag.desc"), run: showDiag },
    { id: "clearHistory", type: "action", label: t("settings.clearHistory"),
      desc: t("settings.clearHistory.desc"),
      run: function(){
        return App.ui.confirm(t("settings.clearHistory.confirm"), t("settings.clearHistory.confirmText"), t("settings.delete"), t("ui.cancel")).then(function(y){
          if(!y) return;
          if(App.history && App.history.clear) App.history.clear();
          else App.store.remove("history");
          App.bus.emit("history:change");
          App.ui.toast(t("settings.clearHistory.done"));
        });
      } },
    { id: "clearMeta", type: "action", label: t("settings.clearMeta"), desc: "",
      run: function(){ if(App.meta && App.meta.clearCache) App.meta.clearCache(); else App.store.remove("metacache"); App.bus.emit("meta:keychange"); App.ui.toast(t("settings.clearMeta.done")); } },
    { id: "clearLive", type: "action", label: t("settings.clearLive"), desc: "",
      run: function(){ App.store.remove("live_cache"); App.ui.toast(t("settings.clearLive.done")); } },
    { id: "logout", type: "action", label: t("settings.logout"), desc: t("settings.logout.desc"), danger: true,
      run: function(){
        return App.ui.confirm(t("settings.logout.confirm"), t("settings.logout.confirmText"), t("settings.logout"), t("ui.cancel")).then(function(y){
          if(!y) return;
          S.set("torboxToken", "");
          App.torbox.invalidate();
          App.openSetup();
        });
      } }
  );
  return r;
}

function valueText(row){
  if(row.value) return row.value();
  if(row.type === "bool") return S.get(row.id) ? t("ui.yes") : t("ui.no");
  if(row.type === "menu") return labelOf(row.options, S.get(row.id));
  if(row.type === "action") return "›";
  return String(S.get(row.id) || "");
}

var s = { el: null, grid: null, rows: [] };

function render(){
  var idx = s.grid ? s.grid.index : 0;
  s.rows = rows();
  var html = '<div class="scroll set">';
  s.rows.forEach(function(row, i){
    if(row.group){ html += '<div class="section-title set-group">' + App.esc(row.group) + '</div>'; return; }
    var v = valueText(row);
    html += '<div class="row set-row focusable' + (row.danger ? ' set-danger' : '') + '" data-i="' + i + '">' +
      '<div class="set-text"><div class="set-label">' + App.esc(row.label) + '</div>' +
        (row.desc ? '<div class="set-desc">' + App.esc(row.desc) + '</div>' : '') + '</div>' +
      (row.type === "bool"
        ? '<span class="set-toggle' + (S.get(row.id) ? ' on' : '') + '"><i></i></span>'
        : '<div class="set-value">' + App.esc(v) + '</div>') +
    '</div>';
  });
  var newer = verState.latest && cmpVer(App.version, verState.latest) < 0;
  html += '<div class="set-footer">' +
    '<div>' + App.esc(t("settings.footer", {v: App.version})) +
      (newer ? ' <span class="set-new">' + App.esc(t("settings.newVersion", {v: verState.latest})) + '</span>' : '') + '</div>' +
    '<div class="legend"><span><i class="yellow"></i>' + App.esc(t("settings.legend.search")) + '</span>' +
      '<span><i class="blue"></i>' + App.esc(t("settings.legend.settings")) + '</span>' +
      '<span><i class="red"></i>' + App.esc(t("settings.legend.reset")) + '</span></div>' +
    '</div></div>';
  var sc = s.el.querySelector(".scroll"), top = sc ? sc.scrollTop : 0;
  s.el.innerHTML = html;
  sc = s.el.querySelector(".scroll"); if(sc) sc.scrollTop = top;
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect });
  s.grid.index = Math.min(idx, s.grid.items.length - 1); s.grid.paint();
  if(document.body.classList.contains("zone-header")) s.grid.blur();
}

function rowAt(el){ return s.rows[Number(el.getAttribute("data-i"))]; }

function edit(row){
  if(row.type === "bool"){ S.set(row.id, !S.get(row.id)); render(); return; }
  if(row.type === "menu"){
    var cur = S.get(row.id);
    App.ui.menu(row.label, row.options.map(function(o){
      return { label: o.label, value: o.value, selected: o.value === cur };
    })).then(function(v){
      if(v === null || v === cur) return;
      S.set(row.id, v); if(row.after) row.after(); render();
    });
    return;
  }
  if(row.type === "secret" || row.type === "text"){
    App.ui.keyboard.open({
      title: row.label, value: S.get(row.id) || "", secret: row.type === "secret",
      placeholder: row.type === "secret" ? t("settings.keyPlaceholder") : "",
      onDone: function(v){
        v = String(v || "").trim();
        if(row.id === "torboxToken" && !v){ App.ui.toast(t("settings.keyEmpty")); return; }
        S.set(row.id, v); if(row.after) row.after(); render();
        App.ui.toast(t("settings.saved"));
      }
    });
    return;
  }
  if(row.type === "appid"){
    App.ui.menu(row.label, [
      { label: t("settings.appId.edit"), value: "edit" },
      { label: t("settings.appId.detect"), value: "auto" },
      { label: t("ui.cancel"), value: null }
    ]).then(function(v){
      if(v === "auto"){ setAppId(row.app.id, ""); render(); App.ui.toast(t("settings.appId.detectDone")); }
      else if(v === "edit"){
        App.ui.keyboard.open({
          title: t("settings.appId", {app: row.app.label}), value: appId(row.app.id), placeholder: t("settings.appId.placeholder"),
          onDone: function(val){ setAppId(row.app.id, String(val || "").trim()); render(); }
        });
      }
    });
    return;
  }
  if(row.type === "action"){
    var p = row.run();
    if(p && p.then) p.then(render); else render();
  }
}

function onSelect(i, el){ var row = rowAt(el); if(row) edit(row); }

App.screens.register({
  id: "settings", label: t("nav.settings"), nav: true, order: 60,
  get hint(){ return t("settings.hint"); },
  mount: function(el){
    s.el = el;
    App.bus.on("settings:change", function(){ if(App.current() === "settings" && s.grid) render(); });
  },
  show: function(){ render(); checkVersion(); },
  focus: function(){ if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  onKey: function(k){
    if(k === K.RED){
      var cur = s.grid && s.grid.current(), row = cur && rowAt(cur);
      if(row && RESETTABLE.indexOf(row.id) >= 0){ S.resetKey(row.id); if(row.after) row.after(); render(); App.ui.toast(t("settings.resetDone")); }
      else if(row && row.type === "appid"){ setAppId(row.app.id, ""); render(); App.ui.toast(t("settings.resetDone")); }
      return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
