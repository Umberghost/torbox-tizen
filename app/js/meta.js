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
  if(age > (e.miss ? MISS_TTL : TTL)){ delete cache[k]; return undefined; }
  e.a = Date.now();
  return e.miss ? null : e.v;
}
function cset(k, v){
  cache[k] = v === null ? { t: Date.now(), a: Date.now(), miss: true } : { t: Date.now(), a: Date.now(), v: v };
  saveSoon();
}
M.clearCache = function(){ cache = {}; App.store.set("metacache", cache); };

/* Si cambia la clave o el idioma, la caché de "no encontrado" deja de valer */
App.bus.on("settings:change", function(d){
  if(d && (d.key === "tmdbKey" || d.key === "uiLang")){
    Object.keys(cache).forEach(function(k){ if(cache[k].miss || d.key === "uiLang") delete cache[k]; });
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
  if(!key) return Promise.reject(new Error("Sin clave TMDB"));
  var bearer = /^eyJ/.test(key) || key.length > 40;
  var q = [];
  params = params || {};
  params.language = params.language || App.settings.get("uiLang") || "es-ES";
  if(!bearer) params.api_key = key;
  Object.keys(params).forEach(function(k){
    if(params[k] !== undefined && params[k] !== null && params[k] !== "")
      q.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
  });
  var headers = { "Accept": "application/json" };
  if(bearer) headers["Authorization"] = "Bearer " + key;
  return enqueue(function(){
    return fetch(BASE + path + (q.length ? "?" + q.join("&") : ""), { headers: headers })
      .then(function(r){
        if(r.status === 401) throw new Error("Clave TMDB no válida");
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
  var ck = "l:" + type + ":" + (App.parse ? App.parse.norm(q.title) : q.title) + ":" + (q.year || "");
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
  var ck = "d:" + type + ":" + id;
  var hit = cget(ck);
  if(hit !== undefined) return Promise.resolve(hit);
  return once(ck, function(){
    return tmdb("/" + type + "/" + id).then(function(j){
      var n = norm(j, type); cset(ck, n); return n;
    }).catch(function(e){ console.warn("[meta] details", e.message); return null; });
  });
};

/* season(tvId, n) → {season, name, overview, episodes:[{episode, name, overview, still, runtime, rating, airDate}]} */
M.season = function(tvId, n){
  if(!tvId || !M.hasKey()) return Promise.resolve(null);
  var ck = "s:" + tvId + ":" + n;
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
  var ck = "r:" + type + ":" + id;
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

})();
