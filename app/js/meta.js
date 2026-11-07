/* meta.js — metadatos TMDB (carátulas, nota, sinopsis, temporadas, recomendaciones) con caché. */
(function(){
"use strict";

var App = window.App;
var M = App.meta = App.meta || {};

var BASE = "https://api.themoviedb.org/3";
var IMG = "https://image.tmdb.org/t/p/";
var TTL = 14 * 864e5, MISS_TTL = 864e5, MAX_ENTRIES = 400;

M.img = function(path, size){ return path ? IMG + (size || "w342") + path : ""; };
M.hasKey = function(){ return !!App.settings.get("tmdbKey"); };

/* ---------------- Caché persistente (LRU) ---------------- */
var cache = App.store.get("metacache", {}) || {};
var saveSoon = App.debounce(function(){
  var keys = Object.keys(cache);
  if(keys.length > MAX_ENTRIES){
    keys.sort(function(a, b){ return (cache[a].a || 0) - (cache[b].a || 0); });
    keys.slice(0, keys.length - MAX_ENTRIES).forEach(function(k){ delete cache[k]; });
  }
  App.store.set("metacache", cache);
}, 1500);

function cget(k){
  var e = cache[k];
  if(!e) return undefined;
  var age = Date.now() - e.t;
  if(age > (e.miss ? MISS_TTL : (e.ttl || TTL))){ delete cache[k]; return undefined; }
  e.a = Date.now();
  return e.miss ? null : e.v;
}
function cset(k, v, ttl){
  cache[k] = v === null ? { t: Date.now(), a: Date.now(), miss: true } : { t: Date.now(), a: Date.now(), v: v };
  if(ttl && v !== null) cache[k].ttl = ttl;
  saveSoon();
}
M.clearCache = function(){ cache = {}; App.store.set("metacache", cache); };

/* Idioma de contenido (sinopsis, episodios, pósters localizados) */
function lang(){ return (App.i18n && App.i18n.tmdbLang) ? App.i18n.tmdbLang() : "en-US"; }
M.lang = lang;

/* Si cambia la clave, la caché de "no encontrado" deja de valer (el idioma recarga la app) */
App.bus.on("settings:change", function(d){
  if(d && d.key === "tmdbKey"){
    Object.keys(cache).forEach(function(k){ if(cache[k].miss) delete cache[k]; });
    saveSoon();
  }
});

/* ---------------- Cola con concurrencia 4 ---------------- */
var queue = [], running = 0, CONC = 4;
function enqueue(fn){
  return new Promise(function(resolve, reject){
    queue.push({ fn: fn, resolve: resolve, reject: reject });
    pump();
  });
}
function pump(){
  while(running < CONC && queue.length){
    var job = queue.shift();
    running++;
    job.fn().then(job.resolve, job.reject).then(function(){ running--; pump(); });
  }
}

/* Deduplicar peticiones en vuelo */
var inflight = {};
function once(key, fn){
  if(inflight[key]) return inflight[key];
  var p = fn().then(function(v){ delete inflight[key]; return v; },
                    function(e){ delete inflight[key]; throw e; });
  inflight[key] = p;
  return p;
}

/* ---------------- HTTP ---------------- */
function tmdb(path, params){
  var key = App.settings.get("tmdbKey") || "";
  if(!key) return Promise.reject(new Error("No TMDB key"));
  var bearer = /^eyJ/.test(key) || key.length > 40;
  var q = [];
  params = params || {};
  params.language = params.language || lang();
  if(!bearer) params.api_key = key;
  Object.keys(params).forEach(function(k){
    if(params[k] !== undefined && params[k] !== null && params[k] !== "")
      q.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
  });
  var headers = { "Accept": "application/json" };
  if(bearer) headers["Authorization"] = "Bearer " + key;
  return enqueue(function(){
    return App.net.fetch(BASE + path + (q.length ? "?" + q.join("&") : ""), { headers: headers })
      .then(function(r){
        if(r.status === 401) throw new Error(App.t("meta.badKey"));
        if(!r.ok) throw new Error("TMDB HTTP " + r.status);
        return r.json();
      });
  });
}

/* ---------------- Normalización ---------------- */
function norm(o, type){
  if(!o) return null;
  var t = type || o.media_type || (o.first_air_date !== undefined || o.name !== undefined ? "tv" : "movie");
  var date = t === "tv" ? (o.first_air_date || "") : (o.release_date || "");
  return {
    tmdbId: o.id,
    type: t,
    title: t === "tv" ? (o.name || o.original_name || "") : (o.title || o.original_title || ""),
    originalTitle: t === "tv" ? o.original_name : o.original_title,
    year: date ? +date.slice(0, 4) : null,
    poster: M.img(o.poster_path, "w342"),
    posterLarge: M.img(o.poster_path, "w500"),
    backdrop: M.img(o.backdrop_path, "w780"),
    rating: o.vote_average ? Math.round(o.vote_average * 10) / 10 : null,
    votes: o.vote_count || 0,
    overview: o.overview || "",
    genres: (o.genres || []).map(function(g){ return g.name; }),
    seasons: o.number_of_seasons || null,
    episodes: o.number_of_episodes || null,
    runtime: o.runtime || (o.episode_run_time && o.episode_run_time[0]) || null,
    seasonList: (o.seasons || []).map(function(s){
      return { season: s.season_number, name: s.name, episodes: s.episode_count, poster: M.img(s.poster_path, "w342") };
    })
  };
}

function bestMatch(results, title, year, type){
  if(!results || !results.length) return null;
  var nt = App.parse ? App.parse.norm(title) : String(title).toLowerCase();
  var best = null, bestScore = -1;
  results.slice(0, 10).forEach(function(r, i){
    var n = norm(r, type);
    var s = 10 - i;                                       // orden de TMDB
    var a = App.parse ? App.parse.norm(n.title) : n.title.toLowerCase();
    var b = App.parse ? App.parse.norm(n.originalTitle || "") : "";
    if(a === nt || b === nt) s += 20;
    if(year && n.year){ if(n.year === year) s += 15; else if(Math.abs(n.year - year) <= 1) s += 8; }
    s += Math.min(10, Math.log(1 + (r.popularity || 0)) * 2);
    if(!n.poster) s -= 5;
    if(s > bestScore){ bestScore = s; best = n; }
  });
  return best;
}

function search(type, title, year){
  var params = { query: title, include_adult: "false" };
  if(year) params[type === "tv" ? "first_air_date_year" : "year"] = year;
  return tmdb("/search/" + type, params).then(function(j){
    return bestMatch(j.results, title, year, type);
  });
}

/* ---------------- API pública ---------------- */

/* lookup({title, year, type}) → Promise<meta|null> */
M.lookup = function(q){
  if(!q || !q.title || !M.hasKey()) return Promise.resolve(null);
  var type = q.type === "tv" ? "tv" : "movie";
  var other = type === "tv" ? "movie" : "tv";
  var ck = "l:" + lang() + ":" + type + ":" + (App.parse ? App.parse.norm(q.title) : q.title) + ":" + (q.year || "");
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit);
  return once(ck, function(){
    return search(type, q.title, q.year)
      .then(function(r){ return r || (q.year ? search(type, q.title, null) : null); })
      .then(function(r){ return r || search(other, q.title, q.year); })
      .then(function(r){ return r || (q.year ? search(other, q.title, null) : null); })
      .then(function(r){ cset(ck, r || null); return r || null; })
      .catch(function(e){ console.warn("[meta] lookup", q.title, e.message); return null; });
  });
};

/* details(type, id) → meta ampliado (géneros, nº temporadas, runtime…) */
M.details = function(type, id){
  if(!id || !M.hasKey()) return Promise.resolve(null);
  var ck = "d:" + lang() + ":" + type + ":" + id;
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit);
  return once(ck, function(){
    return tmdb("/" + type + "/" + id, { append_to_response: "external_ids" }).then(function(j){
      var n = norm(j, type);
      n.imdbId = j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || "";
      cset(ck, n); return n;
    }).catch(function(e){ console.warn("[meta] details", e.message); return null; });
  });
};

