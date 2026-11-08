/* screens/home.js — pantalla Inicio: Continuar viendo, Mi lista de Trakt y catálogos.
 *
 * Catálogos: add-on público "The Movie Database Addon" de Stremio (instancia ElfHosted),
 * sin clave, localizado con App.i18n.tmdbLang() (config lz-string precalculada). Si falla,
 * cae a Cinemeta (inglés). OK en un título → App.go('search', {open:{type, id(tt…), name, poster}}).
 * Ronda 4: calendario, filtros (#21), Porque viste (#22), sagas (#23, con tmdbKey), Top 10 (#25),
 * Sorpréndeme (#33), ocultar vistos (#34), notas OMDb (#35, con omdbKey), duración (#37),
 * próximos estrenos de cine (#39, con tmdbKey) y actions() (A1).
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

var TMDB_API = "https://api.themoviedb.org/3";
var TMDB_IMG = "https://image.tmdb.org/t/p/w342";

App.settings.define("hideWatchedHome", false);
App.settings.define("omdbKey", "");

var s = {
  el: null, grid: null, rows: [], heroTimer: null, cwDirty: true,
  focusKey: null, mounted: false, reqId: 0, heroItem: null,
  filters: App.store.get("homefilters", null) || { genre: "", year: "", lang: "", minRating: 0 },
  manifest: null, seen: App.store.get("homeSeen", {}) || {}, watched: {},
  cat: "all", info: {}, autoFocused: false
};
var omdbCache = {};

function hasKey(){ return !!App.settings.get("tmdbKey"); }
function filtersActive(){
  var f = s.filters;
  return !!(f.genre || f.year || f.lang || f.minRating);
}

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
    description: m.description || "",
    genres: m.genre || m.genres || [],
    runtimeMin: parseRuntime(m.runtime)
  };
}

function parseRuntime(r){
  if(typeof r === "number") return r;
  var str = String(r || ""), h = str.match(/(\d+)\s*h/), mi = str.match(/(\d+)\s*m/);
  var v = (h ? Number(h[1]) * 60 : 0) + (mi ? Number(mi[1]) : 0);
  return v || 0;
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
    var q = (App.parse && m.filename) ? App.parse.name(m.filename).quality : "";
    return {
      kind: "cw", entry: h, type: m.type === "series" || m.type === "tv" ? "series" : "movie",
      season: m.season, episode: m.episode, quality: q || "", instant: !!(m.source && m.source !== "stremio"),
      id: imdb || h.key, imdb: imdb, name: h.title || m.showTitle || m.title || "",
      sub: h.subtitle || left, poster: h.poster || (imdb ? "https://images.metahub.space/poster/medium/" + imdb + "/img" : ""),
      background: imdb ? "https://images.metahub.space/background/medium/" + imdb + "/img" : (h.poster || ""),
      progress: h.dur ? Math.min(1, h.pos / h.dur) : 0, year: "", rating: "", description: left,
      genres: [], runtimeMin: h.dur ? Math.max(0, Math.round((h.dur - h.pos) / 60)) : 0
    };
  });
}

function buildRows(){
  var rows = [];
  rows.push({ id: "cw", label: "home.continue", state: "ready", items: continueItems(), hideEmpty: true });
  rows.push({ id: "calendar", label: "home.calendar", state: "ready", items: [], hideEmpty: true });
  if(App.trakt && App.trakt.isLinked()) rows.push({ id: "trakt", label: "home.trakt", state: "loading", items: [] });
  rows.push({ id: "because", label: "home.because", state: "ready", items: [], hideEmpty: true });
  rows.push({ id: "top10", label: hasKey() ? "home.top10Spain" : "home.top10Week", state: "loading", items: [] });
  if(filtersActive()){
    rows.push({ id: "fMovie", label: "home.filteredMovies", state: "loading", items: [], filt: "movie" });
    rows.push({ id: "fSeries", label: "home.filteredSeries", state: "loading", items: [], filt: "series" });
  } else {
    CATALOGS.forEach(function(c){ rows.push({ id: c.id, label: c.label, state: "loading", items: [], cat: c }); });
  }
  if(hasKey()){
    rows.push({ id: "cinema", label: "home.cinema", state: "ready", items: [], hideEmpty: true });
    rows.push({ id: "saga", label: "home.saga", state: "ready", items: [], hideEmpty: true });
  }
  return rows;
}

/* ---------- Utilidades de las filas nuevas ---------- */
function dayLabel(iso){
  var d = new Date(iso);
  if(isNaN(d.getTime())) return "";
  var now = new Date();
  var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var diff = Math.round((a - b) / 864e5);
  if(diff === 0) return App.t("home.today");
  if(diff === 1) return App.t("home.tomorrow");
  var wd = "";
  try{ wd = d.toLocaleDateString(App.i18n.tmdbLang(), { weekday: "short" }); }catch(e){}
  wd = String(wd).replace(/\.$/, "");
  return wd.charAt(0).toUpperCase() + wd.slice(1) + " " + d.getDate();
}

function tmdbCall(path, params){
  var key = String(App.settings.get("tmdbKey") || "");
  if(!key) return Promise.reject(new Error("No TMDB key"));
  var bearer = /^eyJ/.test(key) || key.length > 40;
  params = params || {};
  params.language = lang();
  if(!bearer) params.api_key = key;
  var q = Object.keys(params).map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
  var headers = { "Accept": "application/json" };
  if(bearer) headers["Authorization"] = "Bearer " + key;
  return App.net.fetch(TMDB_API + path + "?" + q, { headers: headers }).then(function(r){
    if(!r.ok) throw new Error("TMDB HTTP " + r.status);
    return r.json();
  });
}

