/* subs.js — subtítulos en internet con el add-on OpenSubtitles v3 de Stremio.
 * App.subs.fetch({type:'movie'|'series', imdbId, season, episode, filename})
 *   → Promise<[{label, lang, url}]>  (máx. 6; nunca rechaza: [] si falla)
 * Respuesta real: {subtitles:[{id, url, lang:"spa"|"eng"|"pob"…, SubEncoding, subtitleFileName,
 *                  movieReleaseName, releaseGroup, season, episode}]}. Las URLs
 * "subencoding-stremio-utf8" ya vienen convertidas a UTF-8.
 */
(function(){
"use strict";

var App = window.App;
var BASE = "https://opensubtitles-v3.strem.io";
var MAX = 6;
var TIMEOUT = 8000;
var cache = {};

/* Códigos que usa OpenSubtitles → código ISO 639-2 del reproductor */
var ALIAS = { spn: "spa", esp: "spa", es: "spa", en: "eng", pt: "por", fr: "fre", fra: "fre",
              de: "ger", deu: "ger", it: "ita", nld: "dut", zho: "chi" };
function norm(l){
  l = String(l || "").toLowerCase();
  return ALIAS[l] || l;
}
/* ui "es"/"en" o ajuste "spa"/"eng" → ISO 639-2 */
function want3(l){
  l = String(l || "").toLowerCase();
  if(l === "es") return "spa";
  if(l === "en") return "eng";
  return norm(l);
}
function langLabel(l){
  var k = "player.lang." + l, t = App.t(k);
  return t === k ? l.toUpperCase() : t;
}

/* Parecido entre nombres de release para ordenar (mismo grupo/calidad primero) */
function tokens(s){
  return String(s || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").split(/[^a-z0-9]+/).filter(function(t){ return t.length > 1; });
}
function similarity(a, b){
  var ta = tokens(a), tb = tokens(b);
  if(!ta.length || !tb.length) return 0;
  var set = {}, hit = 0;
  tb.forEach(function(t){ set[t] = true; });
  ta.forEach(function(t){ if(set[t]) hit++; });
  return hit / Math.max(ta.length, tb.length);
}

function withTimeout(p, ms){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error("timeout")); }, ms);
    p.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
  });
}

function fetchSubs(q){
  q = q || {};
  if(!q.imdbId || !/^tt\d+$/.test(String(q.imdbId))) return Promise.resolve([]);
  var isSeries = q.type === "series" || (q.season !== undefined && q.season !== null && q.episode !== undefined && q.episode !== null);
  var id = q.imdbId + (isSeries ? ":" + q.season + ":" + q.episode : "");
  var type = isSeries ? "series" : "movie";
  var ck = type + "/" + id;

  var raw = cache[ck] ? Promise.resolve(cache[ck]) :
    withTimeout(App.net.fetch(BASE + "/subtitles/" + type + "/" + encodeURIComponent(id) + ".json"), TIMEOUT)
      .then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(j){ var l = (j && j.subtitles) || []; cache[ck] = l; return l; });

  return raw.then(function(list){
    var prefs = [];
    [App.settings.get("subLang"), App.i18n.contentLang(), "eng"].forEach(function(l){
      var c = want3(l);
      if(c && prefs.indexOf(c) < 0) prefs.push(c);
    });
    var picked = list.filter(function(s){ return s && s.url && prefs.indexOf(norm(s.lang)) >= 0; });
    picked.sort(function(a, b){
      var pa = prefs.indexOf(norm(a.lang)), pb = prefs.indexOf(norm(b.lang));
      if(pa !== pb) return pa - pb;
      var sa = similarity(a.subtitleFileName || a.movieReleaseName, q.filename);
      var sb = similarity(b.subtitleFileName || b.movieReleaseName, q.filename);
      if(sa !== sb) return sb - sa;
      // los de "hearing impaired" (-HI / SDH) después
      var ha = /\b(hi|sdh)\b/i.test(a.subtitleFileName || "") ? 1 : 0;
      var hb = /\b(hi|sdh)\b/i.test(b.subtitleFileName || "") ? 1 : 0;
      return ha - hb;
    });
    var counts = {};
    return picked.slice(0, MAX).map(function(s){
      var l = norm(s.lang);
      counts[l] = (counts[l] || 0) + 1;
      return { label: langLabel(l) + " · OpenSubtitles " + counts[l], lang: l, url: s.url, source: "opensubtitles" };
    });
  }).catch(function(e){
    console.warn("[subs] OpenSubtitles: " + (e && e.message ? e.message : e));
    return [];
  });
}

App.subs = { fetch: fetchSubs };

})();