/* season(tvId, n) → {season, name, overview, episodes:[{episode, name, overview, still, runtime, rating, airDate}]} */
M.season = function(tvId, n){
  if(!tvId || !M.hasKey()) return Promise.resolve(null);
  var ck = "s:" + lang() + ":" + tvId + ":" + n;
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit);
  return once(ck, function(){
    return tmdb("/tv/" + tvId + "/season/" + n).then(function(j){
      var v = {
        season: j.season_number, name: j.name || "", overview: j.overview || "",
        poster: M.img(j.poster_path, "w342"),
        episodes: (j.episodes || []).map(function(e){
          return {
            episode: e.episode_number, name: e.name || "", overview: e.overview || "",
            still: M.img(e.still_path, "w300"), runtime: e.runtime || null,
            rating: e.vote_average ? Math.round(e.vote_average * 10) / 10 : null,
            airDate: e.air_date || ""
          };
        })
      };
      cset(ck, v); return v;
    }).catch(function(e){ console.warn("[meta] season", e.message); return null; });
  });
};

/* recommendations(type, id) → meta[] (si no hay, usa "similar") */
M.recommendations = function(type, id){
  if(!id || !M.hasKey()) return Promise.resolve([]);
  var ck = "r:" + lang() + ":" + type + ":" + id;
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit || []);
  return once(ck, function(){
    return tmdb("/" + type + "/" + id + "/recommendations").then(function(j){
      var list = (j.results || []);
      if(list.length) return list;
      return tmdb("/" + type + "/" + id + "/similar").then(function(j2){ return j2.results || []; });
    }).then(function(list){
      var v = list.slice(0, 18).map(function(o){ return norm(o, o.media_type || type); })
        .filter(function(m){ return m && m.poster; });
      cset(ck, v); return v;
    }).catch(function(e){ console.warn("[meta] recs", e.message); return []; });
  });
};