/* Resultado de TMDB (movie|tv) → ítem de tarjeta; id "tmdb:N" se resuelve a IMDb al abrir */
function fromTmdb(o, type){
  var isTv = type === "series" || type === "tv";
  var date = isTv ? (o.first_air_date || "") : (o.release_date || "");
  var title = isTv ? (o.name || "") : (o.title || "");
  return {
    kind: "title", type: isTv ? "series" : "movie", id: "tmdb:" + o.id, imdb: "", name: title,
    poster: o.poster_path ? TMDB_IMG + o.poster_path : "",
    background: o.backdrop_path ? "https://image.tmdb.org/t/p/w780" + o.backdrop_path : "",
    year: date ? date.slice(0, 4) : "", date: date,
    rating: o.vote_average ? String(Math.round(o.vote_average * 10) / 10) : "",
    description: o.overview || "", genres: [], runtimeMin: 0
  };
}

function loadTop10(){
  var ck = "top10" + (hasKey() ? "k" : "");
  var cached = cacheGet(ck);
  if(cached) return Promise.resolve(cached);
  var p;
  if(hasKey()){
    /* Con clave: más vistos en plataformas de streaming de España (watch_region=ES) */
    var q = { watch_region: "ES", with_watch_monetization_types: "flatrate", sort_by: "popularity.desc", region: "ES" };
    p = Promise.all([
      tmdbCall("/discover/movie", q).then(function(j){ return (j.results || []).map(function(o){ return fromTmdb(o, "movie"); }); }),
      tmdbCall("/discover/tv", q).then(function(j){ return (j.results || []).map(function(o){ return fromTmdb(o, "series"); }); })
    ]);
  } else {
    /* Sin clave: tendencia semanal de TMDB (global) vía add-on, localizada */
    var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
    p = Promise.all(["movie", "series"].map(function(ty){
      return getJson(TMDB_ADDON + "/" + cfg + "/catalog/" + ty + "/tmdb.trending/genre=Week.json", 20000)
        .then(function(j){ return (j.metas || []).map(normMeta).filter(function(x){ return x.name; }); })
        .catch(function(){ return []; });
    }));
  }
  return p.then(function(r){
    var out = [], i = 0;
    while(out.length < 10 && (i < r[0].length || i < r[1].length)){
      if(r[0][i]) out.push(r[0][i]);
      if(out.length < 10 && r[1][i]) out.push(r[1][i]);
      i++;
    }
    out.forEach(function(it, n){ it.rank = n + 1; });
    if(out.length) cacheSet(ck, out);
    return out;
  });
}

function loadCalendar(){
  var jobs = [];
  if(App.follow && App.follow.upcoming) jobs.push(Promise.resolve(App.follow.upcoming()).catch(function(){ return []; }));
  if(App.trakt && App.trakt.isLinked() && App.trakt.calendar) jobs.push(App.trakt.calendar(14).catch(function(){ return []; }));
  if(!jobs.length) return Promise.resolve([]);
  return Promise.all(jobs).then(function(r){
    var seenK = {}, all = [];
    r.forEach(function(list){
      (list || []).forEach(function(e){
        var k = e.imdbId + ":" + e.season + ":" + e.episode;
        if(seenK[k] || !e.imdbId) return;
        seenK[k] = true; all.push(e);
      });
    });
    all.sort(function(a, b){ return String(a.released).localeCompare(String(b.released)); });
    return all.slice(0, 30).map(function(e){
      var ep = "S" + e.season + "E" + e.episode;
      return { kind: "title", type: "series", id: e.imdbId, imdb: e.imdbId, name: e.name, poster: e.poster || "",
               background: e.poster ? e.poster.replace("/poster/", "/background/") : "",
               year: "", rating: "", sub: dayLabel(e.released) + " · " + ep, season: e.season, episode: e.episode,
               today: dayLabel(e.released) === App.t("home.today"), when: dayLabel(e.released),
               description: ep + (e.title ? " · " + e.title : ""), genres: [], runtimeMin: 0 };
    });
  });
}

/* ---------- Porque viste X ---------- */
function lastWatched(){
  if(!App.history) return null;
  var l = App.history.list({});
  for(var i = 0; i < l.length; i++){
    var m = l[i].meta || {};
    if(m.imdbId && l[i].key.indexOf("live:") !== 0) return l[i];
  }
  return null;
}

function loadBecause(){
  var h = lastWatched();
  if(!h) return Promise.resolve({ name: "", items: [] });
  var m = h.meta || {};
  var type = (m.type === "series" || m.type === "tv" || (m.season !== undefined && m.season !== null)) ? "series" : "movie";
  var name = m.showTitle || m.title || h.title || "";
  var ck = "because:" + m.imdbId;
  var cached = cacheGet(ck);
  if(cached) return Promise.resolve({ name: name, items: cached });
  var metaP = App.meta && App.meta.title ? App.meta.title(type, m.imdbId).catch(function(){ return null; }) : Promise.resolve(null);
  return metaP.then(function(info){
    info = info || {};
    var tmdbId = m.tmdbId || info.tmdbId;
    if(hasKey() && tmdbId && App.meta.recommendations){
      return App.meta.recommendations(type === "series" ? "tv" : "movie", tmdbId).then(function(list){
        return list.map(function(x){
          return { kind: "title", type: type, id: "tmdb:" + x.tmdbId, imdb: "", name: x.title, poster: x.poster,
                   background: x.backdrop || x.poster, year: x.year ? String(x.year) : "",
                   rating: x.rating ? String(x.rating) : "", description: x.overview || "", genres: x.genres || [], runtimeMin: 0 };
        });
      });
    }
    /* Sin clave: populares del primer género de la ficha (vocabulario del add-on, ya localizado) */
    var g = (info.genres || [])[0];
    var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
    var url = TMDB_ADDON + "/" + cfg + "/catalog/" + type + "/tmdb.top" + (g ? "/genre=" + encodeURIComponent(g) : "") + ".json";
    return getJson(url, 20000).then(function(j){
      return (j.metas || []).map(normMeta).filter(function(x){
        return x.name && x.imdb !== m.imdbId && x.name !== name;
      });
    });
  }).then(function(list){
    list = list.slice(0, MAX_ITEMS);
    if(list.length) cacheSet(ck, list);
    return { name: name, items: list };
  });
}

