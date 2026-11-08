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

/* ---------- Estado de la cuenta TorBox (solo lectura) ---------- */
var acct = { data: null, usage: null, error: "", loading: false, at: 0 };
function fetchAccount(force){
  if(!hasTB() || !App.torbox.hasToken()){ acct.data = null; return; }
  if(acct.loading || (!force && Date.now() - acct.at < 300000 && acct.data)) return;
  acct.loading = true; acct.error = "";
  App.torbox.api("/user/me?settings=false").then(function(j){
    acct.data = j.data || {}; acct.at = Date.now();
    return Promise.all(App.torbox.SOURCES.map(function(src){
      return App.torbox.list(src, { all: true }).catch(function(){ return []; });
    })).then(function(l){
      var n = 0, size = 0, active = 0;
      l.forEach(function(arr){ arr.forEach(function(d){
        n++; size += Number(d.size || 0);
        if(!App.torbox.isFinished(d)) active++;
      }); });
      acct.usage = { n: n, size: size, active: active };
    });
  }).catch(function(e){ acct.error = e.message || "error"; console.warn("[settings] user/me", acct.error); })
    .then(function(){ acct.loading = false; if(App.current() === "settings" && s.grid) render(); });
}
function hasTB(){
  if(App.debrid && App.debrid.hasTorbox) return !!App.debrid.hasTorbox();
  return App.torbox.hasToken();
}
function hasRDacc(){ return !!(App.debrid && App.debrid.hasRD && App.debrid.hasRD()); }
var rdAcct = { data: null, error: "", loading: false, at: 0 };
function fetchRD(force){
  if(!hasRDacc() || !App.debrid.rdAccount){ rdAcct.data = null; return; }
  if(rdAcct.loading || (!force && Date.now() - rdAcct.at < 300000 && rdAcct.data)) return;
  rdAcct.loading = true; rdAcct.error = "";
  Promise.resolve(App.debrid.rdAccount()).then(function(d){ rdAcct.data = d || {}; rdAcct.at = Date.now(); })
    .catch(function(e){ rdAcct.error = (e && e.message) || "error"; console.warn("[settings] rdAccount", rdAcct.error); })
    .then(function(){ rdAcct.loading = false; if(App.current() === "settings" && s.grid) render(); });
}
function fmtDate(v){
  var d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(App.i18n.lang() === "es" ? "es-ES" : "en-GB");
}
function planName(p){
  if(p === undefined || p === null) return "—";
  var k = "settings.acct.plan." + p, v = t(k);
  return v === k ? t("settings.acct.planN", { n: p }) : v;
}
function acctExpiry(d){
  if(!d || !d.premium_expires_at) return "";
  var ms = Date.parse(d.premium_expires_at);
  if(isNaN(ms)) return "";
  var days = Math.ceil((ms - Date.now()) / 86400000);
  return days >= 0 ? t("settings.acct.expires", { date: fmtDate(ms), n: days }) : t("settings.acct.expired", { date: fmtDate(ms) });
}
function acctValue(){
  if(!App.torbox.hasToken()) return t("settings.notSet");
  if(acct.error && !acct.data) return t("settings.acct.error");
  if(!acct.data) return t("settings.acct.loading");
  var parts = [planName(acct.data.plan)], e = acctExpiry(acct.data);
  if(e) parts.push(e);
  return parts.join(" · ");
}
function acctDesc(){
  var d = acct.data, parts = [];
  if(d && d.additional_concurrent_slots !== undefined) parts.push(t("settings.acct.slots", { n: d.additional_concurrent_slots }));
  if(acct.usage) parts.push(t("settings.acct.usage", { n: acct.usage.n, size: App.fmtSize(acct.usage.size) }));
  if(acct.usage && acct.usage.active) parts.push(t("settings.acct.active", { n: acct.usage.active }));
  return parts.join(" · ") || t("settings.acct.desc");
}
function showAccount(){
  fetchAccount(true);
  var d = acct.data || {}, r = [];
  r.push([t("settings.acct.plan"), planName(d.plan)]);
  if(d.premium_expires_at) r.push([t("settings.acct.expiry"), acctExpiry(d) || String(d.premium_expires_at)]);
  if(d.email) r.push([t("settings.acct.email"), d.email]);
  if(d.is_subscribed !== undefined) r.push([t("settings.acct.subscribed"), d.is_subscribed ? t("ui.yes") : t("ui.no")]);
  if(d.additional_concurrent_slots !== undefined) r.push([t("settings.acct.extraSlots"), String(d.additional_concurrent_slots)]);
  if(d.total_downloaded !== undefined) r.push([t("settings.acct.downloaded"), App.fmtSize(d.total_downloaded)]);
  if(d.cooldown_until && Date.parse(d.cooldown_until) > Date.now()) r.push([t("settings.acct.cooldown"), fmtDate(d.cooldown_until)]);
  if(d.created_at) r.push([t("settings.acct.since"), fmtDate(d.created_at)]);
  if(acct.usage){
    r.push([t("settings.acct.library"), t("settings.acct.usage", { n: acct.usage.n, size: App.fmtSize(acct.usage.size) })]);
    r.push([t("settings.acct.activeDl"), String(acct.usage.active)]);
  }
  if(acct.error) r.push([t("settings.acct.error"), acct.error]);
  App.ui.modal({
    title: t("settings.acct.title"),
    html: '<div class="set-diag">' + r.map(function(x){
      return '<div class="set-diag-row"><b>' + App.esc(x[0]) + '</b><span>' + App.esc(x[1]) + '</span></div>';
    }).join("") + '</div>',
    buttons: [{ label: t("ui.close"), value: true }]
  });
}