/* =====================================================================
 * title(type, imdbId) → ficha localizada con forma Cinemeta
 *   {id, type, name, description, poster, background, releaseInfo, imdbRating, genres, tmdbId,
 *    videos:[{id, season, episode, name, overview, thumbnail, released}]}
 * Fuentes (lo localizado gana campo a campo; Cinemeta rellena huecos):
 *   1) TMDB con la clave del usuario (find por imdb → detalles + temporadas)
 *   2) Sin clave: add-on público TMDB para Stremio (tmdb.elfhosted.com) con {"language":"es-ES"}
 *   3) Cinemeta (solo inglés) como base
 * ===================================================================== */
var CINEMETA = "https://v3-cinemeta.strem.io";
var TMDB_ADDON = "https://tmdb.elfhosted.com";
var TITLE_TTL = 7 * 864e5;

function getJson(url, ms){
  return new Promise(function(resolve, reject){
    var done = false;
    var t = setTimeout(function(){ if(!done){ done = true; reject(new Error("timeout")); } }, ms || 15000);
    App.net.fetch(url).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(j){ if(!done){ done = true; clearTimeout(t); resolve(j); } },
            function(e){ if(!done){ done = true; clearTimeout(t); reject(e); } });
  });
}

function stype(type){ return (type === "tv" || type === "series") ? "series" : "movie"; }
function yearOf(s){ var m = String(s || "").match(/(19|20)\d{2}/); return m ? m[0] : ""; }

function normVideo(v, imdbId){
  var se = Number(v.season), ep = Number(v.episode !== undefined ? v.episode : v.number);
  return {
    id: imdbId + ":" + se + ":" + ep,
    season: se, episode: ep,
    name: v.name || v.title || "",
    overview: v.overview || v.description || "",
    thumbnail: v.thumbnail || "",
    released: v.released || v.firstAired || ""
  };
}
function normStremio(m, imdbId){
  if(!m) return null;
  return {
    id: imdbId, type: stype(m.type),
    name: m.name || "", description: m.description || "",
    poster: m.poster || "", background: m.background || "",
    releaseInfo: m.releaseInfo || (m.year ? String(m.year) : ""),
    imdbRating: m.imdbRating || "",
    genres: (m.genres || m.genre || []).slice(0, 6),
    tmdbId: m.moviedb_id || (/^tmdb:/.test(m.id || "") ? Number(String(m.id).slice(5)) : null),
    videos: (m.videos || []).filter(function(v){ return v.season !== undefined; })
      .map(function(v){ return normVideo(v, imdbId); })
  };
}