/* ---------- Próximos estrenos de cine y sagas (requieren tmdbKey) ---------- */
function loadCinema(){
  var cached = cacheGet("cinema");
  if(cached) return Promise.resolve(cached);
  var region = lang().slice(3) || "US";
  var today = new Date().toISOString().slice(0, 10);
  return tmdbCall("/movie/upcoming", { region: region }).then(function(j){
    var list = (j.results || []).map(function(o){ return fromTmdb(o, "movie"); })
      .filter(function(x){ return x.poster && x.date >= today; })
      .sort(function(a, b){ return a.date.localeCompare(b.date); })
      .slice(0, MAX_ITEMS);
    list.forEach(function(x){ x.sub = x.date; x.rating = ""; });
    if(list.length) cacheSet("cinema", list);
    return list;
  });
}

/* Primera película del historial (o de la fila popular) que pertenezca a una colección */
function loadSaga(){
  var cached = cacheGet("saga");
  if(cached) return Promise.resolve(cached);
  var ids = [];
  if(App.history){
    App.history.list({}).forEach(function(h){
      var m = h.meta || {};
      if(m.tmdbId && m.type !== "series" && m.type !== "tv" && ids.indexOf(Number(m.tmdbId)) < 0) ids.push(Number(m.tmdbId));
    });
  }
  var pop = rowById("popMovie") || rowById("trendMovie");
  if(pop) pop.items.slice(0, 8).forEach(function(it){
    var mm = String(it.id).match(/^tmdb:(\d+)$/);
    if(mm && ids.indexOf(Number(mm[1])) < 0) ids.push(Number(mm[1]));
  });
  ids = ids.slice(0, 8);
  function next(i){
    if(i >= ids.length) return Promise.resolve({ name: "", items: [] });
    return tmdbCall("/movie/" + ids[i]).then(function(d){
      var c = d.belongs_to_collection;
      if(!c) return next(i + 1);
      return tmdbCall("/collection/" + c.id).then(function(col){
        var parts = (col.parts || []).filter(function(o){ return o.poster_path; })
          .sort(function(a, b){ return String(a.release_date || "").localeCompare(String(b.release_date || "")); })
          .map(function(o){ return fromTmdb(o, "movie"); });
        if(parts.length < 2) return next(i + 1);
        parts.forEach(function(x){ x.sub = x.year; x.rating = ""; });
        return { name: col.name || c.name, items: parts };
      });
    }).catch(function(){ return next(i + 1); });
  }
  return next(0).then(function(r){ if(r.items.length) cacheSet("saga", r); return r; });
}

/* ---------- Filtros (#21) ---------- */
function getManifest(){
  if(s.manifest) return Promise.resolve(s.manifest);
  var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
  return getJson(TMDB_ADDON + "/" + cfg + "/manifest.json", 20000).then(function(j){
    var o = { movie: { genre: [], year: [], lang: [] }, series: { genre: [], year: [], lang: [] } };
    (j.catalogs || []).forEach(function(c){
      var ex = (c.extra || []).filter(function(e){ return e.name === "genre" && e.options; })[0];
      if(!ex || !o[c.type]) return;
      if(c.id === "tmdb.top") o[c.type].genre = ex.options;
      else if(c.id === "tmdb.year") o[c.type].year = ex.options;
      else if(c.id === "tmdb.language") o[c.type].lang = ex.options;
    });
    s.manifest = o;
    return o;
  });
}

function addonCatalog(type, id, genre, skip){
  var cfg = TMDB_CFG[lang()] || TMDB_CFG["en-US"];
  var extra = (genre ? "genre=" + encodeURIComponent(genre) : "") + (skip ? (genre ? "&" : "") + "skip=" + skip : "");
  var url = TMDB_ADDON + "/" + cfg + "/catalog/" + type + "/" + id + (extra ? "/" + extra : "") + ".json";
  return getJson(url, 20000).then(function(j){ return (j.metas || []).map(normMeta).filter(function(x){ return x.name; }); })
    .catch(function(){ return []; });
}

function seriesGenre(man, g){
  var o = man.series.genre;
  if(o.indexOf(g) >= 0) return g;
  for(var i = 0; i < o.length; i++) if(o[i].indexOf(g) >= 0 || g.indexOf(o[i]) >= 0) return o[i];
  return null;
}

/* Origen según el filtro más selectivo (idioma > año > género); el resto se aplica en cliente */
function loadFiltered(type){
  var f = s.filters;
  return getManifest().then(function(man){
    var jobs = [], gen = f.genre;
    if(gen){
      var gg = type === "series" ? seriesGenre(man, gen) : (man.movie.genre.indexOf(gen) >= 0 ? gen : null);
      if(!gg) return [];
      gen = gg;
    }
    if(f.lang){
      if(man[type].lang.indexOf(f.lang) < 0) return [];
      jobs.push(addonCatalog(type, "tmdb.language", f.lang, 0), addonCatalog(type, "tmdb.language", f.lang, 20));
    } else if(f.year){
      var years = [];
      if(/s$/.test(f.year)){
        var d0 = Number(f.year.slice(0, 4));
        for(var y = d0 + 9; y >= d0; y--) if(man[type].year.indexOf(String(y)) >= 0) years.push(String(y));
      } else years.push(f.year);
      years.forEach(function(yy){ jobs.push(addonCatalog(type, "tmdb.year", yy, 0)); });
    } else {
      jobs.push(addonCatalog(type, "tmdb.top", gen, 0), addonCatalog(type, "tmdb.top", gen, 20));
    }
    return Promise.all(jobs).then(function(r){
      var seenK = {}, out = [];
      r.forEach(function(list){ list.forEach(function(it){
        if(!seenK[it.id]){ seenK[it.id] = true; out.push(it); }
      }); });
      return out.filter(function(it){
        if(gen && it.genres.length && it.genres.indexOf(gen) < 0) return false;
        if(f.year){
          var y2 = Number(it.year);
          if(/s$/.test(f.year)){ var d1 = Number(f.year.slice(0, 4)); if(!(y2 >= d1 && y2 <= d1 + 9)) return false; }
          else if(String(it.year) !== f.year) return false;
        }
        if(f.minRating && !(Number(it.rating) >= f.minRating)) return false;
        return true;
      }).slice(0, 40);
    });
  });
}