function showRD(){
  fetchRD(true);
  var d = rdAcct.data || {}, r = [];
  r.push([t("settings.acct.plan"), d.plan ? planName(d.plan) : "—"]);
  if(d.username) r.push([t("settings.acct.user"), String(d.username)]);
  if(d.premium_expires_at) r.push([t("settings.acct.expiry"), acctExpiry(d) || String(d.premium_expires_at)]);
  if(rdAcct.error) r.push([t("settings.acct.error"), rdAcct.error]);
  App.ui.modal({
    title: t("settings.acct.rdTitle"),
    html: '<div class="set-diag">' + r.map(function(x){
      return '<div class="set-diag-row"><b>' + App.esc(x[0]) + '</b><span>' + App.esc(x[1]) + '</span></div>';
    }).join("") + '</div>',
    buttons: [{ label: t("ui.close"), value: true }]
  });
}
/* Tarjeta de Real-Debrid (plan / caducidad / usuario) */
function rdCardHtml(i){
  var d = rdAcct.data, h = '<div class="row set-acct-card focusable" data-i="' + i + '">';
  h += '<div class="set-acct-main"><div class="set-acct-eyebrow">Real-Debrid</div>';
  if(!d){
    h += '<div class="set-acct-plan">' + App.esc(rdAcct.error ? t("settings.acct.error") : t("settings.acct.loading")) + '</div>' +
         '<div class="set-acct-exp">' + App.esc(t("settings.acct.rdDesc")) + '</div></div>';
    return h + '</div>';
  }
  var exp = acctExpiry(d);
  h += '<div class="set-acct-plan">' + App.esc(d.plan ? planName(d.plan) : "—") + '</div>' +
       '<div class="set-acct-exp">' + App.esc(exp || t("settings.acct.rdDesc")) + '</div></div>';
  h += '<div class="set-acct-stats">';
  if(d.username) h += '<div class="set-acct-stat"><b class="num">' + App.esc(String(d.username)) + '</b><span>' + App.esc(t("settings.acct.user")) + '</span></div>';
  return h + '</div></div>';
}

