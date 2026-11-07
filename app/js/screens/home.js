/* screens/home.js — pantalla Inicio: Continuar viendo, Mi lista de Trakt y catálogos.
 *
 * Catálogos: add-on público "The Movie Database Addon" de Stremio (instancia ElfHosted),
 * sin clave, localizado con App.i18n.tmdbLang() (config lz-string precalculada). Si falla,
 * cae a Cinemeta (inglés). OK en un título → App.go('search', {open:{type, id(tt…), name, poster}}).
 */
(function(){
"use strict";

var App = window.App;
var K = App.K;

var TMDB_ADDON = "https://tmdb.elfhosted.com";
/* lz-string.compressToEncodedURIComponent(JSON.stringify({language: "<tmdb>"})) */
var TMDB_CFG = {
  "en-US": "N4IgNghgdg5grhGBTEAuESoFoCqBlEAXyA",
  "es-ES": "N4IgNghgdg5grhGBTEAuESDOBaAogZRAF8g"
};
var CINEMETA = "https://v3-cinemeta.strem.io";
var CACHE_KEY = "homecache";
var CACHE_TTL = 6 * 3600 * 1000;
var MAX_ITEMS = 20;

/* Filas de catálogo: fuente TMDB (localizada) y equivalente Cinemeta de respaldo */
var CATALOGS = [
  { id: "trendMovie",  label: "home.trendingMovies", tmdb: "movie/tmdb.trending",  cm: "movie/top" },
  { id: "trendSeries", label: "home.trendingSeries", tmdb: "series/tmdb.trending", cm: "series/top" },
  { id: "popMovie",    label: "home.popularMovies",  tmdb: "movie/tmdb.top",       cm: "movie/imdbRating" },
  { id: "popSeries",   label: "home.popularSeries",  tmdb: "series/tmdb.top",      cm: "series/imdbRating" },
  { id: "newMovie",    label: "home.latestMovies",   tmdb: "movie/tmdb.latest",    cm: "movie/year" },
  { id: "newSeries",   label: "home.newSeries",      tmdb: "series/tmdb.latest",   cm: "series/year" }
];

var s = {
  el: null, grid: null, rows: [], heroTimer: null, cwDirty: true,
  focusKey: null, mounted: false, reqId: 0
};

/* ================= Utilidades ================= */
function esc(x){ return App.esc(x); }
function lang(){ return App.i18n.tmdbLang(); }

function cacheGet(id){
  var c = App.store.get(CACHE_KEY, {}) || {};
  var e = c[lang() + ":" + id];
  return (e && Date.now() - e.t < CACHE_TTL) ? e.v : null;
}
function cacheSet(id, v){
  var c = App.store.get(CACHE_KEY, {}) || {};
  c[lang() + ":" + id] = { t: Date.now(), v: v };
  // limpiar entradas caducadas para no crecer sin límite
  Object.keys(c).forEach(function(k){ if(Date.now() - c[k].t > CACHE_TTL * 4) delete c[k]; });
  App.store.set(CACHE_KEY, c);
}

function getJson(url, ms){
  return new Promise(function(resolve, reject){
    var done = false;
    var t = setTimeout(function(){ if(!done){ done = true; reject(new Error("timeout")); } }, ms || 15000);
    App.net.fetch(url).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(j){ if(!done){ done = true; clearTimeout(t); resolve(j); } })
      .catch(function(e){ if(!done){ done = true; clearTimeout(t); reject(e); } });
  });
}

function imdbFromLinks(m){
  if(m.imdb_id) return m.imdb_id;
  if(/^tt\d+$/.test(String(m.id || ""))) return m.id;
  var links = m.links || [];
  for(var i = 0; i < links.length; i++){
    var mm = String(links[i].url || "").match(/(tt\d{5,})/);
    if(links[i].category === "imdb" && mm) return mm[1];
  }
  return "";
}

function normMeta(m){
  var imdb = imdbFromLinks(m);
  return {
    kind: "title",
    type: m.type === "series" ? "series" : "movie",
    id: imdb || String(m.id || ""),
    imdb: imdb,
    name: m.name || "",
    poster: m.poster || (imdb ? "https://images.metahub.space/poster/medium/" + imdb + "/img" : ""),
    background: m.background || (imdb ? "https://images.metahub.space/background/medium/" + imdb + "/img" : ""),
    year: m.year || (m.releaseInfo ? String(m.releaseInfo).slice(0, 4) : ""),
    rating: /^\d/.test(String(m.imdbRating || "")) ? String(m.imdbRating) : "",
    description: m.description || ""
  };
}

/* ================= Carga de filas ================= */
function loadCatalog(cat){
  var cached = cacheGet(cat.id);
  if(cached) return Promise.resolve(cached);
  var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
  var url = TMDB_ADDON + "/" + cfg + "/catalog/" + cat.tmdb + ".json";
  return getJson(url, 20000).then(function(j){
    var list = (j.metas || []).map(normMeta).filter(function(x){ return x.name; }).slice(0, MAX_ITEMS);
    if(!list.length) throw new Error("vacío");
    return list;
  }).catch(function(e){
    console.warn("[home] TMDB add-on " + cat.id + " falló (" + e.message + "), uso Cinemeta");
    return getJson(CINEMETA + "/catalog/" + cat.cm + ".json", 15000).then(function(j){
      return (j.metas || []).map(normMeta).filter(function(x){ return x.name; }).slice(0, MAX_ITEMS);
    });
  }).then(function(list){
    if(list.length) cacheSet(cat.id, list);
    return list;
  });
}

function continueItems(){
  if(!App.history) return [];
  return App.history.list({ unfinished: true }).slice(0, 12).map(function(h){
    var m = h.meta || {};
    var left = h.dur ? App.t("home.left", { time: App.fmtTime(h.dur - h.pos) }) : "";
    var imdb = m.imdbId || "";
    return {
      kind: "cw", entry: h, type: m.type === "series" || m.type === "tv" ? "series" : "movie",
      id: imdb || h.key, imdb: imdb, name: h.title || m.showTitle || m.title || "",
      sub: h.subtitle || left, poster: h.poster || (imdb ? "https://images.metahub.space/poster/medium/" + imdb + "/img" : ""),
      background: imdb ? "https://images.metahub.space/background/medium/" + imdb + "/img" : (h.poster || ""),
      progress: h.dur ? Math.min(1, h.pos / h.dur) : 0, year: "", rating: "", description: left
    };
  });
}

function buildRows(){
  var rows = [];
  rows.push({ id: "cw", label: "home.continue", state: "ready", items: continueItems(), hideEmpty: true });
  if(App.trakt && App.trakt.isLinked()) rows.push({ id: "trakt", label: "home.trakt", state: "loading", items: [] });
  CATALOGS.forEach(function(c){ rows.push({ id: c.id, label: c.label, state: "loading", items: [], cat: c }); });
  return rows;
}

/* ================= Render ================= */
function cardHtml(r, it, i){
  var key = r.id + ":" + i;
  var badge = it.kind === "title" ? (it.type === "series" ? App.t("home.series") : "") : "";
  return '<div class="lib-card lib-card-sm home-card focusable" data-key="' + esc(key) + '" data-r="' + esc(r.id) + '" data-i="' + i + '">' +
    '<div class="lib-poster" style="' + App.ui.placeholderStyle(it.name) + '">' +
      '<div class="lib-initials">' + esc(App.ui.initials(it.name)) + '</div>' +
      (it.poster ? '<img class="lib-img" loading="lazy" alt="" data-src="' + esc(it.poster) + '">' : '') +
      (badge ? '<span class="lib-badge">' + esc(badge.toUpperCase()) + '</span>' : '') +
      (it.rating ? '<span class="lib-rating">★ ' + esc(it.rating) + '</span>' : '') +
      (it.kind === "cw" && it.progress ? '<div class="lib-marks"><div class="lib-prog"><i style="width:' + Math.round(it.progress * 100) + '%"></i></div></div>' : '') +
    '</div>' +
    '<div class="lib-card-title">' + esc(it.name) + '</div>' +
    '<div class="lib-card-sub num">' + esc(it.kind === "cw" ? it.sub : (it.year || "")) + '</div>' +
  '</div>';
}

function rowHtml(r){
  if(r.hideEmpty && r.state === "ready" && !r.items.length) return '<div class="home-row" data-row="' + esc(r.id) + '" hidden></div>';
  var body;
  if(r.state === "loading") body = '<div class="home-row-state"><div class="spinner home-spin"></div>' + esc(App.t("home.loadingRow")) + '</div>';
  else if(r.state === "error") body = '<div class="home-row-state err">' + esc(App.t("home.rowError")) + '</div>';
  else if(!r.items.length) body = '<div class="home-row-state">' + esc(App.t("home.rowEmpty")) + '</div>';
  else body = '<div class="hscroll home-hscroll">' + r.items.map(function(it, i){ return cardHtml(r, it, i); }).join("") + '</div>';
  return '<div class="home-row" data-row="' + esc(r.id) + '">' +
    '<div class="section-title">' + esc(App.t(r.label)) + '</div>' + body + '</div>';
}

function heroHtml(){
  return '<div class="home-hero">' +
    '<div class="home-hero-bg" id="homeHeroBg"></div><div class="home-hero-shade"></div>' +
    '<div class="home-hero-info">' +
      '<div class="home-hero-title" id="homeHeroTitle">' + esc(App.t("home.welcomeTitle")) + '</div>' +
      '<div class="home-hero-meta num" id="homeHeroMeta"></div>' +
      '<p class="home-hero-desc" id="homeHeroDesc">' + esc(App.t("home.welcomeText")) + '</p>' +
    '</div></div>';
}

function render(){
  s.el.innerHTML = heroHtml() + '<div class="scroll home-scroll" id="homeScroll">' +
    s.rows.map(rowHtml).join("") + '</div>';
  hookImages(s.el);
  mountGrid();
}

function hookImages(root){
  Array.prototype.forEach.call(root.querySelectorAll("img.lib-img[data-src]"), function(img){
    var src = img.getAttribute("data-src");
    img.removeAttribute("data-src");
    img.onload = function(){ if(img.parentNode) img.parentNode.classList.add("has-img"); };
    img.onerror = function(){ if(img.parentNode) img.parentNode.removeChild(img); };
    img.src = src;
  });
}

function rowById(id){
  for(var i = 0; i < s.rows.length; i++) if(s.rows[i].id === id) return s.rows[i];
  return null;
}

/* Sustituye una fila en el DOM y rehace la navegación conservando el foco */
function updateRow(r){
  if(!s.el) return;
  var old = s.el.querySelector('.home-row[data-row="' + r.id + '"]');
  if(!old) return;
  var tmp = document.createElement("div");
  tmp.innerHTML = rowHtml(r);
  var neu = tmp.firstChild;
  old.parentNode.replaceChild(neu, old);
  hookImages(neu);
  if(s.grid){
    var curKey = s.focusKey;
    s.grid.refresh(false);
    restoreFocus(curKey, true);
    var cur = s.grid.current();
    if(cur && App.current() === "home"){ s.focusKey = cur.getAttribute("data-key"); scheduleHero(cur); }
  }
}

function restoreFocus(key, silent){
  if(!s.grid || !s.grid.items.length) return;
  var idx = -1;
  if(key){
    for(var i = 0; i < s.grid.items.length; i++){
      if(s.grid.items[i].getAttribute("data-key") === key){ idx = i; break; }
    }
  }
  if(idx < 0) idx = Math.min(s.grid.index, s.grid.items.length - 1);
  if(document.body.classList.contains("zone-header") || App.current() !== "home"){ s.grid.index = idx; s.grid.blur(); return; }
  s.grid.focus(idx, silent);
}

function mountGrid(){
  s.grid = new App.ui.FocusGrid(s.el.querySelector("#homeScroll"), {
    onFocus: function(i, el){ s.focusKey = el.getAttribute("data-key"); scheduleHero(el); },
    onSelect: function(i, el){ open(el); }
  });
  restoreFocus(s.focusKey, false);
}

/* ================= Hero ================= */
function itemOf(el){
  if(!el) return null;
  var r = rowById(el.getAttribute("data-r"));
  return r ? r.items[Number(el.getAttribute("data-i"))] : null;
}
function scheduleHero(el){
  clearTimeout(s.heroTimer);
  s.heroTimer = setTimeout(function(){ paintHero(itemOf(el)); }, 250);
}
function paintHero(it){
  if(!it || !s.el) return;
  var bg = s.el.querySelector("#homeHeroBg");
  var t = s.el.querySelector("#homeHeroTitle");
  var meta = s.el.querySelector("#homeHeroMeta");
  var d = s.el.querySelector("#homeHeroDesc");
  if(t) t.textContent = it.name;
  if(meta){
    var parts = [];
    if(it.year) parts.push(it.year);
    parts.push(it.type === "series" ? App.t("home.series") : App.t("home.movie"));
    if(it.rating) parts.push("★ " + it.rating);
    if(it.kind === "cw" && it.sub) parts.push(it.sub);
    meta.textContent = parts.join(" · ");
  }
  if(d) d.textContent = it.description || "";
  if(bg){
    var url = it.background || it.poster || "";
    if(!url){ bg.classList.remove("on"); return; }
    var img = new Image();
    img.onload = function(){
      if(!s.el) return;
      bg.style.backgroundImage = "url('" + url.replace(/'/g, "%27") + "')";
      bg.classList.add("on");
    };
    img.onerror = function(){ bg.classList.remove("on"); };
    img.src = url;
  }
}

/* ================= Acciones ================= */
function open(el){
  var it = itemOf(el);
  if(!it) return;
  if(it.kind === "cw") return resume(it.entry);
  resolveImdb(it).then(function(imdb){
    if(!imdb) throw new Error("sin imdb");
    if(!App.screens.get("search")){ App.hint(App.t("home.noSearch")); return; }
    App.go("search", { open: { type: it.type, id: imdb, name: it.name, poster: it.poster } });
  }).catch(function(e){
    console.warn("[home] abrir título:", e.message);
    App.ui.toast(App.t("home.resolveFail"));
  });
}

/* Los ítems del add-on TMDB traen el imdb en links; si no, se pide la ficha */
function resolveImdb(it){
  if(it.imdb) return Promise.resolve(it.imdb);
  if(/^tmdb:\d+$/.test(it.id)){
    App.hint(App.t("home.opening"));
    var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
    return getJson(TMDB_ADDON + "/" + cfg + "/meta/" + it.type + "/" + it.id + ".json", 15000).then(function(j){
      var m = j.meta || {};
      it.imdb = m.imdb_id || imdbFromLinks(m);
      return it.imdb;
    });
  }
  return Promise.resolve("");
}

function resume(entry){
  var m = entry.meta || {};
  if(m.source === "stremio" && App.search && App.search.playTitle && m.imdbId){
    App.search.playTitle({ type: m.type === "tv" ? "series" : (m.type || "movie"), id: m.imdbId,
      season: m.season, episode: m.episode, name: m.title || entry.title, poster: entry.poster });
    return;
  }
  if(App.library && App.library.playHistory){ App.library.playHistory(entry); return; }
  if(App.screens.get("continue")) App.section("continue");
}

/* ================= Carga ================= */
function loadAll(){
  var id = ++s.reqId;
  s.rows.forEach(function(r){
    if(r.id === "trakt"){
      App.trakt.watchlist().then(function(list){
        if(id !== s.reqId) return;
        r.items = list.slice(0, MAX_ITEMS).map(function(x){
          return { kind: "title", type: x.type, id: x.id, imdb: x.id, name: x.name, poster: x.poster,
                   background: x.background, year: x.year || "", rating: "", description: "" };
        });
        r.state = "ready"; updateRow(r);
      }).catch(function(e){
        if(id !== s.reqId) return;
        console.warn("[home] Trakt:", e.message);
        r.state = "error"; updateRow(r);
      });
    } else if(r.cat){
      loadCatalog(r.cat).then(function(list){
        if(id !== s.reqId) return;
        r.items = list; r.state = "ready"; updateRow(r);
        if(!s.focusKey && list.length && App.current() === "home") paintHero(list[0]);
      }).catch(function(e){
        if(id !== s.reqId) return;
        console.warn("[home] fila " + r.id + ":", e.message);
        r.state = "error"; updateRow(r);
      });
    }
  });
}

function refreshContinue(){
  var r = rowById("cw");
  if(!r) return;
  r.items = continueItems();
  updateRow(r);
  s.cwDirty = false;
}

/* ================= Pantalla ================= */
App.screens.register({
  id: "home", nav: true, order: 5,
  get label(){ return App.t("nav.home"); },
  get hint(){ return App.t("home.hint"); },
  mount: function(el){
    s.el = el;
    el.classList.add("home-screen");
    s.rows = buildRows();
    render();
    loadAll();
    s.mounted = true;
    App.bus.on("history:change", function(){
      if(App.current() === "home") refreshContinue(); else s.cwDirty = true;
    });
    App.bus.on("trakt:change", function(){
      s.rows = buildRows(); render(); loadAll();
    });
  },
  show: function(params){
    if(s.cwDirty) refreshContinue();
    if(s.grid){ s.grid.refresh(false); restoreFocus(s.focusKey, false); }
  },
  hide: function(){ clearTimeout(s.heroTimer); },
  focus: function(){ if(s.grid){ s.grid.refresh(false); restoreFocus(s.focusKey, false); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  onKey: function(k){
    if(k === K.RED){
      App.store.remove(CACHE_KEY);
      App.ui.toast(App.t("home.refreshed"));
      s.rows = buildRows(); render(); loadAll();
      return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