function openFilters(){
  getManifest().catch(function(){ return null; }).then(function(man){
    function summary(){
      var f = s.filters;
      return [
        { label: App.t("home.fGenre") + ": " + (f.genre || App.t("home.fAny")), value: "genre" },
        { label: App.t("home.fYear") + ": " + (f.year || App.t("home.fAny")), value: "year" },
        { label: App.t("home.fLang") + ": " + (f.lang || App.t("home.fAny")), value: "lang" },
        { label: App.t("home.fRating") + ": " + (f.minRating ? "≥ " + f.minRating : App.t("home.fAny")), value: "minRating" },
        { label: App.t("home.fApply"), value: "apply" },
        { label: App.t("home.fClear"), value: "clear" }
      ];
    }
    function pick(key, titleKey, opts){
      var items = [{ label: App.t("home.fAny"), value: "" }].concat(opts.map(function(o){
        return typeof o === "object" ? { label: String(o.label), value: o.value } : { label: String(o), value: o };
      }));
      items.forEach(function(it){ it.selected = String(s.filters[key]) === String(it.value); });
      return App.ui.menu(App.t(titleKey), items).then(function(v){
        if(v !== null) s.filters[key] = key === "minRating" ? Number(v) : v;
      });
    }
    function loop(){
      App.ui.menu(App.t("home.filters"), summary()).then(function(v){
        if(v === null || v === "apply"){ applyFilters(); return; }
        if(v === "clear"){ s.filters = { genre: "", year: "", lang: "", minRating: 0 }; applyFilters(); return; }
        var p;
        if(v === "genre"){
          var g = man ? man.movie.genre.concat(man.series.genre.filter(function(x){ return man.movie.genre.indexOf(x) < 0; })) : [];
          p = pick("genre", "home.fGenre", g);
        } else if(v === "year"){
          var ys = [{ label: "2020s", value: "2020s" }, { label: "2010s", value: "2010s" }, { label: "2000s", value: "2000s" }];
          p = pick("year", "home.fYear", ys.concat(man ? man.movie.year : []));
        } else if(v === "lang"){
          p = pick("lang", "home.fLang", man ? man.movie.lang : []);
        } else {
          p = pick("minRating", "home.fRating", [5, 6, 7, 8].map(function(n){ return { label: "≥ " + n, value: n }; }));
        }
        p.then(loop);
      });
    }
    loop();
  });
}

function applyFilters(){
  App.store.set("homefilters", s.filters);
  s.rows = buildRows(); render(); loadAll();
}

/* ---------- Ocultar vistos (#34) ---------- */
function refreshWatched(){
  var w = {};
  if(App.history){
    App.history.list({}).forEach(function(h){
      var m = h.meta || {};
      if(h.watched && m.imdbId && m.type !== "series" && m.type !== "tv" && (m.season === undefined || m.season === null)) w[m.imdbId] = true;
    });
  }
  Object.keys(s.seen).forEach(function(k){ w[k] = true; });
  s.watched = w;
  if(!(App.trakt && App.trakt.isLinked() && App.trakt.watchedIds)) return Promise.resolve();
  return App.trakt.watchedIds().then(function(o){
    Object.keys(o).forEach(function(k){ s.watched[k] = true; });
  });
}
function visible(r, list){
  if(r.id === "cw" || r.id === "calendar") return list;
  if(s.cat !== "all"){
    var want = s.cat === "series" ? "series" : "movie";
    list = list.filter(function(it){ return it.type === want; });
  }
  if(!App.settings.get("hideWatchedHome")) return list;
  return list.filter(function(it){ return !(it.imdb && s.watched[it.imdb]); });
}
function setItems(r, list){
  r.raw = list;
  r.items = visible(r, list);
}

/* ================= Render ================= */
function epText(it){
  if(it.season === undefined || it.season === null || it.episode === undefined || it.episode === null) return "";
  return App.t("v2home.ep", { s: it.season, e: (Number(it.episode) < 10 ? "0" : "") + it.episode });
}

function stillBlock(it){
  var src = it.background || it.poster || "";
  var alt = it.poster && it.poster !== src ? it.poster : "";
  return '<div class="lib-poster hm-still" style="' + App.ui.placeholderStyle(it.name) + '">' +
    '<div class="lib-initials">' + esc(App.ui.initials(it.name)) + '</div>' +
    (src ? '<img class="lib-img" loading="lazy" alt="" data-src="' + esc(src) + '"' + (alt ? ' data-alt="' + esc(alt) + '"' : '') + '>' : '') +
    '</div>';
}

/* Tarjeta 16:9 grande (Continuar viendo) */
function wideCardHtml(r, it, i){
  var pct = Math.round((it.progress || 0) * 100);
  return '<div class="lib-card hm-wide focusable" data-key="' + esc(r.id + ":" + i) + '" data-r="' + esc(r.id) + '" data-i="' + i + '">' +
    stillBlock(it) +
    '<div class="hm-wide-info">' +
      '<div class="hm-wide-title">' + esc(it.name) + '</div>' +
      '<div class="hm-wide-sub num">' + esc(it.sub || "") + '</div>' +
      (pct ? '<div class="hm-bar"><i style="width:' + pct + '%"></i></div>' : '') +
    '</div></div>';
}

/* Tarjeta compacta (nuevos episodios de lo que sigues) */
function compactCardHtml(r, it, i){
  var ep = epText(it);
  return '<div class="hm-compact focusable' + (it.today ? ' ready' : '') + '" data-key="' + esc(r.id + ":" + i) + '" data-r="' + esc(r.id) + '" data-i="' + i + '">' +
    '<div class="lib-poster hm-mini" style="' + App.ui.placeholderStyle(it.name) + '">' +
      '<div class="lib-initials">' + esc(App.ui.initials(it.name)) + '</div>' +
      (it.poster ? '<img class="lib-img" loading="lazy" alt="" data-src="' + esc(it.poster) + '">' : '') +
    '</div>' +
    '<div class="hm-compact-txt"><div class="hm-compact-title">' + esc(it.name + (ep ? " · " + ep : "")) + '</div>' +
      '<div class="hm-compact-when">' + esc(it.today ? App.t("v2home.readyToday") : (it.when || "")) + '</div></div></div>';
}