/* Tarjeta destacada de cuenta (plan / caducidad / uso) */
function acctCardHtml(i){
  var d = acct.data, h = '<div class="row set-acct-card focusable" data-i="' + i + '">';
  h += '<div class="set-acct-main"><div class="set-acct-eyebrow">TorBox</div>';
  if(!App.torbox.hasToken() || !d){
    h += '<div class="set-acct-plan">' + App.esc(acctValue()) + '</div><div class="set-acct-exp">' + App.esc(t("settings.acct.desc")) + '</div></div>';
    return h + '</div>';
  }
  var exp = acctExpiry(d), badge = "";
  if(d.premium_expires_at){
    var ms = Date.parse(d.premium_expires_at), days = isNaN(ms) ? 999 : Math.ceil((ms - Date.now()) / 86400000);
    badge = '<span class="set-acct-badge' + (days < 0 ? ' bad' : days <= 7 ? ' warn' : '') + '">' + App.esc(days < 0 ? t("settings.acct.expiry") : planName(d.plan)) + '</span>';
  }
  h += '<div class="set-acct-plan">' + App.esc(planName(d.plan)) + '</div>' +
       '<div class="set-acct-exp">' + App.esc(exp || t("settings.acct.desc")) + (badge && exp ? badge : '') + '</div></div>';
  h += '<div class="set-acct-stats">';
  if(acct.usage){
    h += '<div class="set-acct-stat"><b class="num">' + acct.usage.n + '</b><span>' + App.esc(App.fmtSize(acct.usage.size)) + '</span></div>' +
         '<div class="set-acct-stat"><b class="num">' + acct.usage.active + '</b><span>' + App.esc(t("settings.acct.activeDl")) + '</span></div>';
  }
  if(d.additional_concurrent_slots !== undefined){
    h += '<div class="set-acct-stat"><b class="num">' + App.esc(String(d.additional_concurrent_slots)) + '</b><span>' + App.esc(t("settings.acct.extraSlots")) + '</span></div>';
  }
  return h + '</div></div>';
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
  ].concat((App.diag && App.diag.rows ? App.diag.rows() : []).map(function(r){
    return [t("settings.diag." + r[0]), r[1]];
  })).map(function(r){
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
    { group: t("settings.group.account"), gkey: "settings.group.account" },
    { id: "accountStatus", type: "action", label: t("settings.acct.title"), desc: acctDesc(), value: acctValue, run: showAccount },
    { id: "accountRD", type: "action", label: t("settings.acct.rdTitle"), desc: "", value: function(){ return rdAcct.data && rdAcct.data.plan ? planName(rdAcct.data.plan) : "—"; }, run: showRD },
    { id: "torboxToken", type: "secret", label: t("settings.torboxToken"),
      desc: t("settings.torboxToken.desc"),
      value: function(){ return mask(S.get("torboxToken")); },
      after: function(){ App.torbox.invalidate(); } },
    { id: "tmdbKey", type: "secret", label: t("settings.tmdbKey"),
      desc: t("settings.tmdbKey.desc"),
      value: function(){ return mask(S.get("tmdbKey")); },
      after: function(){ App.bus.emit("meta:keychange"); } },

    { group: t("settings.group.language"), gkey: "settings.group.language" },
    { id: "uiLanguage", type: "menu", label: t("settings.uiLanguage"), desc: t("settings.uiLanguage.desc"),
      options: langOpts },
    { id: "contentLanguage", type: "menu", label: t("settings.contentLanguage"), desc: t("settings.contentLanguage.desc"),
      options: [{ label: t("settings.contentLanguage.auto"), value: "auto" }].concat(langOpts) },

    { group: t("settings.group.search"), gkey: "settings.group.search" },
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

    { group: t("settings.group.library"), gkey: "settings.group.library" },
    { id: "defaultSource", type: "menu", label: t("settings.defaultSource"),
      desc: t("settings.defaultSource.desc"),
      options: [{ label: t("settings.source.all"), value: "all" }, { label: "Torrents", value: "torrents" },
                { label: "Usenet", value: "usenet" }, { label: "Web", value: "webdl" }] },

    { group: t("settings.group.playback"), gkey: "settings.group.playback" },
    { id: "autoplayNext", type: "bool", label: t("settings.autoplayNext"), desc: t("settings.autoplayNext.desc") },
    { id: "subLang", type: "menu", label: t("settings.subLang"), desc: t("settings.subLang.desc"), options: trackLangs() },
    { id: "audioLang", type: "menu", label: t("settings.audioLang"), desc: t("settings.audioLang.desc"), options: trackLangs() },
    { id: "subSize", type: "menu", label: t("settings.subSize"), desc: "",
      options: [{ label: t("settings.subSize.s"), value: "s" }, { label: t("settings.subSize.m"), value: "m" },
                { label: t("settings.subSize.l"), value: "l" }] },
    { id: "openSubs", type: "bool", label: t("settings.openSubs"), desc: t("settings.openSubs.desc") },
    { id: "notifyReady", type: "bool", label: t("settings.notifyReady"), desc: t("settings.notifyReady.desc") },

    { group: "Trakt", gkey: "settings.group.trakt" },
    { id: "traktLink", type: "action", label: t("settings.trakt.link"), desc: t("settings.trakt.link.desc"),
      value: traktValue, run: traktAction },
    { id: "traktClientId", type: "secret", label: t("settings.traktClientId"), desc: t("settings.traktClientId.desc"),
      value: function(){ return mask(S.get("traktClientId")); } },
    { id: "traktClientSecret", type: "secret", label: t("settings.traktClientSecret"), desc: "",
      value: function(){ return mask(S.get("traktClientSecret")); } },

    { group: t("settings.group.live"), gkey: "settings.group.live" },
    { id: "liveListUrl", type: "text", label: t("settings.liveListUrl"),
      desc: t("settings.liveListUrl.desc"),
      value: function(){ return S.get("liveListUrl"); },
      after: function(){ App.store.remove("live_cache"); } }
  ];
  r.push({ group: "", gkey: "settings.group.apps" });
  APPS.forEach(function(a){
    r.push({ id: "app:" + a.id, type: "appid", app: a, label: t("settings.appId", {app: a.label}),
      desc: t("settings.appId.desc"),
      value: function(){ return appId(a.id) || t("settings.appId.auto"); } });
  });
  /* Filas registradas por otros módulos (App.settingsUI). Si su grupo ya existe en la
   * lista base, se insertan al final de ese grupo; si no, se crea el grupo. */
  var extra = (App.settingsUI ? App.settingsUI.rows() : []), groups = [];
  extra.forEach(function(row){ if(groups.indexOf(row._group) < 0) groups.push(row._group); });
  groups.forEach(function(g){
    var label = t(g), rowsG = [];
    extra.forEach(function(row){
      if(row._group !== g) return;
      var o = {}; for(var k in row) o[k] = row[k];
      ["label", "desc"].forEach(function(k){ if(typeof o[k] === "function") o[k] = o[k](); });
      if(typeof o.options === "function") o.options = o.options();
      rowsG.push(o);
    });
    var gi = -1;
    for(var i = 0; i < r.length; i++){ if(r[i].group !== undefined && (r[i].gkey === g || r[i].group === label)){ gi = i; break; } }
    if(gi < 0){ r.push({ group: label, gkey: g }); r.push.apply(r, rowsG); return; }
    var end = gi + 1;
    while(end < r.length && r[end].group === undefined) end++;
    Array.prototype.splice.apply(r, [end, 0].concat(rowsG));
  });
  r.push(
    { group: t("settings.group.data"), gkey: "settings.group.data" },
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
  return tagRows(r);
}

/* ---------- Pestañas ---------- */
var TABS = ["integrations", "playback", "search", "home", "live", "appearance", "general", "system"];
var TAB_BY_ID = {
  integrations: ["faroAccount", "accountServer", "accountStatus", "accountRD", "torboxToken", "rdToken", "debridProvider", "rotateKey", "stremioAddon", "stremioAddonsList",
    "tmdbKey", "omdbKey", "traktLink", "traktClientId", "traktClientSecret", "ntfyTopic", "ntfyTest", "notifyReady", "syncUrl"],
  playback: ["autoplayNext", "subLang", "audioLang", "subSize", "openSubs", "playerSpeed", "resumeRewind", "skipIntroAuto", "subDelay"],
  search: ["autoPlayBest", "prefQuality", "maxSizeGB", "prefAudio", "hideUnsupported", "forgetFormats", "followAuto", "followList", "followNow"],
  home: ["defaultSource", "hideWatchedHome", "homeClearFilters"],
  live: ["liveListUrl", "liveExtraLists", "liveHidden", "liveOrder"],
  appearance: ["theme", "uiScale", "screensaver", "navSounds"],
  general: ["uiLanguage", "contentLanguage", "profile"],
  system: ["diagnostics", "sysInfo", "localStats", "statsView", "pinVer", "clearHistory", "clearMeta", "clearLive", "logout"]
};
var TAB_BY_GROUP = {
  "settings.group.account": "integrations", "settings.group.notify": "integrations", "settings.group.trakt": "integrations",
  "settings.group.apps": "integrations", "settings.group.language": "general", "settings.group.search": "search",
  "settings.group.library": "home", "settings.group.home": "home", "settings.group.playback": "playback",
  "settings.group.player": "playback", "settings.group.live": "live", "settings.group.appearance": "appearance",
  "settings.group.system": "system", "settings.group.data": "system"
};
var SUBS = ["faro", "streaming", "search", "meta", "trakt", "notify", "apps"];
var SUB_BY_ID = {
  faroAccount: "faro", accountServer: "faro",
  accountStatus: "streaming", accountRD: "streaming", torboxToken: "streaming", rdToken: "streaming", debridProvider: "streaming", rotateKey: "streaming",
  stremioAddon: "search", stremioAddonsList: "search", tmdbKey: "meta", omdbKey: "meta",
  traktLink: "trakt", traktClientId: "trakt", traktClientSecret: "trakt",
  ntfyTopic: "notify", ntfyTest: "notify", notifyReady: "notify", syncUrl: "notify"
};
var SUB_BY_GROUP = { "settings.group.account": "streaming", "settings.group.notify": "notify", "settings.group.trakt": "trakt",
  "settings.group.apps": "apps", "settings.group.search": "search" };
function tabOf(row){
  for(var k in TAB_BY_ID) if(TAB_BY_ID[k].indexOf(row.id) >= 0) return k;
  if(String(row.id).indexOf("app:") === 0) return "integrations";
  return TAB_BY_GROUP[row._gkey] || "system";
}
function subOf(row){
  if(String(row.id).indexOf("app:") === 0) return "apps";
  return SUB_BY_ID[row.id] || SUB_BY_GROUP[row._gkey] || "streaming";
}
/* Quita los marcadores de grupo y etiqueta cada fila con su pestaña / subtítulo */
function tagRows(list){
  var out = [], gk = "";
  list.forEach(function(row){
    if(row.group !== undefined){ gk = row.gkey || ""; return; }
    row._gkey = gk; row._tab = tabOf(row);
    if(row._tab === "integrations") row._sub = subOf(row);
    out.push(row);
  });
  out.forEach(function(row, i){ row._ord = i; });
  out.forEach(function(row){ row._key = (row._tab === "integrations" ? SUBS.indexOf(row._sub) * 10000 : 0) + row._ord; });
  out.sort(function(a, b){ return a._key - b._key; });
  return out;
}
function curTab(){
  var v = App.store.get("settingsTab", "integrations");
  return TABS.indexOf(v) >= 0 ? v : "integrations";
}

function valueText(row){
  if(row.value) return row.value();
  if(row.type === "bool") return S.get(row.id) ? t("ui.yes") : t("ui.no");
  if(row.type === "menu") return labelOf(row.options, S.get(row.id));
  if(row.type === "action") return "›";
  return String(S.get(row.id) || "");
}

var s = { el: null, grid: null, rows: [] };

function render(focusTab){
  var idx = s.grid ? s.grid.index : 0;
  s.rows = rows();
  var tab = curTab();
  var html = '<div class="scroll set"><div class="chips set-tabs">';
  TABS.forEach(function(k){
    html += '<div class="chip set-tab focusable' + (k === tab ? ' active' : '') + '" data-tab="' + k + '">' + App.esc(t("settings.tab." + k)) + '</div>';
  });
  html += '</div>';
  var lastSub = null;
  s.rows.forEach(function(row, i){
    if(row._tab !== tab) return;
    if(row.id === "accountStatus" && !(hasTB() || !hasRDacc())) return;
    if(row.id === "accountRD" && !hasRDacc()) return;
    if(tab === "integrations" && row._sub !== lastSub){
      lastSub = row._sub;
      html += '<div class="section-title set-group">' + App.esc(t("settings.sub." + row._sub)) + '</div>';
    }
    if(row.id === "accountStatus"){ html += acctCardHtml(i); return; }
    if(row.id === "accountRD"){ html += rdCardHtml(i); return; }
    var v = valueText(row);
    html += '<div class="row set-row focusable' + (row.danger ? ' set-danger' : '') + '" data-i="' + i + '">' +
      '<div class="set-text"><div class="set-label">' + App.esc(row.label) + '</div>' +
        (row.desc ? '<div class="set-desc">' + App.esc(row.desc) + '</div>' : '') + '</div>' +
      (row.type === "bool"
        ? '<span class="set-toggle' + (S.get(row.id) ? ' on' : '') + '"><i></i></span>'
        : '<div class="set-value">' + App.esc(v) + '</div>') +
    '</div>';
  });
  if(tab === "system"){
    var newer = verState.latest && cmpVer(App.version, verState.latest) < 0;
    html += '<div class="set-footer">' +
      '<div>' + App.esc(t("settings.footer", {v: App.version})) +
        (newer ? ' <span class="set-new">' + App.esc(t("settings.newVersion", {v: verState.latest})) + '</span>' : '') + '</div>' +
      '</div>';
  }
  html += '</div>';
  var sc = s.el.querySelector(".scroll"), top = (sc && !focusTab) ? sc.scrollTop : 0;
  s.el.innerHTML = html;
  sc = s.el.querySelector(".scroll"); if(sc) sc.scrollTop = top;
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect, onFocus: onFocus });
  s.grid.index = focusTab ? TABS.indexOf(tab) : Math.min(idx, s.grid.items.length - 1);
  s.grid.paint();
  if(document.body.classList.contains("zone-header")) s.grid.blur();
}

