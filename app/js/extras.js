/* extras.js — perfiles/ajustes de apariencia (temas, tamaño), cambio de API key, "qué hay de nuevo",
 * salvapantallas, sonidos de navegación, telemetría local y avisos de arranque (errores previos, espacio).
 * Todos los textos en app/i18n/core.js. Los ajustes se registran con App.settingsUI.
 */
(function(){
"use strict";

var App = window.App;
var S = App.settings;
var t = App.t;
var UI = App.settingsUI;

function cmpVer(a, b){
  var pa = String(a || "0").replace(/^v/, "").split("."), pb = String(b || "0").replace(/^v/, "").split(".");
  for(var i = 0; i < Math.max(pa.length, pb.length); i++){
    var x = parseInt(pa[i] || "0", 10) || 0, y = parseInt(pb[i] || "0", 10) || 0;
    if(x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function playerActive(){ try{ return !!(App.player && App.player.isActive && App.player.isActive()); }catch(e){ return false; } }
function rawGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function rawSet(k, v){ try{ if(v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch(e){} }
function jget(k, def){ try{ var r = localStorage.getItem(k); return r === null ? def : JSON.parse(r); }catch(e){ return def; } }

/* ================= Qué hay de nuevo (#89) =================
 * Añade una entrada por versión (la más nueva arriba). Se muestran las de versiones posteriores a la última vista.
 */
App.displayVersion = "2.0";   // versión comercial que ve el usuario (App.version es el semver interno)
var CHANGELOG = [
  { v: "3.0.0", label: "2.0",
    en: ["New design: side menu with icons instead of the top tabs, a clean header and a hint bar at the bottom.",
         "Much more visible focus: a white ring and a slight zoom on whatever is selected.",
         "Options bar: Hold OK (or TOOLS / Menu) opens the options of any screen.",
         "Everything from 2.5.0: profiles with PIN, themes, interface size, screensaver, offline start with automatic rollback, and a mobile layout."],
    es: ["Nuevo diseño: menú lateral con iconos en lugar de las pestañas superiores, cabecera limpia y barra de pistas abajo.",
         "Foco mucho más visible: aro blanco y un ligero zoom en lo seleccionado.",
         "Barra de opciones: Mantén OK (o TOOLS / Menú) abre las opciones de cualquier pantalla.",
         "Todo lo de la 2.5.0: perfiles con PIN, temas, tamaño de interfaz, salvapantallas, arranque sin red con vuelta automática atrás y diseño para móvil."] },
  { v: "2.5.0",
    en: ["Hold OK (or press TOOLS / Menu) on any screen to open an options menu — no colour buttons needed.",
         "Profiles with optional PIN: each person has their own history, follows and preferences.",
         "Themes (green, blue, OLED black), interface size and an optional screensaver with posters.",
         "Faster start of the installed app, offline start from a local copy, and automatic rollback if an update fails to start.",
         "Last errors are remembered and reported next time; storage warnings; new System info and usage statistics in Settings.",
         "Mobile layout for the phone web page."],
    es: ["Mantén OK (o pulsa TOOLS / Menú) en cualquier pantalla para abrir un menú de opciones, sin necesidad de botones de colores.",
         "Perfiles con PIN opcional: cada persona tiene su historial, series seguidas y preferencias.",
         "Temas (verde, azul, negro OLED), tamaño de la interfaz y salvapantallas opcional con pósters.",
         "Arranque más rápido de la app instalada, arranque sin red desde una copia local y vuelta automática a la versión anterior si una actualización no arranca.",
         "Se recuerdan los últimos errores y se avisa en el siguiente arranque; avisos de espacio; nueva información del sistema y estadísticas de uso en Ajustes.",
         "Diseño para móvil en la página web del teléfono."] }
];
App.changelog = CHANGELOG;

function showWhatsNew(){
  var seen = App.store.getGlobal("seenVer", null);
  if(!seen){ App.store.setGlobal("seenVer", App.version); return; }          // primera vez: sin aviso
  if(cmpVer(App.version, seen) <= 0) return;
  var lang = App.i18n.lang();
  var items = CHANGELOG.filter(function(c){ return cmpVer(c.v, seen) > 0 && cmpVer(c.v, App.version) <= 0; });
  if(!items.length){ App.store.setGlobal("seenVer", App.version); return; }
  var html = items.map(function(c){
    var lines = c[lang] || c.en || [];
    return '<div class="wn-ver">' + App.esc(c.label || c.v) + '</div><ul class="wn-list">' +
      lines.map(function(l){ return '<li>' + App.esc(l) + '</li>'; }).join("") + '</ul>';
  }).join("");
  App.ui.modal({
    title: t("shell.whatsnew", { v: App.displayVersion }), wide: true, html: html,
    buttons: [{ label: t("whatsnew.close"), value: true }],
    onClose: function(){ App.store.setGlobal("seenVer", App.version); }
  });
}

/* ================= Temas (#92) y tamaño (#93) ================= */
var THEMES = ["green", "blue", "oled"];
function applyLook(){
  var th = S.get("theme"); if(THEMES.indexOf(th) < 0) th = "green";
  document.documentElement.setAttribute("data-theme", th);
  var sc = Number(S.get("uiScale")) || 100;
  if([90, 100, 115, 130].indexOf(sc) < 0) sc = 100;
  document.documentElement.style.setProperty("--ui-scale", String(sc / 100));
  document.documentElement.classList.toggle("scaled", sc !== 100);
}
applyLook();
App.bus.on("settings:change", function(c){
  if(!c || !c.key || c.key === "theme" || c.key === "uiScale") applyLook();
});

UI.add("settings.group.appearance", {
  id: "theme", type: "menu", label: function(){ return t("ui.theme"); }, desc: function(){ return t("ui.theme.desc"); },
  options: function(){ return THEMES.map(function(x){ return { label: t("ui.theme." + x), value: x }; }); }
});
UI.add("settings.group.appearance", {
  id: "uiScale", type: "menu", label: function(){ return t("ui.scale"); }, desc: function(){ return t("ui.scale.desc"); },
  options: function(){ return [90, 100, 115, 130].map(function(x){ return { label: x + " %", value: x }; }); }
});
UI.add("settings.group.appearance", {
  id: "screensaver", type: "menu", label: function(){ return t("ui.screensaver"); }, desc: function(){ return t("ui.screensaver.desc"); },
  options: function(){
    return [{ label: t("ui.screensaver.off"), value: 0 }].concat([5, 10, 20].map(function(n){ return { label: t("ui.screensaver.min", { n: n }), value: n }; }));
  }
});
UI.add("settings.group.appearance", {
  id: "navSounds", type: "bool", label: function(){ return t("ui.sounds"); }, desc: function(){ return t("ui.sounds.desc"); }
});

/* ================= Perfiles (TODO 6) — filas de Ajustes ================= */
function askText(title, value, secret){
  return new Promise(function(resolve){
    var done = false;
    App.ui.keyboard.open({ title: title, value: value || "", secret: !!secret,
      onDone: function(v){ done = true; resolve(String(v || "").trim()); },
      onCancel: function(){ if(!done) resolve(null); } });
  });
}
function profileMenu(){
  var cur = App.profile.current(), list = App.profile.list(), items = [];
  list.forEach(function(p){
    if(p.id !== cur) items.push({ label: t("profile.switch", { name: p.name }) + (p.hasPin ? "  (PIN)" : ""), value: "sw:" + p.id });
  });
  items.push({ label: t("profile.new"), value: "new" });
  items.push({ label: t("profile.rename"), value: "rename" });
  items.push({ label: t("profile.setPin"), value: "pin" });
  var me = null; list.forEach(function(p){ if(p.id === cur) me = p; });
  if(me && me.hasPin) items.push({ label: t("profile.clearPin"), value: "nopin" });
  if(list.length > 1) items.push({ label: t("profile.delete"), value: "del" });
  return App.ui.menu(t("profile.row") + " · " + App.profile.name(), items).then(function(v){
    if(!v) return;
    if(v.indexOf("sw:") === 0){
      var id = v.slice(3), p = list.filter(function(x){ return x.id === id; })[0];
      if(p && p.hasPin) return askText(t("profile.enterPin", { name: p.name }), "", true).then(function(pin){
        if(pin === null) return;
        if(!App.profile.switchTo(id, pin)) App.ui.toast(t("profile.wrongPin"));
      });
      App.profile.switchTo(id, "");
      return;
    }
    if(v === "new") return askText(t("profile.newName"), "").then(function(name){
      if(!name) return;
      return askText(t("profile.newPin"), "", true).then(function(pin){
        if(pin === null) return;
        App.profile.create(name, pin); App.ui.toast(t("profile.created"));
      });
    });
    if(v === "rename") return askText(t("profile.rename"), App.profile.name()).then(function(name){ if(name) App.profile.rename(cur, name); });
    if(v === "pin") return askText(t("profile.pinPrompt"), "", true).then(function(pin){
      if(pin === null) return;
      App.profile.setPin(cur, pin); App.ui.toast(pin ? t("profile.pinSaved") : t("profile.pinCleared"));
    });
    if(v === "nopin"){ App.profile.setPin(cur, ""); App.ui.toast(t("profile.pinCleared")); return; }
    if(v === "del"){
      var others = list.filter(function(x){ return x.id !== cur && x.id !== "p0"; });
      if(!others.length){ App.ui.toast(t("profile.noneToDelete")); return; }
      return App.ui.menu(t("profile.delete"), others.map(function(x){ return { label: x.name, value: x.id }; })).then(function(id){
        if(!id) return;
        var nm = others.filter(function(x){ return x.id === id; })[0].name;
        return App.ui.confirm(t("profile.deleteConfirm", { name: nm }), t("profile.deleteText"), t("settings.delete"), t("ui.cancel")).then(function(y){
          if(y){ App.profile.remove(id); App.ui.toast(t("profile.deleted")); }
        });
      });
    }
  });
}
UI.add("settings.group.account", {
  id: "profile", type: "action", label: function(){ return t("profile.row"); }, desc: function(){ return t("profile.row.desc"); },
  value: function(){ return App.profile.name(); }, run: profileMenu
});

/* ================= A7 — cambiar la API key en todas partes ================= */
function replaceKeyInAddons(oldK, newK){
  var n = 0;
  if(!oldK || oldK.length < 8) return 0;
  var variants = [oldK]; try{ var enc = encodeURIComponent(oldK); if(enc !== oldK) variants.push(enc); }catch(e){}
  function fix(u){
    if(typeof u !== "string") return u;
    var out = u;
    variants.forEach(function(v, i){
      if(out.indexOf(v) >= 0){ out = out.split(v).join(i === 0 ? newK : encodeURIComponent(newK)); }
    });
    if(out !== u) n++;
    return out;
  }
  var one = S.get("stremioAddon"), fixed = fix(one);
  if(fixed !== one) S.set("stremioAddon", fixed);
  var many = S.get("stremioAddons");
  if(Array.isArray(many)){
    var ch = false;
    var nm = many.map(function(u){ var f = fix(u); if(f !== u) ch = true; return f; });
    if(ch) S.set("stremioAddons", nm);
  }
  return n;
}
UI.add("settings.group.account", {
  id: "rotateKey", type: "action", label: function(){ return t("acct.rotate"); }, desc: function(){ return t("acct.rotate.desc"); },
  value: function(){ return "›"; },
  run: function(){
    return App.ui.confirm(t("acct.rotate.title"), t("acct.rotate.text"), t("acct.rotate.go"), t("ui.cancel")).then(function(y){
      if(!y) return;
      return askText(t("acct.rotate.prompt"), "", true).then(function(v){
        if(v === null) return;
        if(!v){ App.ui.toast(t("acct.rotate.empty")); return; }
        var old = S.get("torboxToken") || "";
        S.set("torboxToken", v);
        try{ App.torbox.invalidate(); }catch(e){}
        var n = replaceKeyInAddons(old, v);
        App.ui.toast(n ? t("acct.rotate.doneAddons", { n: n }) : t("acct.rotate.done"), 4500);
      });
    });
  }
});

/* ================= Sistema: información, estadísticas, fijar versión ================= */
function bootSourceLabel(){
  var b = App.bootInfo;
  if(!b) return t("sys.bootNone");
  return t("sys.src." + (b.source || "net"));
}
function sysRows(){
  var b = App.bootInfo, mb = (App.store.usage() / 1048576).toFixed(2);
  var rows = [
    [t("sys.version"), App.displayVersion + " (" + App.version + ")"],
    [t("sys.boot"), b ? ((b.ver || "?") + (b.pinned ? " (pin)" : "")) : "—"],
    [t("sys.bootSource"), bootSourceLabel()],
    [t("sys.storage"), mb + " MB"],
    [t("sys.profile"), App.profile.name()]
  ];
  return rows;
}
App.diagRows = sysRows;   // por si Ajustes quiere incluirlas en su modal de Diagnóstico

function showSysInfo(){
  var errs = App.lastErrors().slice(-10).reverse();
  var rowsHtml = sysRows().map(function(r){
    return '<div class="set-diag-row"><b>' + App.esc(r[0]) + '</b><span>' + App.esc(r[1]) + '</span></div>';
  }).join("");
  var logHtml = errs.length ? errs.map(function(e){
    return '<div class="set-diag-log e">' + App.esc(new Date(e.t).toLocaleString() + " v" + e.v + " " + e.m) + '</div>';
  }).join("") : '<div class="muted">' + App.esc(t("sys.noErrors")) + '</div>';
  App.ui.modal({
    title: t("sys.title"), wide: true,
    html: '<div class="set-diag">' + rowsHtml + '</div><div class="set-diag-sub">' + App.esc(t("sys.errors")) + '</div><div class="set-diag-logs">' + logHtml + '</div>',
    buttons: [{ label: t("ui.close"), value: true }]
  });
}
UI.add("settings.group.system", {
  id: "sysInfo", type: "action", label: function(){ return t("sys.title"); }, desc: function(){ return t("sys.desc"); },
  value: function(){ return App.bootVersion || App.version; }, run: showSysInfo
});

/* ---- Telemetría local (#100) ---- */
App.bus.on("screen:show", function(d){
  if(!d || !d.id || S.get("localStats") === false) return;
  var v = App.store.getGlobal("visits", {}) || {};
  v[d.id] = (v[d.id] || 0) + 1;
  App.store.setGlobal("visits", v);
});
App.visits = function(){ return App.store.getGlobal("visits", {}) || {}; };
function showStats(){
  var v = App.visits(), ids = Object.keys(v).sort(function(a, b){ return v[b] - v[a]; });
  var html;
  if(S.get("localStats") === false) html = '<p>' + App.esc(t("stats.off")) + '</p>';
  else if(!ids.length) html = '<p>' + App.esc(t("stats.none")) + '</p>';
  else html = '<div class="set-diag">' + ids.map(function(id){
    var def = App.screens.get(id), name = (def && def.label) || id;
    return '<div class="set-diag-row"><b>' + App.esc(name) + '</b><span>' + App.esc(t("stats.visits", { n: v[id] })) + '</span></div>';
  }).join("") + '</div>';
  App.ui.modal({
    title: t("stats.title"), wide: true, html: html,
    buttons: [{ label: t("stats.reset"), value: "reset" }, { label: t("ui.close"), value: true }],
    cancelValue: true,
    onClose: function(val){ if(val === "reset"){ App.store.setGlobal("visits", {}); } }
  });
}
UI.add("settings.group.system", {
  id: "localStats", type: "bool", label: function(){ return t("ui.stats"); }, desc: function(){ return t("ui.stats.desc"); }
});
UI.add("settings.group.system", {
  id: "statsView", type: "action", label: function(){ return t("stats.title"); }, desc: function(){ return ""; },
  value: function(){ return "›"; }, run: showStats
});

/* ---- A3: fijar versión (solo app instalada: el cargador lee tb_pin_ver) ---- */
UI.add("settings.group.system", {
  id: "pinVer", type: "action", label: function(){ return t("boot.pin"); }, desc: function(){ return t("boot.pin.desc"); },
  value: function(){ var p = rawGet("tb_pin_ver"); return p ? p : t("boot.pin.auto"); },
  run: function(){
    if(!App.bootInfo){ App.ui.toast(t("boot.pin.none")); return; }
    var vers = jget("tb_vers_list", []) || [], bad = jget("tb_bad_vers", []) || [], pin = rawGet("tb_pin_ver");
    var items = [{ label: t("boot.pin.auto"), value: "__auto", selected: !pin }];
    vers.forEach(function(v){
      items.push({ label: v + (v === App.bootVersion ? "  · " + t("boot.pin.current", { v: v }) : "") + (bad.indexOf(v) >= 0 ? "  · " + t("boot.pin.bad") : ""),
        value: v, selected: pin === v });
    });
    return App.ui.menu(t("boot.pin"), items).then(function(v){
      if(!v) return;
      if(v === "__auto"){ rawSet("tb_pin_ver", null); App.ui.toast(t("boot.pin.cleared")); }
      else{
        rawSet("tb_pin_ver", v);
        var nb = bad.filter(function(x){ return x !== v; }); rawSet("tb_bad_vers", JSON.stringify(nb));   // fijar manualmente la rehabilita
        App.ui.toast(t("boot.pin.applied"));
      }
      setTimeout(function(){ location.reload(); }, 1400);
    });
  }
});

/* ================= Sonidos de navegación (#95) ================= */
var actx = null;
function beep(freq, ms){
  try{
    if(!actx){ var AC = window.AudioContext || window.webkitAudioContext; if(!AC) return; actx = new AC(); }
    if(actx.state === "suspended" && actx.resume) actx.resume();
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    g.gain.value = 0.05;
    g.gain.setTargetAtTime(0.0001, actx.currentTime + ms / 1000 * 0.6, 0.01);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000);
  }catch(e){}
}
function soundKey(e){
  if(!S.get("navSounds") || playerActive() || e.repeat && e.keyCode === App.K.OK) return;
  var k = e.keyCode, K = App.K;
  if(k === K.LEFT || k === K.RIGHT || k === K.UP || k === K.DOWN) beep(520, 35);
  else if(k === K.OK) beep(780, 60);
  else if(App.isBack(k)) beep(330, 60);
}

/* ================= Salvapantallas (#94) ================= */
var ss = { timer: null, el: null, on: false, slide: null, clock: null, imgs: [], pos: 0, layers: [], cur: 0 };
function ssMinutes(){ var m = Number(S.get("screensaver")); return m > 0 ? m : 0; }
function scheduleSS(){
  clearTimeout(ss.timer);
  var m = ssMinutes();
  if(!m || ss.on) return;
  ss.timer = setTimeout(startSS, m * 60000);
}
function collectUrls(obj, pref, other, depth, keyName){
  if(depth > 7 || obj === null || obj === undefined) return;
  if(typeof obj === "string"){
    if(/^https?:\/\//.test(obj) && (/image\.tmdb\.org|\.(jpe?g|png|webp)(\?|$)/i.test(obj))){
      (/backdrop|background|fanart|still/i.test(keyName || "") ? pref : other).push(obj);
    }
    return;
  }
  if(typeof obj !== "object") return;
  if(Array.isArray(obj)){ for(var i = 0; i < obj.length && i < 400; i++) collectUrls(obj[i], pref, other, depth + 1, keyName); return; }
  var ks = Object.keys(obj);
  for(var j = 0; j < ks.length && j < 200; j++) collectUrls(obj[ks[j]], pref, other, depth + 1, ks[j]);
}
function shuffle(a){ for(var i = a.length - 1; i > 0; i--){ var j = Math.floor(Math.random() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
function gatherImages(){
  var pref = [], other = [];
  var tasks = [];
  if(App.cache) ["homecache", "metacache"].forEach(function(k){ tasks.push(App.cache.get(k).catch(function(){ return undefined; })); });
  tasks.push(Promise.resolve(App.store.get("homecache", null)), Promise.resolve(App.store.get("metacache", null)));
  return Promise.all(tasks).then(function(vals){
    vals.forEach(function(v){ if(v) collectUrls(v, pref, other, 0, ""); });
    var seen = {}, list = shuffle(pref).concat(pref.length < 8 ? shuffle(other) : []).filter(function(u){ if(seen[u]) return false; seen[u] = 1; return true; });
    return list.slice(0, 30);
  }).catch(function(){ return []; });
}
function startSS(){
  if(ss.on) return;
  if(playerActive() || App.ui.isModalOpen() || (App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen())){ scheduleSS(); return; }
  ss.on = true;
  var el = ss.el = document.createElement("div");
  el.id = "screensaver";
  el.innerHTML = '<div class="ss-layer"></div><div class="ss-layer"></div><div class="ss-logo">Tor<b>Box</b></div><div class="ss-clock"></div>';
  document.body.appendChild(el);
  ss.layers = [el.children[0], el.children[1]]; ss.cur = 0;
  ss.logo = el.children[2]; ss.clock = el.children[3];
  ss.pos = 0;
  gatherImages().then(function(list){
    if(!ss.on) return;
    ss.imgs = list;
    ss.logo.style.display = list.length ? "none" : "block";
    if(list.length) nextSlide();
  });
  tickSS();
  ss.slide = setInterval(function(){ if(ss.imgs.length) nextSlide(); }, 12000);
  ss.mover = setInterval(tickSS, 20000);
}
function nextSlide(){
  var url = ss.imgs[ss.pos++ % ss.imgs.length];
  var img = new Image();
  img.onload = function(){
    if(!ss.on) return;
    var nxt = ss.layers[1 - ss.cur], old = ss.layers[ss.cur];
    nxt.style.backgroundImage = "url(\"" + url + "\")";
    nxt.className = "ss-layer on";
    old.className = "ss-layer";
    ss.cur = 1 - ss.cur;
  };
  img.onerror = function(){ /* se salta */ };
  img.src = url;
}
function tickSS(){
  if(!ss.on) return;
  var d = new Date(), h = d.getHours(), m = d.getMinutes();
  ss.clock.textContent = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  /* mover reloj/logo para evitar quemado de pantalla */
  var x = 6 + Math.random() * 70, y = 8 + Math.random() * 76;
  ss.clock.style.left = x + "%"; ss.clock.style.top = y + "%";
  ss.logo.style.left = (6 + Math.random() * 55) + "%"; ss.logo.style.top = (12 + Math.random() * 60) + "%";
}
function stopSS(){
  if(!ss.on) return;
  ss.on = false;
  clearInterval(ss.slide); clearInterval(ss.mover);
  if(ss.el && ss.el.parentNode) ss.el.parentNode.removeChild(ss.el);
  ss.el = null;
  scheduleSS();
}
function onActivity(e){
  if(ss.on){
    if(e && e.type === "keydown"){ e.preventDefault(); e.stopImmediatePropagation(); }
    stopSS();
    return;
  }
  scheduleSS();
}
document.addEventListener("keydown", function(e){ onActivity(e); soundKey(e); }, true);
["mousemove", "mousedown", "touchstart", "click"].forEach(function(n){ document.addEventListener(n, function(e){ onActivity(e); }, true); });
App.bus.on("settings:change", function(c){ if(!c || !c.key || c.key === "screensaver") scheduleSS(); });
App.bus.on("player:start", function(){ clearTimeout(ss.timer); });
App.bus.on("player:close", function(){ scheduleSS(); });
App.screensaver = { start: startSS, stop: stopSS };

/* ================= Avisos al arrancar: errores previos, espacio, novedades ================= */
App.bus.on("app:ready", function(){
  scheduleSS();
  setTimeout(function(){
    var n = App.prevErrorCount();
    if(n > 0){ App.ui.toast(t("errlog.prev", { n: n }), 6000); App.markErrorsSeen(); }
  }, 2500);
  setTimeout(function(){
    var bytes = App.store.usage();
    if(bytes > 4 * 1048576){
      if(!App.store.getGlobal("g_quotaWarn", false)){
        App.store.setGlobal("g_quotaWarn", true);
        App.ui.toast(t("store.full", { mb: (bytes / 1048576).toFixed(1) }), 6000);
      }
    }else if(bytes < 3 * 1048576){ App.store.setGlobal("g_quotaWarn", null); }
  }, 9500);
  setTimeout(function(){
    if(playerActive() || App.ui.isModalOpen() || (App.current && App.current() === "profiles")) return;
    try{ showWhatsNew(); }catch(e){ console.error("[whatsnew]", e); }
  }, 4000);
});

})();