function cardHtml(r, it, i){
  if(r.id === "cw") return wideCardHtml(r, it, i);
  if(r.id === "calendar") return compactCardHtml(r, it, i);
  var key = r.id + ":" + i;
  var badge = it.kind === "title" ? (it.type === "series" ? App.t("home.series") : "") : "";
  return '<div class="lib-card lib-card-sm home-card focusable" data-key="' + esc(key) + '" data-r="' + esc(r.id) + '" data-i="' + i + '">' +
    '<div class="lib-poster" style="' + App.ui.placeholderStyle(it.name) + '">' +
      '<div class="lib-initials">' + esc(App.ui.initials(it.name)) + '</div>' +
      (it.poster ? '<img class="lib-img" loading="lazy" alt="" data-src="' + esc(it.poster) + '">' : '') +
      (badge ? '<span class="lib-badge">' + esc(badge.toUpperCase()) + '</span>' : '') +
      (it.rating ? '<span class="lib-rating">★ ' + esc(it.rating) + '</span>' : '') +
      (it.rank ? '<span class="home-rank num">' + it.rank + '</span>' : '') +
    '</div>' +
    '<div class="lib-card-title">' + esc(it.name) + '</div>' +
    '<div class="lib-card-sub num">' + esc(it.sub || it.year || "") + '</div>' +
  '</div>';
}

function rowHtml(r){
  if(r.hideEmpty && r.state === "ready" && !r.items.length) return '<div class="home-row" data-row="' + esc(r.id) + '" hidden></div>';
  var body;
  if(r.state === "loading") body = '<div class="home-row-state"><div class="spinner home-spin"></div>' + esc(App.t("home.loadingRow")) + '</div>';
  else if(r.state === "error") body = '<div class="home-row-state err">' + esc(App.t("home.rowError")) + '</div>';
  else if(!r.items.length) body = '<div class="home-row-state">' + esc(App.t("home.rowEmpty")) + '</div>';
  else body = '<div class="hscroll home-hscroll">' + r.items.map(function(it, i){ return cardHtml(r, it, i); }).join("") + '</div>';
  var title = r.id === "calendar" ? App.t("v2home.newEpisodes") : (r.title || App.t(r.label));
  return '<div class="home-row home-row-' + esc(r.id) + '" data-row="' + esc(r.id) + '">' +
    '<div class="home-row-title">' + esc(title) + '</div>' + body + '</div>';
}

/* ---------- Hero ---------- */
function followed(it){ return !!(App.follow && it.imdb && App.follow.isFollowing(it.imdb)); }

/* Datos de la ficha enriquecidos (Cinemeta/TMDB localizados) para el título enfocado */
function facts(it){
  var inf = (it.imdb && s.info[it.imdb]) || {};
  return {
    year: it.year || inf.year || "", rating: it.rating || inf.rating || "",
    genres: (it.genres && it.genres.length) ? it.genres : (inf.genres || []),
    description: it.description && it.kind !== "cw" ? it.description : (inf.description || it.description || ""),
    seasons: inf.seasons || 0
  };
}

function loadInfo(it){
  if(!it.imdb || s.info[it.imdb] !== undefined || !App.meta || !App.meta.title) return;
  s.info[it.imdb] = null;
  App.meta.title(it.type === "series" ? "series" : "movie", it.imdb).then(function(m){
    if(!m) return;
    var seasons = {};
    (m.videos || []).forEach(function(v){ if(v.season > 0) seasons[v.season] = 1; });
    s.info[it.imdb] = {
      year: m.releaseInfo ? String(m.releaseInfo).slice(0, 4) : "", rating: /^\d/.test(String(m.imdbRating || "")) ? String(m.imdbRating) : "",
      genres: m.genres || [], description: m.description || "", seasons: Object.keys(seasons).length
    };
    if(s.heroItem === it) renderHeroInfo();
  }).catch(function(){ delete s.info[it.imdb]; });
}

function heroButtons(it){
  var primaryLabel, playIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>';
  var showSheet = false;
  if(it.kind === "cw"){
    var ep = epText(it);
    primaryLabel = ep ? App.t("v2home.resume", { ep: ep }) : App.t("v2home.resumeBare");
    showSheet = !!it.imdb;
  } else if(it.type === "movie"){
    primaryLabel = App.t("v2home.play"); showSheet = true;
  } else primaryLabel = App.t("v2home.viewSheet");
  var canFollow = !!(App.follow && it.type === "series" && it.imdb);
  var tags = "";
  if(it.kind === "cw"){
    if(it.quality) tags += '<span class="hm-tag">' + esc(it.quality) + '</span>';
    if(it.instant) tags += '<span class="hm-instant">● ' + esc(App.t("v2home.instant")) + '</span>';
  }
  return '<div class="hm-btns">' +
    '<div class="hm-btn hm-btn-main focusable" data-act="hplay" data-key="hero:play">' + playIcon + '<span>' + esc(primaryLabel) + '</span></div>' +
    (showSheet ? '<div class="hm-btn focusable" data-act="hsheet" data-key="hero:sheet">' + esc(App.t("v2home.sheet")) + '</div>' : '') +
    (canFollow ? '<div class="hm-btn focusable' + (followed(it) ? ' on' : '') + '" data-act="hfollow" data-key="hero:follow">' +
      esc(followed(it) ? App.t("v2home.following") : "+ " + App.t("v2home.follow")) + '</div>' : '') +
    (tags ? '<span class="hm-tags">' + tags + '</span>' : '') +
  '</div>';
}