function setTab(k){
  if(k === curTab()) return;
  App.store.set("settingsTab", k);
  render(true);
}
/* ◄► sobre una pestaña la activa al enfocarla */
function onFocus(i, el){
  if(el && el.getAttribute("data-tab")) setTab(el.getAttribute("data-tab"));
}

function resetRow(row){
  if(row && RESETTABLE.indexOf(row.id) >= 0){ S.resetKey(row.id); if(row.after) row.after(); render(); App.ui.toast(t("settings.resetDone")); }
  else if(row && row.type === "appid"){ setAppId(row.app.id, ""); render(); App.ui.toast(t("settings.resetDone")); }
}

function rowAt(el){ var i = el.getAttribute("data-i"); return i === null ? null : s.rows[Number(i)]; }

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

function onSelect(i, el){
  var tb = el.getAttribute("data-tab");
  if(tb){ setTab(tb); if(s.grid && s.grid.items.length > TABS.length) s.grid.focus(TABS.length); return; }
  var row = rowAt(el); if(row) edit(row);
}

App.screens.register({
  id: "settings", label: t("nav.settings"), nav: true, order: 60,
  get hint(){ return t("settings.tabs.hint"); },
  mount: function(el){
    s.el = el;
    App.bus.on("settings:change", function(){ if(App.current() === "settings" && s.grid) render(); });
  },
  show: function(){ render(); checkVersion(); fetchAccount(false); fetchRD(false); },
  focus: function(){ if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  actions: function(){
    var cur = s.grid && s.grid.current(), row = cur && rowAt(cur), out = [];
    if(!row) return out;
    out.push({ label: t(row.type === "action" ? "settings.act.run" : "settings.act.change"), run: function(){ edit(row); } });
    if(RESETTABLE.indexOf(row.id) >= 0 || row.type === "appid")
      out.push({ label: t("settings.act.reset"), run: function(){ resetRow(row); } });
    if(row.id === "accountStatus") out.push({ label: t("settings.act.refreshAcct"), run: function(){ fetchAccount(true); render(); } });
    if(row.id === "accountRD") out.push({ label: t("settings.act.refreshAcct"), run: function(){ fetchRD(true); render(); } });
    return out;
  },
  onKey: function(k){
    if(k === K.RED){
      var cur = s.grid && s.grid.current();
      resetRow(cur && rowAt(cur));
      return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