/* TMDB con clave del usuario */
function titleFromTmdb(type, imdbId){
  return tmdb("/find/" + imdbId, { external_source: "imdb_id" }).then(function(j){
    var isTv = stype(type) === "series";
    var r = isTv ? (j.tv_results || [])[0] : (j.movie_results || [])[0];
    if(!r) return null;
    var t = isTv ? "tv" : "movie";
    return tmdb("/" + t + "/" + r.id).then(function(d){
      var base = {
        id: imdbId, type: stype(type), tmdbId: d.id,
        name: d.name || d.title || "", description: d.overview || "",
        poster: M.img(d.poster_path, "w500"), background: M.img(d.backdrop_path, "w1280"),
        releaseInfo: yearOf(d.first_air_date || d.release_date),
        imdbRating: d.vote_average ? (Math.round(d.vote_average * 10) / 10).toString() : "",
        genres: (d.genres || []).map(function(g){ return g.name; }),
        videos: []
      };
      if(!isTv) return base;
      var seasons = (d.seasons || []).map(function(x){ return x.season_number; }).slice(0, 40);
      return Promise.all(seasons.map(function(n){ return M.season(d.id, n); })).then(function(list){
        list.forEach(function(sv){
          if(!sv) return;
          sv.episodes.forEach(function(e){
            base.videos.push({ id: imdbId + ":" + sv.season + ":" + e.episode, season: sv.season, episode: e.episode,
              name: e.name, overview: e.overview, thumbnail: e.still, released: e.airDate });
          });
        });
        return base;
      });
    });
  });
}

/* Add-on público de TMDB (sin clave de usuario) */
function titleFromAddon(type, imdbId){
  var cfg = encodeURIComponent(JSON.stringify({ language: lang() }));
  return getJson(TMDB_ADDON + "/" + cfg + "/meta/" + stype(type) + "/" + imdbId + ".json", 20000)
    .then(function(j){ return normStremio(j && j.meta, imdbId); });
}
function titleFromCinemeta(type, imdbId){
  return getJson(CINEMETA + "/meta/" + stype(type) + "/" + imdbId + ".json", 15000)
    .then(function(j){ return normStremio(j && j.meta, imdbId); });
}

/* Fusiona: loc (localizado) gana campo a campo; base rellena huecos */
function merge(loc, base){
  if(!loc) return base;
  if(!base) return loc;
  var out = {};
  ["id", "type", "name", "description", "poster", "background", "releaseInfo", "imdbRating", "tmdbId"].forEach(function(k){
    out[k] = loc[k] || base[k] || (k === "tmdbId" ? null : "");
  });
  out.genres = (loc.genres && loc.genres.length) ? loc.genres : (base.genres || []);
  var map = {}, order = [];
  function put(v, prefer){
    var k = v.season + ":" + v.episode;
    if(!map[k]){ map[k] = {}; order.push(k); }
    var cur = map[k];
    ["id", "season", "episode", "name", "overview", "thumbnail", "released"].forEach(function(f){
      var val = v[f];
      if(val === undefined || val === null || val === "") return;
      if(prefer || cur[f] === undefined || cur[f] === "") cur[f] = val;
    });
  }
  (base.videos || []).forEach(function(v){ put(v, false); });
  (loc.videos || []).forEach(function(v){ put(v, true); });
  out.videos = order.map(function(k){ return map[k]; }).sort(function(a, b){
    return (a.season - b.season) || (a.episode - b.episode);
  });
  return out;
}
M._merge = merge;

M.title = function(type, imdbId){
  if(!imdbId) return Promise.resolve(null);
  var t = stype(type);
  var ck = "t:" + lang() + ":" + t + ":" + imdbId;
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit);
  return once(ck, function(){
    var locP = (M.hasKey() ? titleFromTmdb(t, imdbId) : Promise.reject(new Error("no key")))
      .then(function(r){ if(!r) throw new Error("tmdb sin resultado"); return r; })
      .catch(function(){ return titleFromAddon(t, imdbId); })
      .catch(function(e){ console.warn("[meta] localizado", imdbId, e.message); return null; });
    var baseP = titleFromCinemeta(t, imdbId)
      .catch(function(e){ console.warn("[meta] cinemeta", imdbId, e.message); return null; });
    return Promise.all([locP, baseP]).then(function(r){
      var m = merge(r[0], r[1]);
      if(m) cset(ck, m, TITLE_TTL);
      return m;
    });
  });
};

})();