function heroInfoHtml(it){
  if(!it){
    return '<div class="hm-title" id="homeHeroTitle">' + esc(App.t("home.welcomeTitle")) + '</div>' +
      '<p class="hm-desc">' + esc(App.t("home.welcomeText")) + '</p>';
  }
  var f = facts(it), bits = [];
  if(f.year) bits.push(f.year);
  if(it.type === "series" && f.seasons) bits.push(App.t("v2home.seasonsN", { n: f.seasons }));
  if(f.genres.length) bits.push(f.genres.slice(0, 3).join(", "));
  if(it.sub && it.kind !== "cw") bits.push(it.sub);
  if(it.type === "movie" && it.runtimeMin && it.kind !== "cw"){
    bits.push(fmtDur(it.runtimeMin));
    bits.push(App.t("home.endsAt", { time: endsAt(it.runtimeMin) }));
  }
  var ox = it.imdb && omdbCache[it.imdb];
  var html = '<div class="hm-meta num"><span class="hm-type">' + esc(it.type === "series" ? App.t("home.series") : App.t("home.movie")) + '</span>' +
    '<span>' + esc(bits.join(" · ")) + '</span>' +
    (f.rating ? '<span class="hm-star">★ ' + esc(f.rating) + '</span>' : '') +
    (ox ? '<span>' + esc(ox) + '</span>' : '') + '</div>' +
    '<div class="hm-title" id="homeHeroTitle">' + esc(it.name) + '</div>' +
    '<p class="hm-desc">' + esc(f.description) + '</p>' +
    heroButtons(it);
  if(it.kind === "cw" && it.progress){
    var min = it.runtimeMin || 0;
    html += '<div class="hm-prog"><div class="hm-bar hm-bar-lg"><i style="width:' + Math.round(it.progress * 100) + '%"></i></div>' +
      (min ? '<span class="num">' + esc(App.t("v2home.leftEnds", { time: fmtDur(min), end: endsAt(min) })) + '</span>' : '') + '</div>';
  }
  return html;
}

function heroHtml(){
  return '<div class="home-hero-bg" id="homeHeroBg"></div><div class="home-hero-shade"></div>';
}

function chipsHtml(){
  var fl = filtersActive();
  function chip(cat, label){
    return '<div class="hm-chip focusable' + (s.cat === cat ? ' on' : '') + '" data-act="cat" data-cat="' + cat + '" data-key="chip:' + cat + '">' + esc(App.t(label)) + '</div>';
  }
  return '<div class="home-chips">' + chip("all", "v2home.chipForYou") + chip("series", "v2home.chipSeries") + chip("movies", "v2home.chipMovies") +
    '<div class="hm-chip focusable' + (fl ? ' on' : '') + '" data-act="filters" data-key="chip:filters">' + esc(App.t(fl ? "home.chipFiltersOn" : "home.chipFilters")) + '</div>' +
  '</div>';
}

function render(){
  s.el.innerHTML = heroHtml() + '<div class="scroll home-scroll" id="homeScroll">' + chipsHtml() +
    '<div class="hm-hero-info" id="homeHeroInfo">' + heroInfoHtml(s.heroItem) + '</div>' +
    s.rows.map(rowHtml).join("") + '</div>';
  hookImages(s.el);
  mountGrid();
  if(s.heroItem) loadInfo(s.heroItem);
}

/* Repinta solo el bloque de información del hero conservando el foco por clave (sin desplazar) */
function renderHeroInfo(){
  if(!s.el) return;
  var box = s.el.querySelector("#homeHeroInfo");
  if(!box) return;
  box.innerHTML = heroInfoHtml(s.heroItem);
  syncGrid();
}
function syncGrid(){
  if(!s.grid) return;
  var cur = s.focusKey;
  s.grid.refresh(false);
  var idx = -1;
  for(var i = 0; i < s.grid.items.length; i++){
    if(s.grid.items[i].getAttribute("data-key") === cur){ idx = i; break; }
  }
  if(idx < 0) idx = Math.min(s.grid.index, s.grid.items.length - 1);
  s.grid.index = Math.max(0, idx);
  if(document.body.classList.contains("zone-header") || App.current() !== "home") s.grid.blur(); else s.grid.paint();
}

function hookImages(root){
  Array.prototype.forEach.call(root.querySelectorAll("img.lib-img[data-src]"), function(img){
    var src = img.getAttribute("data-src");
    var alt = img.getAttribute("data-alt");
    img.removeAttribute("data-src");
    img.onload = function(){ if(img.parentNode) img.parentNode.classList.add("has-img"); };
    img.onerror = function(){
      if(alt){ var a = alt; alt = ""; img.src = a; return; }
      if(img.parentNode) img.parentNode.removeChild(img);
    };
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
    onSelect: function(i, el){
      var act = el.getAttribute("data-act");
      if(act) return chipAction(act, el);
      open(el);
    }
  });
  restoreFocus(s.focusKey || "hero:play", false);
}

/* Al llegar el primer hero, el foco inicial pasa del chip al botón principal */
function focusHeroPlay(){
  if(s.autoFocused || !s.grid) return;
  if(s.focusKey && s.focusKey.indexOf("chip:") !== 0) return;
  for(var i = 0; i < s.grid.items.length; i++){
    if(s.grid.items[i].getAttribute("data-key") === "hero:play"){
      s.autoFocused = true;
      s.focusKey = "hero:play";
      if(!document.body.classList.contains("zone-header") && App.current() === "home") s.grid.focus(i, true);
      else s.grid.index = i;
      return;
    }
  }
}

/* ================= Hero ================= */
function itemOf(el){
  if(!el) return null;
  var r = rowById(el.getAttribute("data-r"));
  return r ? r.items[Number(el.getAttribute("data-i"))] : null;
}
function scheduleHero(el){
  clearTimeout(s.heroTimer);
  if(!el || !el.getAttribute("data-r")) return;
  s.heroTimer = setTimeout(function(){ paintHero(itemOf(el)); }, 250);
}
function fmtDur(min){
  var h = Math.floor(min / 60), m = min % 60;
  return h ? h + "h " + (m < 10 ? "0" : "") + m + "m" : m + "m";
}
function endsAt(min){
  var d = new Date(Date.now() + min * 60000);
  return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
}

/* #35 Notas de Rotten Tomatoes y Metacritic vía OMDb (solo con omdbKey) */
function omdbRatings(imdb){
  var key = String(App.settings.get("omdbKey") || "").trim();
  if(!key || !imdb) return Promise.resolve("");
  if(omdbCache[imdb] !== undefined) return Promise.resolve(omdbCache[imdb]);
  return getJson("https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&i=" + encodeURIComponent(imdb), 8000).then(function(j){
    var out = [];
    (j.Ratings || []).forEach(function(r){
      if(r.Source === "Rotten Tomatoes") out.push("RT " + r.Value);
      else if(r.Source === "Metacritic") out.push("MC " + String(r.Value).split("/")[0]);
    });
    omdbCache[imdb] = out.join(" · ");
    return omdbCache[imdb];
  }).catch(function(){ return ""; });
}

function paintHero(it){
  if(!it || !s.el) return;
  s.heroItem = it;
  renderHeroInfo();
  loadInfo(it);
  if(it.imdb && omdbCache[it.imdb] === undefined) omdbRatings(it.imdb).then(function(txt){
    if(txt && s.heroItem === it) renderHeroInfo();
  });
  var bg = s.el.querySelector("#homeHeroBg");
  if(bg){
    var url = it.background || it.poster || "";
    if(!url){ bg.classList.remove("on"); return; }
    var img = new Image();
    img.onload = function(){
      if(!s.el || s.heroItem !== it) return;
      bg.style.backgroundImage = "url('" + url.replace(/'/g, "%27") + "')";
      bg.classList.add("on");
    };
    img.onerror = function(){
      if(it.poster && it.poster !== url){
        var i2 = new Image();
        i2.onload = function(){ if(s.heroItem === it){ bg.style.backgroundImage = "url('" + it.poster.replace(/'/g, "%27") + "')"; bg.classList.add("on"); } };
        i2.onerror = function(){ bg.classList.remove("on"); };
        i2.src = it.poster;
      } else bg.classList.remove("on");
    };
    img.src = url;
  }
}

/* ================= Acciones ================= */
function chipAction(act, el){
  if(act === "filters") openFilters();
  else if(act === "surprise") surprise();
  else if(act === "reload") reloadAll();
  else if(act === "cat") setCategory(el.getAttribute("data-cat"));
  else if(act === "hplay") heroPlay(s.heroItem);
  else if(act === "hsheet" && s.heroItem) openSheet(s.heroItem);
  else if(act === "hfollow" && s.heroItem){
    var it = s.heroItem;
    App.follow.toggle({ imdbId: it.imdb, name: it.name, poster: it.poster });
    renderHeroInfo();
  }
}

/* Chips de categoría: Para ti / Series / Películas (filtra las filas de catálogo) */
function setCategory(cat){
  if(cat === s.cat) return;
  s.cat = cat;
  Array.prototype.forEach.call(s.el.querySelectorAll(".hm-chip[data-act='cat']"), function(c){
    c.classList.toggle("on", c.getAttribute("data-cat") === cat);
  });
  s.rows.forEach(function(r){ if(r.raw){ r.items = visible(r, r.raw); updateRow(r); } });
}

function heroPlay(it){
  if(!it) return;
  if(it.kind === "cw"){ resume(it.entry); return; }
  if(it.type === "movie" && App.search && App.search.playTitle){
    resolveImdb(it).then(function(imdb){
      if(!imdb) throw new Error("sin imdb");
      return App.search.playTitle({ type: "movie", id: imdb, name: it.name, poster: it.poster });
    }).catch(function(e){ console.warn("[home] reproducir:", e && e.message); App.ui.toast(App.t("home.resolveFail")); });
    return;
  }
  openSheet(it);
}

function reloadAll(){
  App.store.remove(CACHE_KEY);
  App.ui.toast(App.t("home.refreshed"));
  s.rows = buildRows(); render(); loadAll();
}

/* #33 Sorpréndeme: título aleatorio con nota >= 7 de lo ya cargado (idioma de contenido) */
function surprise(){
  var pool = [], seenId = {};
  s.rows.forEach(function(r){
    if(r.id === "cw" || r.id === "calendar" || r.id === "cinema") return;
    (r.items || []).forEach(function(it){
      if(it.kind !== "title" || seenId[it.id]) return;
      seenId[it.id] = true;
      if(it.imdb && s.watched[it.imdb]) return;
      pool.push(it);
    });
  });
  var good = pool.filter(function(it){ return Number(it.rating) >= 7; });
  if(!good.length) good = pool;
  if(!good.length){ App.ui.toast(App.t("home.surpriseNone")); return; }
  var it = good[Math.floor(Math.random() * good.length)];
  App.ui.toast(App.t("home.surpriseOpen", { name: it.name }));
  openItem(it);
}

function markSeen(it){
  if(!it) return;
  if(it.kind === "cw"){
    if(App.history) App.history.markWatched(it.entry.key);
    App.ui.toast(App.t("home.markedSeen"));
    return;
  }
  resolveImdb(it).then(function(imdb){
    if(!imdb) throw new Error("sin imdb");
    s.seen[imdb] = 1; s.watched[imdb] = true;
    App.store.set("homeSeen", s.seen);
    if(App.trakt && App.trakt.isLinked() && it.type === "movie"){
      App.trakt.call("/sync/history", { method: "POST", auth: true, body: { movies: [{ ids: { imdb: imdb } }] } })
        .catch(function(e){ console.warn("[home] Trakt history:", e.message); });
    }
    s.rows.forEach(function(r){ if(r.raw){ r.items = visible(r, r.raw); updateRow(r); } });
    App.ui.toast(App.t("home.markedSeen"));
  }).catch(function(){ App.ui.toast(App.t("home.resolveFail")); });
}

function actionsList(){
  var el = s.grid && s.grid.current ? s.grid.current() : null;
  var it = el ? itemOf(el) : null;
  if(!it && el && String(el.getAttribute("data-key") || "").indexOf("hero:") === 0) it = s.heroItem;
  var list = [];
  if(it){
    list.push({ label: App.t("home.actOpen"), run: function(){ openItem(it); } });
    if(App.follow && it.type === "series" && (it.imdb || /^tt/.test(it.id))){
      var imdb = it.imdb || it.id;
      var on = App.follow.isFollowing(imdb);
      list.push({ label: App.t(on ? "home.actUnfollow" : "home.actFollow"), run: function(){
        App.follow.toggle({ imdbId: imdb, name: it.name, poster: it.poster });
      } });
    }
    list.push({ label: App.t("home.actSeen"), run: function(){ markSeen(it); } });
    if(it.kind === "cw" && App.history) list.push({ label: App.t("library.act.dropContinue"), run: function(){
      App.history.remove(it.entry.key); App.ui.toast(App.t("library.droppedContinue"));
    } });
  }
  list.push({ label: App.t("home.actSurprise"), run: surprise });
  list.push({ label: App.t("home.actFilters"), run: openFilters });
  if(filtersActive()) list.push({ label: App.t("home.fClear"), run: function(){
    s.filters = { genre: "", year: "", lang: "", minRating: 0 }; applyFilters();
  } });
  list.push({ label: App.t("home.actReload"), run: reloadAll });
  return list;
}

function open(el){
  var it = itemOf(el);
  if(!it) return;
  openItem(it);
}

function openItem(it){
  if(it.kind === "cw") return resume(it.entry);
  openSheet(it);
}

function openSheet(it){
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
  function ok(r, list){
    if(id !== s.reqId) return false;
    setItems(r, list); r.state = "ready"; updateRow(r);
    return true;
  }
  function fail(r, tag, e){
    if(id !== s.reqId) return;
    console.warn("[home] " + tag + ":", e && e.message);
    r.state = "error"; updateRow(r);
  }
  refreshWatched().catch(function(){}).then(function(){
    if(id !== s.reqId) return;
    s.rows.forEach(function(r){
      if(r.id === "trakt"){
        App.trakt.watchlist().then(function(list){
          ok(r, list.slice(0, MAX_ITEMS).map(function(x){
            return { kind: "title", type: x.type, id: x.id, imdb: x.id, name: x.name, poster: x.poster,
                     background: x.background, year: x.year || "", rating: "", description: "", genres: [], runtimeMin: 0 };
          }));
        }).catch(function(e){ fail(r, "Trakt", e); });
      } else if(r.id === "calendar"){
        loadCalendar().then(function(list){ ok(r, list); }).catch(function(e){ console.warn("[home] calendario:", e.message); });
      } else if(r.id === "because"){
        loadBecause().then(function(res){
          if(!res.items.length) return;
          r.title = App.t("home.because", { name: res.name });
          ok(r, res.items);
        }).catch(function(e){ console.warn("[home] because:", e.message); });
      } else if(r.id === "top10"){
        loadTop10().then(function(list){
          if(ok(r, list) && !s.heroItem && list.length && App.current() === "home"){ paintHero(list[0]); focusHeroPlay(); }
        }).catch(function(e){ fail(r, "top10", e); });
      } else if(r.id === "cinema"){
        loadCinema().then(function(list){ ok(r, list); }).catch(function(e){ console.warn("[home] cine:", e.message); });
      } else if(r.filt){
        loadFiltered(r.filt).then(function(list){ ok(r, list); }).catch(function(e){ fail(r, "filtro " + r.filt, e); });
      } else if(r.cat){
        loadCatalog(r.cat).then(function(list){
          if(ok(r, list) && !s.heroItem && list.length && App.current() === "home"){ paintHero(list[0]); focusHeroPlay(); }
        }).catch(function(e){ fail(r, "fila " + r.id, e); });
      }
    });
    if(hasKey()){
      var sr = rowById("saga");
      /* las sagas salen de la fila de populares: se espera un poco a que cargue */
      setTimeout(function(){
        if(id !== s.reqId || !sr) return;
        loadSaga().then(function(res){
          if(!res.items.length) return;
          sr.title = App.t("home.saga", { name: res.name });
          ok(sr, res.items);
        }).catch(function(e){ console.warn("[home] saga:", e.message); });
      }, 2500);
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

/* ================= Ajustes (grupo Inicio) ================= */
if(App.settingsUI){
  App.settingsUI.add("settings.group.home", {
    id: "hideWatchedHome", type: "bool",
    label: function(){ return App.t("home.setHideWatched"); },
    desc: function(){ return App.t("home.setHideWatchedDesc"); }
  });
  App.settingsUI.add("settings.group.home", {
    id: "omdbKey", type: "secret",
    label: function(){ return App.t("home.setOmdb"); },
    desc: function(){ return App.t("home.setOmdbDesc"); },
    value: function(){ return App.settings.get("omdbKey") ? "••••" : App.t("home.setOmdbNone"); },
    after: function(){ omdbCache = {}; }
  });
  App.settingsUI.add("settings.group.home", {
    id: "homeClearFilters", type: "action",
    label: function(){ return App.t("home.setClearFilters"); },
    run: function(){
      s.filters = { genre: "", year: "", lang: "", minRating: 0 };
      App.store.set("homefilters", s.filters);
      App.ui.toast(App.t("home.filtersCleared"));
    }
  });
}

/* ================= Pantalla ================= */
App.screens.register({
  id: "home", nav: true, order: 5,
  get label(){ return App.t("nav.home"); },
  get hint(){ return App.t("v2home.hint"); },
  actions: actionsList,
  mount: function(el){
    s.el = el;
    el.classList.add("home-screen");
    s.rows = buildRows();
    var cw0 = rowById("cw");
    if(cw0 && cw0.items.length) s.heroItem = cw0.items[0];
    render();
    if(s.heroItem) paintHero(s.heroItem);
    loadAll();
    s.mounted = true;
    App.bus.on("history:change", function(){
      if(App.current() === "home") refreshContinue(); else s.cwDirty = true;
    });
    App.bus.on("trakt:change", function(){
      s.rows = buildRows(); render(); loadAll();
    });
    App.bus.on("follow:change", function(){
      renderHeroInfo();
      var r = rowById("calendar");
      if(!r) return;
      loadCalendar().then(function(list){ setItems(r, list); updateRow(r); }).catch(function(){});
    });
    App.bus.on("settings:change", function(d){
      if(d && (d.key === "hideWatchedHome" || d.key === "tmdbKey")){ s.rows = buildRows(); render(); loadAll(); }
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
    if(k === K.RED){ reloadAll(); return true; }
    if(k === K.GREEN){ openFilters(); return true; }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
