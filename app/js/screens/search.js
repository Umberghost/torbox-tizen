/* screens/search.js — buscar como Stremio: catálogo Cinemeta + add-on de Stremio del usuario.
 * TorBox cerró su Search API; ahora:
 *   1) Cinemeta (sin clave) da títulos con su id de IMDb.
 *   2) Fichas/episodios localizados con App.meta.title (cae a Cinemeta /meta).
 *   3) El add-on configurado (Torrentio, Comet, AIOStreams…) devuelve las fuentes.
 *   4) Mejor fuente en un clic (App.search.bestStream / playTitle) y siguiente episodio.
 * Expone App.search = { bestStream, playTitle, fetchStreams }.
 */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var t = function(k, v){ return App.t(k, v); };
var CINEMETA = "https://v3-cinemeta.strem.io";
var RECENT_KEY = "recentSearches";
var ADDON_TIMEOUT = 20000;
if(App.settings.define) App.settings.define("stremioAddons", []);

/* ======================= Utilidades ======================= */

function normAddon(u){
  u = String(u || "").trim();
  if(!u) return "";
  u = u.replace(/^stremio:\/\//i, "https://");
  u = u.replace(/\/manifest\.json(\?.*)?$/i, "");
  return u.replace(/\/+$/, "");
}

/* Todos los add-ons configurados: `stremioAddon` (primero) + `stremioAddons` (array), sin duplicados */
function addonBases(){
  var raw = [App.settings.get("stremioAddon")];
  var arr = App.settings.get("stremioAddons");
  if(Array.isArray(arr)) raw = raw.concat(arr);
  var out = [];
  raw.forEach(function(u){
    var b = normAddon(u);
    if(b && out.indexOf(b) < 0) out.push(b);
  });
  return out;
}
function addonBase(){ var l = addonBases(); return l.length ? l[0] : ""; }

var ADDON_NAMES = [[/torrentio/i, "Torrentio"], [/comet/i, "Comet"], [/mediafusion/i, "MediaFusion"], [/torbox/i, "TorBox"],
                   [/aiostreams/i, "AIOStreams"], [/jackettio/i, "Jackettio"], [/knightcrawler/i, "KnightCrawler"]];
function addonHost(base){
  var m = String(base || "").match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1].replace(/^www\./, "") : String(base || "").slice(0, 24);
}
function addonName(base){
  var h = addonHost(base);
  for(var i = 0; i < ADDON_NAMES.length; i++) if(ADDON_NAMES[i][0].test(h)) return ADDON_NAMES[i][1];
  return h.length > 18 ? h.slice(0, 18) + "…" : h;
}

function withTimeout(p, ms, msg){
  return new Promise(function(resolve, reject){
    var tm = setTimeout(function(){ reject(new Error(msg || t("search.err.timeout"))); }, ms);
    p.then(function(v){ clearTimeout(tm); resolve(v); }, function(e){ clearTimeout(tm); reject(e); });
  });
}

function getJson(url, ms, label){
  var p = App.net.fetch(url).then(function(r){
    if(r.status === 404) { var e = new Error("404"); e.status = 404; throw e; }
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
  return ms ? withTimeout(p, ms, label) : p;
}

function recent(){ return App.store.get(RECENT_KEY, []); }
function pushRecent(q){
  var l = recent().filter(function(x){ return x.toLowerCase() !== q.toLowerCase(); });
  l.unshift(q); App.store.set(RECENT_KEY, l.slice(0, 10));
}

function pad2(n){ n = String(n); return n.length < 2 ? "0" + n : n; }
function epLabel(season, episode){ return t("search.epLabel", { s: season, e: pad2(episode) }); }

/* ======================= Fichas (localizadas) ======================= */

var metaCache = {};   // type:id → Promise<meta normalizada>

function normVideos(list){
  return (list || []).map(function(v){
    return { season: Number(v.season), episode: Number(v.episode !== undefined && v.episode !== null && v.episode !== "" ? v.episode : v.number),
             runtime: Number(v.runtime) || 0, name: v.name || v.title || "", released: v.released || v.firstAired || "",
             thumbnail: v.thumbnail || "", overview: v.overview || v.description || "" };
  }).filter(function(v){ return !isNaN(v.season) && !isNaN(v.episode); });
}

function normMeta(m, fallback){
  m = m || {}; fallback = fallback || {};
  var genres = m.genres || m.genre || [];
  if(!Array.isArray(genres)) genres = [genres];
  return {
    name: m.name || fallback.name || "", year: m.releaseInfo || m.year || fallback.year || "",
    rating: m.imdbRating || fallback.imdbRating || "", description: m.description || fallback.description || "",
    poster: m.poster || fallback.poster || "", background: m.background || fallback.background || "",
    genres: genres.slice(0, 4), videos: normVideos(m.videos)
  };
}

function cinemetaMeta(type, id){
  return getJson(CINEMETA + "/meta/" + type + "/" + encodeURIComponent(id) + ".json", 15000, t("search.err.cinemeta"))
    .then(function(j){ return j.meta || {}; });
}

/* getMeta(type, id, fallback) → Promise<{name, year, rating, description, poster, background, genres, videos}> */
function getMeta(type, id, fallback){
  var ck = type + ":" + id;
  if(metaCache[ck]) return metaCache[ck];
  var p;
  if(App.meta && typeof App.meta.title === "function"){
    p = Promise.resolve().then(function(){ return App.meta.title(type, id); }).then(function(m){
      if(!m) throw new Error("sin ficha");
      // Serie sin episodios en la ficha localizada → episodios de Cinemeta
      if(type === "series" && !(m.videos && m.videos.length)){
        return cinemetaMeta(type, id).then(function(c){ m.videos = c.videos; return m; }, function(){ return m; });
      }
      return m;
    }).catch(function(e){
      console.warn("[buscar] App.meta.title falló, uso Cinemeta:", e && e.message);
      return cinemetaMeta(type, id);
    });
  } else {
    p = cinemetaMeta(type, id);
  }
  p = p.then(function(m){ return normMeta(m, fallback); });
  p.catch(function(){ delete metaCache[ck]; });
  metaCache[ck] = p;
  return p;
}

function seasonsOf(videos){
  var seasons = [];
  videos.forEach(function(v){ if(seasons.indexOf(v.season) < 0) seasons.push(v.season); });
  seasons.sort(function(a, b){ return (a === 0 ? 1e6 : a) - (b === 0 ? 1e6 : b); }); // especiales al final
  return seasons;
}

/* ======================= Normalización de fuentes ======================= */

var Q_RANK = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1 };
var PREF_Q = { "2160p": 4, "4k": 4, "1080p": 3, "720p": 2, "480p": 1 };

function parseSize(txt){
  var m = String(txt || "").match(/(?:💾\s*)?(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if(!m) return 0;
  var n = parseFloat(m[1].replace(",", "."));
  var mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[2].toUpperCase()];
  return Math.round(n * mult);
}
function parseQuality(txt){
  var tx = String(txt || "");
  var res = "";
  if(/\b(2160p|4k|uhd)\b/i.test(tx)) res = "4K";
  else if(/\b1080p\b/i.test(tx)) res = "1080p";
  else if(/\b720p\b/i.test(tx)) res = "720p";
  else if(/\b(480p|576p|sd)\b/i.test(tx)) res = "480p";
  var tags = [];
  if(/\b(dolby.?vision|dovi|\bdv\b)/i.test(tx)) tags.push("DV");
  else if(/\bhdr(10\+?)?\b/i.test(tx)) tags.push("HDR");
  if(/\b(hevc|x\.?265|h\.?265)\b/i.test(tx)) tags.push("HEVC");
  return { res: res, tags: tags };
}
function isCachedMark(name, title){
  var str = String(name || "") + " " + String(title || "");
  // Torrentio: "[TB+]" (el + indica caché), "[TB download]" no. Comet/AIOStreams: ⚡, "cached", "Instant".
  if(/\[[A-Z]{2,4}\+\]/.test(str)) return true;
  if(/⚡/.test(str)) return true;
  if(/\b(cached|instant)\b/i.test(str) && !/\buncached\b/i.test(str)) return true;
  return false;
}

/* Idiomas del release: es (castellano) · lat · en · vose · multi */
function parseLangs(txt){
  var tx = String(txt || "");
  var out = [];
  var lat = /🇲🇽|\blatino\b|\blatam\b|\blat\b|\bspanish\s*latin/i.test(tx);
  var es = /🇪🇸|\bcastellano\b|\bespañol\b|\bespanol\b|\bspa\b|\besp\b/i.test(tx) ||
           (/\bspanish\b/i.test(tx) && !/\bspanish\s*latin/i.test(tx));
  if(es) out.push("es");
  if(lat) out.push("lat");
  if(/🇬🇧|🇺🇸|\benglish\b|\beng\b/i.test(tx)) out.push("en");
  if(/\bvose\b|\bvos\b|\bsubtitulad[oa]s?\b|\bsubs?\b/i.test(tx)) out.push("vose");
  if(/\bmulti\b|\bdual\b|\bmulti-?audio\b|\bdual-?audio\b/i.test(tx)) out.push("multi");
  return out;
}

/* Pack de temporada/serie: Torrentio pone en la 1ª línea el nombre del torrent y en la 2ª el archivo.
 * TorBox descarga SIEMPRE el torrent entero, así que un pack sin caché pesa mucho más que el episodio. */
var EP_RE = /\bS\d{1,2}[\s._-]*E\d{1,3}\b|\b\d{1,2}x\d{2,3}\b|\bcap[ií]tulo\b|\bcap\.?\s*\d{3,4}\b|\bepisod(e|io)\s*\d+/i;
function range(a, b){ var o = []; for(var i = Math.min(a, b); i <= Math.max(a, b) && o.length < 60; i++) o.push(i); return o; }

/* Temporadas que cubre un pack (null = desconocido/todas) */
function packSeasons(n, fileName){
  var m = n.match(/\bS(\d{1,2})[\s._]*-[\s._]*S?(\d{1,2})\b/i) ||
          n.match(/\btemporadas?[\s._-]*(\d{1,2})[\s._-]*(?:a|al|-|y)[\s._-]*(\d{1,2})\b/i) ||
          n.match(/\bseasons?[\s._-]*(\d{1,2})[\s._-]*(?:-|to|&)[\s._-]*(\d{1,2})\b/i);
  if(m) return range(Number(m[1]), Number(m[2]));
  m = n.match(/\bS(\d{1,2})\b/i) || n.match(/\bseason[\s._-]*(\d{1,2})\b/i) || n.match(/\btemporada[\s._-]*(\d{1,2})\b/i);
  if(m) return [Number(m[1])];
  m = String(fileName || "").match(/\bS(\d{1,2})[\s._-]*E\d{1,3}\b/i) || String(fileName || "").match(/\b(\d{1,2})x\d{2,3}\b/);
  if(m) return [Number(m[1])];
  return null;
}

function parsePack(torrentName, fileName){
  var n = String(torrentName || "");
  if(!n) return null;
  if(/\bS\d{1,2}\s*-\s*S?\d{1,2}\b/i.test(n) ||
     /\b(complete|full)[\s._-]*series\b|\bseries[\s._-]*complete\b|\bserie[\s._-]*completa\b|\ball[\s._-]*seasons\b|\btodas[\s._-]*las[\s._-]*temporadas\b|\btemporadas?[\s._-]*\d+[\s._-]*(a|al|-)[\s._-]*\d+\b|\bseasons?[\s._-]*\d+[\s._-]*-[\s._-]*\d+\b/i.test(n)){
    var rs = packSeasons(n, fileName);
    return { kind: "series", seasons: rs && rs.length > 1 ? rs : null };
  }
  if(/\bE\d{1,3}[\s._]*-[\s._]*E?\d{1,3}\b/i.test(n)) return { kind: "season", seasons: packSeasons(n, fileName) };   // rango E01-E10
  if(EP_RE.test(n)) return null;                                               // episodio suelto
  if(/\bS\d{1,2}\b/i.test(n) || /\bseason[\s._-]*\d+\b/i.test(n) || /\btemporada[\s._-]*\d+\b/i.test(n) ||
     /\b(complete|completa|pack)\b/i.test(n)) return { kind: "season", seasons: packSeasons(n, fileName) };
  // El torrent no menciona episodio pero el archivo sí → pack
  if(fileName && fileName !== n && EP_RE.test(fileName)) return { kind: "season", seasons: packSeasons(n, fileName) };
  return null;
}

function packCovers(x, season){
  if(!x.pack) return false;
  if(!x.pack.seasons) return true;
  return x.pack.seasons.indexOf(Number(season)) >= 0;
}

/* Hash del torrent: infoHash o, en add-ons con debrid (Torrentio), el de la URL de resolución */
/* Servicio debrid que indica el add-on en el nombre: "[TB+]", "[RD download]", "[RD⬇️] Comet"… → "TB", "RD" */
function debridTag(name){
  var m = String(name || "").match(/\[(TB|RD|AD|PM|DL|ED|OC|PO|PKP|EN)(?![A-Za-z])/i);
  return m ? m[1].toUpperCase() : "";
}
function hashFromUrl(url){
  var m = String(url || "").match(/\/([a-f0-9]{40})(?=[\/?#]|$)/i);
  return m ? m[1].toLowerCase() : "";
}

function capsCheck(x, all){
  if(!App.caps) return { ok: true, reasons: [] };
  var r1 = App.caps.check(x.filename || x.release);
  var r2 = App.caps.check(all.replace(/\n/g, " "));
  var reasons = r1.reasons.slice();
  r2.reasons.forEach(function(r){
    if((r === "caps.dts" || r === "caps.truehd" || r === "caps.dv" || r === "caps.disc") && reasons.indexOf(r) < 0) reasons.push(r);
  });
  return { ok: !reasons.length, reasons: reasons };
}

function normStream(st, idx){
  var name = String(st.name || "");
  var title = String(st.title || st.description || "");
  var bh = st.behaviorHints || {};
  var lines = title.split("\n").map(function(l){ return l.trim(); }).filter(Boolean);
  var filename = bh.filename || "";
  var release = filename || lines[0] || name.replace(/\n/g, " ") || t("search.noName");
  var all = name + "\n" + title + "\n" + filename;
  var q = parseQuality(all);
  var seedM = title.match(/👤\s*(\d+)/);
  var provM = title.match(/⚙️\s*([^\n]+)/);
  var size = Number(bh.videoSize) || parseSize(title);
  var hash = st.infoHash ? String(st.infoHash).toLowerCase() : hashFromUrl(st.url);
  var cached = isCachedMark(name, title);
  var torrentName = lines[0] && !/^👤|💾/.test(lines[0]) ? lines[0] : "";
  var fileLine = lines[1] && !/^👤|💾|⚙️/.test(lines[1]) ? lines[1] : "";
  var x = {
    i: idx,
    name: name.replace(/\n/g, " · "),
    release: release,
    url: st.url && /^https?:/i.test(st.url) ? st.url : "",
    hash: hash,
    svc: debridTag(name),
    fileIdx: st.fileIdx,
    quality: q.res, tags: q.tags,
    size: size,
    seeders: seedM ? Number(seedM[1]) : null,
    provider: provM ? provM[1].trim() : "",
    cached: cached,
    // Torrentio/Comet con debrid y SIN caché: "[TB download]", "[TB⏳]", "[RD⬇️]"… → el enlace solo
    // manda a descargar y sirve un vídeo de aviso ("Torrent is being downloaded to debrid…")
    uncachedDebrid: !cached && /\[[A-Z]{2,4}\s*(download|⏳|⬇️?)?\s*\]/i.test(name) && !!st.url,
    filename: filename,
    torrentName: torrentName,
    pack: parsePack(torrentName, filename || fileLine),
    langs: parseLangs(all)
  };
  var c = capsCheck(x, all);
  x.compatible = c.ok; x.capsReasons = c.reasons;
  return x;
}

/* Reproducible al instante: enlace ya resuelto por el add-on (y no es el aviso de "descargando") */
function isPlayableNow(x){ return !!(x.url && !x.uncachedDebrid); }
function isInstant(x){ return x.cached || isPlayableNow(x); }

function langScore(x){
  var pref = App.settings.get("prefAudio") || "es";
  if(pref === "any") return 1;
  var L = x.langs;
  if(pref === "es") return L.indexOf("es") >= 0 ? 2 : (L.indexOf("multi") >= 0 ? 1 : 0);
  if(pref === "lat") return L.indexOf("lat") >= 0 ? 2 : (L.indexOf("multi") >= 0 ? 1 : 0);
  if(pref === "en"){
    if(L.indexOf("en") >= 0) return 2;
    // Sin etiquetas de idioma extranjero → casi siempre audio original en inglés
    var foreign = L.filter(function(l){ return l === "es" || l === "lat"; }).length;
    return !foreign ? 2 : (L.indexOf("multi") >= 0 ? 1 : 0);
  }
  return 1;
}

function qualityScore(x){
  var P = PREF_Q[String(App.settings.get("prefQuality") || "1080p").toLowerCase()] || 3;
  var r = Q_RANK[x.quality] || 0;
  if(!r) return 0;
  if(r === P) return 100;
  if(r < P) return 50 + r;   // la inmediatamente inferior primero
  return 20 - r;             // luego la superior más cercana
}

function withinSize(x){
  var max = Number(App.settings.get("maxSizeGB")) || 0;
  if(!max || !x.size) return true;
  return x.size <= max * 1073741824;
}

/* bestStream(streams) → mejor fuente reproducible al instante y compatible, o null */
function bestStream(streams){
  var cands = (streams || []).filter(function(x){ return isPlayableNow(x) && x.compatible !== false && withinSize(x); });
  if(!cands.length) return null;
  cands.sort(function(a, b){
    var la = langScore(a), lb = langScore(b);
    if(la !== lb) return lb - la;
    var qa = qualityScore(a), qb = qualityScore(b);
    if(qa !== qb) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  });
  return cands[0];
}

function sortStreams(list){
  return list.sort(function(a, b){
    var pa = a.cached ? 2 : (isPlayableNow(a) ? 1 : 0);
    var pb = b.cached ? 2 : (isPlayableNow(b) ? 1 : 0);
    if(pa !== pb) return pb - pa;
    var la = langScore(a), lb = langScore(b);
    if(la !== lb) return lb - la;
    if(pa === 0){
      var ka = a.pack ? 1 : 0, kb = b.pack ? 1 : 0;
      if(ka !== kb) return ka - kb;
    }
    var qa = Q_RANK[a.quality] || 0, qb = Q_RANK[b.quality] || 0;
    if(qa !== qb) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  });
}

/* fetchStreams(type, id, force) → Promise<{visible:[], hidden:[]}>  (id = tt… o tt…:S:E)
 * Caché en memoria de 5 min por id (la comparten la vista previa, la lista y el siguiente episodio). */
var streamCache = {};
var STREAM_TTL = 5 * 60000;
function fetchStreams(type, id, force){
  var bases = addonBases();
  if(!bases.length) return Promise.reject(new Error(t("search.noAddon.title")));
  var ck = bases.join(",") + "|" + type + "|" + id;
  var c = streamCache[ck];
  if(c && !force && Date.now() - c.t < STREAM_TTL) return c.p;
  var p = fetchStreamsRaw(bases, type, id);
  streamCache[ck] = { t: Date.now(), p: p };
  p.catch(function(){ if(streamCache[ck] && streamCache[ck].p === p) delete streamCache[ck]; });
  return p;
}
/* Fusiona listas de varios add-ons; deduplica por infoHash (o url si no hay hash) entre add-ons distintos,
 * pero solo dentro del MISMO servicio debrid: la versión RD y la TB de un torrent son filas distintas
 * (cada una con su enlace y su estado de caché). Las fuentes sin servicio se unen a cualquiera. */
function mergeStreams(lists){
  var out = [], seen = {}, byHash = {};
  lists.forEach(function(L){
    var mine = {};
    L.list.forEach(function(x){
      x.addon = L.name; x.addons = [L.name];
      var k = x.hash ? "h:" + x.hash + "|" + (x.svc || "") : (x.url ? "u:" + x.url : "");
      var e = k ? seen[k] : null;
      if(!e && x.hash && !x.svc) e = byHash[x.hash] || null;
      if(!e){
        out.push(x);
        if(k) mine[k] = x;
        return;
      }
      if(e.addons.indexOf(L.name) < 0) e.addons.push(L.name);
      if(x.cached && !e.cached) e.cached = true;
      if(x.url && (!e.url || (e.uncachedDebrid && !x.uncachedDebrid))){ e.url = x.url; e.uncachedDebrid = x.uncachedDebrid; }
      if(e.cached) e.uncachedDebrid = false;
      if(!e.size && x.size) e.size = x.size;
      if(e.seeders === null && x.seeders !== null) e.seeders = x.seeders;
      if(!e.filename && x.filename) e.filename = x.filename;
      if(!e.provider && x.provider) e.provider = x.provider;
      if(e.fileIdx === undefined && x.fileIdx !== undefined) e.fileIdx = x.fileIdx;
    });
    for(var k2 in mine){ seen[k2] = mine[k2]; if(mine[k2].hash && !byHash[mine[k2].hash]) byHash[mine[k2].hash] = mine[k2]; }
  });
  return out;
}

/* Algunos add-ons (Comet, MediaFusion…) devuelven el error como un "stream" falso:
 * "[❌] realdebrid DIRECT / realdebrid: Invalid API key." → no es una fuente, es un aviso. */
var ERR_RE = /\[?❌\]?|invalid api ?key|api ?key (is )?invalid|unauthori[sz]ed|token (is )?(invalid|expired)|configuration error|not configured/i;
function addonError(st){
  if(st.infoHash) return "";
  var NL = String.fromCharCode(10);
  var txt = String(st.name || "") + NL + String(st.title || st.description || "");
  if(!ERR_RE.test(txt)) return "";
  var lines = txt.split(NL).map(function(l){ return l.replace(/\[?❌\]?/g, "").trim(); }).filter(Boolean);
  var best = lines.filter(function(l){ return /invalid|error|unauthori|expired|config/i.test(l); })[0] || lines[0] || "";
  return best.slice(0, 120);
}
var warnedAddons = {};
function warnAddonErrors(warnings){
  var fresh = (warnings || []).filter(function(w){ var k = w.addon + "|" + w.msg; if(warnedAddons[k]) return false; warnedAddons[k] = true; return true; });
  if(!fresh.length) return;
  var msg = fresh.map(function(w){ return w.addon + ": " + w.msg; }).join(" · ");
  App.ui.toast(t("search.addonErr", { msg: msg }), 10000);
  console.warn("[buscar] errores de add-on:", msg);
}

function fetchStreamsRaw(bases, type, id){
  var path = "/stream/" + type + "/" + encodeURIComponent(id).replace(/%3A/g, ":") + ".json";
  var counter = 0;
  return Promise.all(bases.map(function(base){
    return getJson(base + path, ADDON_TIMEOUT, t("search.err.addonTimeout"))
      .then(function(j){
        var name = addonName(base), errs = [];
        var list = (j.streams || []).filter(function(st){
          var e = addonError(st || {});
          if(e){ if(errs.indexOf(e) < 0) errs.push(e); return false; }
          return true;
        }).map(function(st){ return normStream(st, counter++); }).filter(function(x){ return x.url || x.hash; });
        return { name: name, list: list, warnings: errs.map(function(e){ return { addon: name, msg: e }; }) };
      })
      .catch(function(e){ console.warn("[buscar] add-on " + addonHost(base) + ":", e && e.message); return { err: e }; });
  })).then(function(res){
    var ok = res.filter(function(r){ return !r.err; });
    if(!ok.length){
      // Si alguno falló por otra causa que 404, ese error es el relevante
      var real = res.filter(function(r){ return r.err.status !== 404; })[0];
      throw (real || res[0]).err;
    }
    var warnings = [];
    ok.forEach(function(r){ warnings = warnings.concat(r.warnings || []); });
    var list = mergeStreams(ok);
    // Marcar caché con TorBox para los que solo traen infoHash
    // (solo las que el add-on no ha atribuido a un servicio: la caché de TorBox no dice nada de RD)
    var hashes = list.filter(function(x){ return x.hash && !x.cached && !x.svc; }).map(function(x){ return x.hash; });
    var chk = hashes.length && App.torbox.checkCached ? App.torbox.checkCached(hashes).catch(function(){ return {}; }) : Promise.resolve({});
    return chk.then(function(set){
      list.forEach(function(x){ if(x.hash && !x.svc && set[x.hash]){ x.cached = true; x.uncachedDebrid = false; } });
      var hide = App.caps && App.caps.hideUnsupported ? App.caps.hideUnsupported() : false;
      var visible = [], hidden = [];
      list.forEach(function(x){ (hide && x.compatible === false ? hidden : visible).push(x); });
      return { visible: sortStreams(visible), hidden: sortStreams(hidden), warnings: warnings };
    });
  });
}

/* bestDownload(streams) → mejor fuente NO instantánea con hash (episodio suelto), para descarga automática */
function bestDownload(streams){
  var cands = (streams || []).filter(function(x){ return x.hash && !x.pack && x.compatible !== false && withinSize(x); });
  if(!cands.length) return null;
  cands.sort(function(a, b){
    var la = langScore(a), lb = langScore(b);
    if(la !== lb) return lb - la;
    var qa = qualityScore(a), qb = qualityScore(b);
    if(qa !== qb) return qb - qa;
    return (b.seeders || 0) - (a.seeders || 0);
  });
  return cands[0];
}

function langLabels(x){ return x.langs.map(function(l){ return t("search.lang." + l); }); }

function describe(x){
  var parts = [];
  if(x.quality) parts.push(x.quality);
  var L = langLabels(x);
  if(L.length) parts.push(L.join("/"));
  if(x.size) parts.push(App.fmtSize(x.size));
  return parts.join(" · ");
}

/* ======================= Construir opts del reproductor ======================= */

function streamKey(ctx, x){
  var sid = ctx.type === "series" ? ctx.id + ":" + ctx.season + ":" + ctx.episode : ctx.id;
  return "stremio:" + sid + ":" + (x.hash ? x.hash + ":" + (x.fileIdx === undefined ? "" : x.fileIdx) : x.i);
}

/* ctx = {type, id, name, poster, year, season, episode, epName} */
function buildOpts(ctx, x){
  var sub = ctx.type === "series" ? epLabel(ctx.season, ctx.episode) + (ctx.epName ? " · " + ctx.epName : "") : (ctx.year || "");
  if(x.quality) sub += (sub ? " · " : "") + x.quality;
  var opts = {
    title: ctx.name, subtitle: sub, url: x.url,
    key: streamKey(ctx, x),
    poster: ctx.poster,
    meta: { type: ctx.type, imdbId: ctx.id, season: ctx.type === "series" ? ctx.season : undefined,
            episode: ctx.type === "series" ? ctx.episode : undefined, title: ctx.name,
            filename: x.filename || undefined, source: "stremio" }
  };
  if(ctx.type === "series"){
    opts.next = function(){ return nextOpts(ctx); };
  }
  return opts;
}

/* Siguiente episodio (salta especiales y episodios aún no emitidos) */
function nextEpisode(videos, season, episode){
  var now = Date.now();
  var aired = videos.filter(function(v){ return !(v.released && Date.parse(v.released) > now); });
  var sameSeason = aired.filter(function(v){ return v.season === season && v.episode > episode; })
    .sort(function(a, b){ return a.episode - b.episode; });
  if(sameSeason.length) return sameSeason[0];
  if(season === 0) return null;
  var later = aired.filter(function(v){ return v.season > season; })
    .sort(function(a, b){ return a.season - b.season || a.episode - b.episode; });
  return later.length ? later[0] : null;
}

function nextOpts(ctx){
  return getMeta("series", ctx.id, { name: ctx.name, poster: ctx.poster }).then(function(meta){
    var v = nextEpisode(meta.videos, Number(ctx.season), Number(ctx.episode));
    if(!v) return null;
    var nctx = { type: "series", id: ctx.id, name: meta.name || ctx.name, poster: meta.poster || ctx.poster,
                 season: v.season, episode: v.episode, epName: v.name };
    return fetchStreams("series", ctx.id + ":" + v.season + ":" + v.episode).then(function(r){
      var best = bestStream(r.visible);
      if(!best){ console.info("[buscar] siguiente episodio sin fuente instantánea:", v.season, v.episode); return null; }
      return buildOpts(nctx, best);
    });
  }).catch(function(e){ console.warn("[buscar] siguiente episodio:", e && e.message); return null; });
}

/* playTitle({type, id, season, episode, name, poster}) → Promise<{played:boolean}>
 * Reproduce la mejor fuente; si no hay ninguna instantánea abre la lista de fuentes. */
function playTitle(o){
  o = o || {};
  var type = o.type === "series" ? "series" : "movie";
  var ctx = { type: type, id: o.id, name: o.name || "", poster: o.poster || "",
              season: o.season !== undefined ? Number(o.season) : undefined,
              episode: o.episode !== undefined ? Number(o.episode) : undefined };
  if(!addonBase()){
    App.go("search", { open: { type: type, id: o.id, name: o.name, poster: o.poster, season: ctx.season, episode: ctx.episode } });
    return Promise.resolve({ played: false });
  }
  App.ui.toast(t("search.findingBest"), 2500);
  return getMeta(type, o.id, { name: o.name, poster: o.poster }).catch(function(){ return null; }).then(function(meta){
    if(meta){
      ctx.name = meta.name || ctx.name; ctx.poster = meta.poster || ctx.poster; ctx.year = meta.year;
      if(type === "series"){
        var v = meta.videos.filter(function(x){ return x.season === ctx.season && x.episode === ctx.episode; })[0];
        if(v) ctx.epName = v.name;
      }
    }
    var sid = type === "series" ? o.id + ":" + ctx.season + ":" + ctx.episode : o.id;
    return fetchStreams(type, sid).then(function(r){
      var best = bestStream(r.visible);
      if(best && App.player){
        App.ui.toast(t("search.playingBest", { desc: describe(best) }), 4500);
        App.player.play(buildOpts(ctx, best));
        return { played: true };
      }
      App.ui.toast(t("search.noInstant"), 4000);
      App.go("search", { open: { type: type, id: o.id, name: ctx.name, poster: ctx.poster, season: ctx.season, episode: ctx.episode } });
      return { played: false };
    });
  }).catch(function(e){
    App.ui.toast(t("search.err.addon", { msg: e.message }), 4500);
    return { played: false };
  });
}

App.search = { bestStream: bestStream, bestDownload: bestDownload, playTitle: playTitle, fetchStreams: fetchStreams,
                suggest: function(p){ return suggest(p); }, addons: function(){ return addonBases(); } };

/* ======================= Estado ======================= */

var s = {
  el: null, grid: null,
  level: "root",               // root | detail | streams
  q: "", reqId: 0,
  results: null,               // {movies:[], series:[]} | null
  loading: false, error: "",
  item: null,                  // meta resumida del catálogo
  meta: null,                  // meta completa (localizada)
  season: null, seasons: [],
  ep: null,                    // {season, episode, name, overview}
  streams: null, hiddenStreams: [], rendered: [], showHidden: false,
  streamsErr: "", streamsLoading: false,
  focusMem: {},                // índice de foco por nivel
  playing: false,
  openMode: false, openLevel: null,  // llegado desde Inicio con params.open
  didYou: "", seen: [],
  packMode: null, packs: null, packsHidden: [], packsErr: "", packsLoading: false
};

/* ======================= Estado en TorBox (biblioteca / en descarga) ======================= */

var tb = { byHash: {}, timer: null, busy: false };

function refreshTorbox(){
  if(tb.busy || !App.torbox.hasToken()) return;
  tb.busy = true;
  // Torrents de todas las cuentas configuradas (TorBox y/o Real-Debrid)
  var srcs = App.torbox.SOURCES.filter(function(x){ return x === "torrents" || x === "rd"; });
  Promise.all(srcs.map(function(x){ return App.torbox.list(x, { all: true, fresh: true }).catch(function(){ return []; }); }))
  .then(function(ls){ var items = []; ls.forEach(function(l){ items = items.concat(l || []); }); return items; }).then(function(items){
    var m = {};
    (items || []).forEach(function(it){ if(it && it.hash) m[String(it.hash).toLowerCase()] = it; });
    tb.byHash = m;
    updateStatusDom();
  }).catch(function(e){ console.warn("[buscar] estado TorBox:", e && e.message); })
    .then(function(){ tb.busy = false; });
}
function playerActive(){ return !!(App.player && App.player.isActive && App.player.isActive()); }
function wantPolling(){
  return App.current() === "search" && (s.level === "detail" || s.level === "streams" || s.level === "packs") && !playerActive();
}
function stopPolling(){ if(tb.timer){ clearInterval(tb.timer); tb.timer = null; } }
function syncPolling(){
  if(!wantPolling()){ stopPolling(); return; }
  if(tb.timer) return;
  refreshTorbox();
  tb.timer = setInterval(function(){ if(wantPolling()) refreshTorbox(); else stopPolling(); }, 5000);
}
App.bus.on("player:start", stopPolling);
App.bus.on("player:close", function(){ setTimeout(syncPolling, 500); });

function statusOf(x){
  var it = x && x.hash ? tb.byHash[x.hash] : null;
  if(!it) return null;
  if(App.torbox.isFinished(it)) return { kind: "library", item: it };
  var p = Number(it.progress) || 0;
  if(p <= 1) p = p * 100;
  return { kind: "downloading", item: it, pct: Math.max(0, Math.min(100, Math.round(p))),
           speed: Number(it.download_speed) || 0, eta: Number(it.eta) || 0 };
}
function fmtEta(sec){
  sec = Math.round(sec || 0);
  if(sec <= 0) return "";
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? h + "h " + pad2(m) + "m" : (m ? m + "m" : sec + "s");
}
function statusBadge(st){
  if(!st) return "";
  if(st.kind === "library") return '<span class="srch-tag ok">' + App.esc(t("search.status.library")) + '</span>';
  return '<span class="srch-tag warn">' + App.esc(t("search.status.downloading", { pct: st.pct })) + '</span>';
}
function statusExtra(st){
  if(!st || st.kind !== "downloading") return "";
  var info = [];
  if(st.speed) info.push(App.fmtSize(st.speed) + "/s");
  if(st.eta) info.push(t("search.status.eta", { eta: fmtEta(st.eta) }));
  return '<div class="srch-progline"><div class="srch-bar"><i style="width:' + st.pct + '%"></i></div>' +
         (info.length ? '<span class="srch-proginfo">' + App.esc(info.join(" · ")) + '</span>' : '') + '</div>';
}

/* Repinta en sitio las insignias de estado y los resúmenes (sin re-renderizar ni perder el foco) */
function updateStatusDom(){
  if(!s.el) return;
  Array.prototype.forEach.call(s.el.querySelectorAll("[data-sth]"), function(el){
    el.innerHTML = statusBadge(statusOf({ hash: el.getAttribute("data-sth") }));
  });
  Array.prototype.forEach.call(s.el.querySelectorAll("[data-stx]"), function(el){
    el.innerHTML = statusExtra(statusOf({ hash: el.getAttribute("data-stx") }));
  });
  Array.prototype.forEach.call(s.el.querySelectorAll("[data-pid]"), function(el){
    el.innerHTML = previewHtml(el.getAttribute("data-pid"));
  });
}

/* ======================= Vista previa al enfocar ======================= */

var pv = { res: {}, timer: null, inflight: null, pending: null };

function previewKeyFor(el){
  if(!el) return null;
  if(s.level === "root"){
    var m = itemFromEl(el);
    return m && m.type === "movie" ? { key: "movie|" + m.id, type: "movie", id: m.id } : null;
  }
  if(s.level === "detail" && s.item){
    var v = epFromEl(el);
    if(!v) return null;
    var sid = s.item.id + ":" + v.season + ":" + v.episode;
    return { key: "series|" + sid, type: "series", id: sid };
  }
  return null;
}
function previewKey(type, id){ return type + "|" + id; }

function schedulePreview(el){
  clearTimeout(pv.timer);
  if(!addonBase()) return;
  var k = previewKeyFor(el);
  if(!k || pv.res[k.key]) return;
  pv.timer = setTimeout(function(){ queuePreview(k); }, 400);
}
function queuePreview(k){
  if(pv.res[k.key]) return;
  if(pv.inflight){ if(pv.inflight.key !== k.key) pv.pending = k; return; }
  pv.inflight = k;
  setPreviewDom(k.key, '<span class="srch-pv-tags"><span class="srch-pv-note">' + App.esc(t("search.prev.loading")) + '</span></span>');
  fetchStreams(k.type, k.id).then(function(r){ pv.res[k.key] = r; })
    .catch(function(){ pv.res[k.key] = { visible: [], hidden: [], err: true }; })
    .then(function(){
      pv.inflight = null;
      setPreviewDom(k.key, previewHtml(k.key));
      var n = pv.pending; pv.pending = null;
      if(n && App.current() === "search") queuePreview(n);
    });
}
function setPreviewDom(key, html){
  if(!s.el) return;
  Array.prototype.forEach.call(s.el.querySelectorAll("[data-pid]"), function(el){
    if(el.getAttribute("data-pid") === key) el.innerHTML = html;
  });
}
function tagHtml(cls, txt){ return '<span class="srch-tag' + (cls ? " " + cls : "") + '">' + App.esc(txt) + '</span>'; }
/* Vista previa de la mejor fuente como etiquetas: estado (biblioteca/descarga) + "Al instante", calidad, idioma, tamaño, +N */
function previewHtml(key){
  var r = pv.res[key];
  if(!r) return "";
  var note = function(txt){ return '<span class="srch-pv-tags"><span class="srch-pv-note">' + App.esc(txt) + '</span></span>'; };
  if(r.err) return note(t("search.prev.error"));
  var all = r.visible.concat(r.hidden);
  var lib = false, dl = -1;
  all.forEach(function(x){
    var st = statusOf(x);
    if(!st) return;
    if(st.kind === "library") lib = true; else dl = Math.max(dl, st.pct);
  });
  var out = "";
  if(lib) out += '<span class="srch-pv-st ok">' + App.esc(t("search.v2.inLibrary")) + '</span>';
  else if(dl >= 0) out += '<span class="srch-pv-st warn">' + App.esc(t("search.v2.downloading", { pct: dl })) + '</span>';
  var best = bestStream(r.visible);
  var nInst = r.visible.filter(isInstant).length;
  if(best){
    var tg = tagHtml("solid", t("search.v2.instant"));
    if(best.quality) tg += tagHtml("", best.quality);
    var L = langLabels(best);
    if(L.length) tg += tagHtml("", L[0]);
    if(best.size) tg += tagHtml("", App.fmtSize(best.size));
    if(r.visible.length > 1) tg += '<span class="srch-pv-more">' + App.esc(t("search.v2.moreSources", { n: r.visible.length - 1 })) + '</span>';
    out += '<span class="srch-pv-tags">' + tg + '</span>';
  }
  else if(r.visible.length) out += note(t("search.prev.noInstant", { n: r.visible.length - nInst }));
  else out += note(t("search.prev.none"));
  return out;
}

function hintFor(level){
  if(level === "detail") return t(App.settings.get("autoPlayBest") ? "search.hint.detailAuto" : "search.hint.detail");
  if(level === "streams") return t("search.hint.streams");
  if(level === "packs") return t("search.hint.packs");
  return t(App.settings.get("autoPlayBest") ? "search.hint.rootAuto" : "search.hint.root");
}
function setHint(){ App.setHintDefault(hintFor(s.level)); }

/* ======================= Render común ======================= */

var ICON_SEARCH = '<svg class="srch-ico" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';
var ICON_PLAY = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>';
var ICON_CHECK = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
var ICON_PLUS = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

/* Fondo backdrop con degradado (detalle/fuentes/packs) */
function backdropHtml(bg){
  return '<div class="srch-bd' + (bg ? " on" : "") + '"' + (bg ? ' style="background-image:url(\'' + App.esc(bg) + '\')"' : '') + '></div><div class="srch-shade"></div>';
}

function posterCard(m, i){
  var title = m.name || "?";
  var year = m.year || m.releaseInfo || "";
  var rating = m.imdbRating ? "★ " + m.imdbRating : "";
  var pk = previewKey("movie", m.id);
  return '<div class="srch-card focusable" data-act="item" data-type="' + App.esc(m.type) + '" data-i="' + i + '">' +
      '<div class="srch-poster' + (m.poster ? " has-img" : "") + '" style="' + App.ui.placeholderStyle(title) + '">' +
        '<div class="srch-initials">' + App.esc(App.ui.initials(title)) + '</div>' +
        (m.poster ? '<img class="srch-img" src="' + App.esc(m.poster) + '" alt="" onerror="this.parentNode.classList.remove(\'has-img\')">' : '') +
        (rating ? '<div class="srch-rating">' + App.esc(rating) + '</div>' : '') +
        (m.type === "series" ? '<div class="srch-kind">' + App.esc(t("search.seriesBadge")) + '</div>' : '') +
      '</div>' +
      '<div class="srch-card-title">' + App.esc(title) + '</div>' +
      '<div class="srch-card-sub">' + App.esc(year) + '</div>' +
      (m.type === "movie" && addonBase() ? '<div class="srch-pv srch-card-pv" data-pid="' + App.esc(pk) + '">' + previewHtml(pk) + '</div>' : '') +
    '</div>';
}

function stateBlock(cls, title, text){
  return '<div class="srch-state' + (cls ? " " + cls : "") + '"><h2>' + App.esc(title) + '</h2>' +
         (text ? '<p>' + text + '</p>' : '') + '</div>';
}

function noAddonHtml(){
  var url = App.remote && App.remote.url ? App.remote.url() : "";
  return stateBlock("", t("search.noAddon.title"),
    App.esc(t("search.noAddon.text")) + (url ? ' <b>' + App.esc(url) + '</b>' : "") + " " + App.esc(t("search.noAddon.orSettings")));
}

function mountGrid(onSelect, startIndex){
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect, onFocus: function(i, el){ schedulePreview(el); } });
  var idx = startIndex || 0;
  if(idx >= s.grid.items.length) idx = 0;
  s.grid.focus(idx, true);
  if(document.body.classList.contains("zone-header")) s.grid.blur();
  else schedulePreview(s.grid.current());
  syncPolling();
}

function remember(){ if(s.grid) s.focusMem[s.level] = s.grid.index; }

/* ======================= Nivel raíz ======================= */

function renderRoot(){
  s.level = "root"; setHint();
  var h = '<div class="srch-w"><div class="srch-scroll">';
  h += '<div class="srch-top"><div class="srch-field focusable' + (s.q ? " has-q" : "") + '" data-act="kb">' + ICON_SEARCH +
       '<span class="srch-field-txt">' + App.esc(s.q || t("search.placeholder")) + '</span></div></div>';

  if(s.loading){
    h += '<div class="srch-state"><div class="spinner"></div><p>' + App.esc(t("search.searching", { q: s.q })) + '</p></div>';
  } else if(s.error){
    h += stateBlock("err", t("search.err.searchTitle"), App.esc(s.error));
  } else if(s.results){
    var mv = s.results.movies, sr = s.results.series;
    if(!mv.length && !sr.length){
      h += stateBlock("", t("search.noResults.title"), App.esc(t("search.noResults.text", { q: s.q })));
    } else {
      if(s.didYou) h += '<div class="srch-didyou">' + App.esc(t("search.didYou", { q: s.didYou })) + '</div>';
      if(mv.length){
        h += '<div class="srch-sec">' + App.esc(t("search.movies")) + ' <span>' + mv.length + '</span></div><div class="srch-prow">';
        mv.forEach(function(m, i){ h += posterCard(m, i); });
        h += '</div>';
      }
      if(sr.length){
        h += '<div class="srch-sec">' + App.esc(t("search.series")) + ' <span>' + sr.length + '</span></div><div class="srch-prow">';
        sr.forEach(function(m, i){ h += posterCard(m, i); });
        h += '</div>';
      }
      if(!addonBase()) h += '<p class="srch-note">' + App.esc(t("search.noAddonNote")) + '</p>';
    }
  } else {
    var rc = recent();
    if(rc.length){
      h += '<div class="srch-sec">' + App.esc(t("search.recent")) + '</div><div class="srch-chips">';
      rc.forEach(function(q, i){ h += '<div class="srch-chip focusable" data-act="recent" data-i="' + i + '">' + App.esc(q) + '</div>'; });
      h += '</div>';
    }
    s.seen = seenTitles(rc);
    if(s.seen.length){
      h += '<div class="srch-sec">' + App.esc(t("search.seen")) + '</div><div class="srch-chips">';
      s.seen.forEach(function(q, i){ h += '<div class="srch-chip focusable" data-act="seen" data-i="' + i + '">' + App.esc(q) + '</div>'; });
      h += '</div>';
    }
    if(!addonBase()) h += noAddonHtml();
    else h += stateBlock("", t("search.empty.title"), App.esc(t("search.empty.text")));
  }
  h += '</div></div>';
  s.el.innerHTML = h;
  mountGrid(onRootSelect, s.focusMem.root);
}

function itemFromEl(el){
  if(!el || el.getAttribute("data-act") !== "item" || !s.results) return null;
  var list = el.getAttribute("data-type") === "series" ? s.results.series : s.results.movies;
  return list[Number(el.getAttribute("data-i"))] || null;
}

function onRootSelect(i, el){
  var act = el.getAttribute("data-act");
  if(act === "kb") return openKeyboard();
  if(act === "recent"){ var q = recent()[Number(el.getAttribute("data-i"))]; if(q) doSearch(q); return; }
  if(act === "seen"){ var sq = (s.seen || [])[Number(el.getAttribute("data-i"))]; if(sq) doSearch(sq); return; }
  if(act === "item"){
    var m = itemFromEl(el);
    if(!m) return;
    remember();
    openItem(m, { autoPlay: !!App.settings.get("autoPlayBest") });
  }
}

function openKeyboard(){
  if(!App.ui.keyboard){ App.hint(t("search.noKeyboard")); return; }
  App.ui.keyboard.open({
    title: t("search.kbTitle"), value: s.q, placeholder: t("search.kbPlaceholder"),
    onDone: function(v){ v = String(v || "").trim(); if(v) doSearch(v); }
  });
}

function catalog(type, q){
  return getJson(CINEMETA + "/catalog/" + type + "/top/search=" + encodeURIComponent(q) + ".json", 15000, t("search.err.cinemeta"))
    .then(function(j){
      return (j.metas || []).filter(function(m){ return m && m.id && /^tt\d+/.test(m.id); }).map(function(m){
        return { id: m.id, type: type, name: m.name, poster: m.poster, background: m.background,
                 year: m.releaseInfo || m.year || "", imdbRating: m.imdbRating || "", description: m.description || "" };
      });
    });
}

/* ---- #31 tolerancia a faltas / #32 sugerencias ---- */
function stripAccents(x){
  x = String(x || "");
  return x.normalize ? x.normalize("NFD").replace(/[̀-ͯ]/g, "") : x;
}
function normQ(x){ return stripAccents(x).toLowerCase().replace(/\s+/g, " ").trim(); }

function editDist(a, b){
  if(a === b) return 0;
  if(!a.length) return b.length;
  if(!b.length) return a.length;
  var prev = [], i, j;
  for(j = 0; j <= b.length; j++) prev[j] = j;
  for(i = 1; i <= a.length; i++){
    var cur = [i];
    for(j = 1; j <= b.length; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/* Títulos vistos (historial del reproductor), sin repetidos */
function historyTitles(){
  var out = [];
  try{
    var l = App.history && App.history.list ? App.history.list() : [];
    (l || []).forEach(function(e){
      if(!e || String(e.key || "").indexOf("live:") === 0) return;
      var m = (e && e.meta) || {};
      var ti = m.showTitle || m.title || (e && e.title) || "";
      if(ti && out.indexOf(ti) < 0) out.push(ti);
    });
  }catch(e){}
  return out;
}
function seenTitles(rc){
  var low = (rc || []).map(normQ);
  return historyTitles().filter(function(x){ return low.indexOf(normQ(x)) < 0; }).slice(0, 8);
}

/* suggest(prefix) → búsquedas anteriores y títulos vistos que encajan con lo escrito */
function suggest(prefix){
  var p = normQ(prefix);
  if(!p) return [];
  var out = [];
  recent().concat(historyTitles()).forEach(function(x){
    var n = normQ(x);
    if(n !== p && n.indexOf(p) >= 0 && out.indexOf(x) < 0) out.push(x);
  });
  return out.slice(0, 6);
}

/* Variaciones a probar cuando Cinemeta no devuelve nada */
function variantsOf(q){
  var out = [], ql = normQ(q);
  function add(v){
    v = String(v || "").trim();
    if(v.length < 2 || v === q) return;
    if(out.indexOf(v) < 0) out.push(v);
  }
  var near = [];
  recent().concat(historyTitles()).forEach(function(k){
    var kn = normQ(k);
    if(!kn || kn === ql) return;
    var d = editDist(ql, kn);
    if(d <= Math.max(1, Math.floor(Math.min(ql.length, kn.length) / 4))) near.push({ k: k, d: d });
  });
  near.sort(function(a, b){ return a.d - b.d; }).slice(0, 2).forEach(function(n){ add(n.k); });
  var na = stripAccents(q);
  if(na !== q) add(na);
  var words = ql.split(" ");
  if(words.length > 1){
    add(words.join(""));                                   // "spider man" → "spiderman"
    var longest = words.slice().sort(function(a, b){ return b.length - a.length; })[0];
    if(longest.length >= 4) add(longest);
  } else if(ql.length >= 8){
    var half = Math.ceil(ql.length / 2);
    add(ql.slice(0, half) + " " + ql.slice(half));         // palabras pegadas: intento partir por la mitad
  }
  if(ql.length > 4) add(ql.slice(0, -1));
  if(ql.length > 6) add(ql.slice(0, -2));
  return out.slice(0, 6);
}

function runCatalogs(q){
  return Promise.all([
    catalog("movie", q).catch(function(e){ return { err: e }; }),
    catalog("series", q).catch(function(e){ return { err: e }; })
  ]);
}
function hasAny(r){ return (!r[0].err && r[0].length) || (!r[1].err && r[1].length); }

function doSearch(q){
  s.q = q; s.loading = true; s.error = ""; s.results = null; s.focusMem.root = 0; s.didYou = "";
  s.openMode = false; s.openLevel = null;
  var id = ++s.reqId;
  renderRoot();
  runCatalogs(q).then(function(r){
    if(id !== s.reqId) return null;
    if(r[0].err && r[1].err || hasAny(r)) return { r: r, v: "" };
    // 0 resultados: reintentar con variaciones (se prueban en serie, la primera con resultados gana)
    var vars = variantsOf(q), n = 0;
    function next(){
      if(id !== s.reqId) return Promise.resolve(null);
      if(n >= vars.length) return Promise.resolve({ r: r, v: "" });
      var v = vars[n++];
      return runCatalogs(v).then(function(rv){ return hasAny(rv) ? { r: rv, v: v } : next(); });
    }
    return next();
  }).then(function(o){
    if(!o || id !== s.reqId) return;
    var r = o.r;
    s.loading = false;
    if(r[0].err && r[1].err){ s.error = t("search.err.cinemetaDown", { msg: r[0].err.message }); }
    else {
      s.results = { movies: r[0].err ? [] : r[0], series: r[1].err ? [] : r[1] };
      s.didYou = o.v;
      if(s.results.movies.length || s.results.series.length) pushRecent(o.v || q);
    }
    // foco directo al primer resultado
    s.focusMem.root = s.results && (s.results.movies.length || s.results.series.length) ? 1 : 0;
    if(App.current() === "search" && s.level === "root") renderRoot();
  });
}

/* ======================= Detalle de serie ======================= */

/* openItem(m, {autoPlay, season, episode}) */
function openItem(m, o){
  o = o || {};
  s.item = m; s.meta = null; s.ep = null;
  if(m.type === "movie"){
    openStreams({ autoPlay: !!o.autoPlay });
    // ficha localizada para la cabecera (no bloquea)
    var mid = s.reqId;
    getMeta("movie", m.id, m).then(function(meta){
      if(s.item !== m) return;
      s.meta = meta;
      if(App.current() === "search" && s.level === "streams" && mid <= s.reqId) renderStreams();
    }).catch(function(){});
    return;
  }
  s.level = "detail"; s.focusMem.detail = 0; setHint();
  App.ui.loading(s.el, t("search.loadingEpisodes", { name: m.name || "" }));
  var id = ++s.reqId;
  getMeta("series", m.id, m)
    .then(function(meta){
      if(id !== s.reqId) return;
      s.meta = meta;
      s.seasons = seasonsOf(meta.videos);
      var wantS = o.season !== undefined ? Number(o.season) : null;
      if(wantS !== null && s.seasons.indexOf(wantS) >= 0) s.season = wantS;
      else if(s.season === null || s.seasons.indexOf(s.season) < 0 || s.lastSeriesId !== m.id) s.season = s.seasons.length ? s.seasons[0] : null;
      s.lastSeriesId = m.id;
      if(wantS !== null && o.episode !== undefined){
        var v = meta.videos.filter(function(x){ return x.season === wantS && x.episode === Number(o.episode); })[0];
        if(v){
          s.ep = v;
          if(s.openMode) s.openLevel = "streams";
          openStreams({ autoPlay: false });
          return;
        }
      }
      renderDetail();
    })
    .catch(function(e){
      if(id !== s.reqId) return;
      App.ui.error(s.el, t("search.err.series"), e.message);
      s.grid = null;
    });
}

var ICON_DOTS = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>';

function titleSizeCls(name){
  var n = String(name || "").length;
  return n > 34 ? "xs" : (n > 20 ? "sm" : "");
}

/* Línea de meta: año · N temporadas · géneros · ★ nota */
function metaLine(meta, nSeasons){
  var parts = [];
  if(meta.year) parts.push('<span>' + App.esc(meta.year) + '</span>');
  if(nSeasons) parts.push('<span>' + App.esc(t("search.v2.seasons", { n: nSeasons })) + '</span>');
  if(meta.genres && meta.genres.length) parts.push('<span>' + App.esc(meta.genres.join(", ")) + '</span>');
  if(meta.rating) parts.push('<span class="srch-rate">★ ' + App.esc(meta.rating) + ' IMDb</span>');
  return parts.join('<span class="srch-dot">·</span>');
}

/* Columna izquierda de la ficha: título, meta, sinopsis y botones (HTML ya construido) */
function infoHtml(meta, nSeasons, buttons){
  return '<section class="srch-info"><h1 class="srch-title ' + titleSizeCls(meta.name) + '">' + App.esc(meta.name) + '</h1>' +
    '<div class="srch-meta">' + metaLine(meta, nSeasons) + '</div>' +
    (meta.description ? '<p class="srch-ov">' + App.esc(meta.description) + '</p>' : '') +
    (buttons ? '<div class="srch-btns">' + buttons + '</div>' : '') + '</section>';
}

/* Historial de la serie: mapa "s:e" → {watched, pct} y último episodio visto */
function seriesHistory(id){
  var out = { map: {}, last: null };
  try{
    ((App.history && App.history.list ? App.history.list() : []) || []).forEach(function(e){
      var m = (e && e.meta) || {};
      if(m.imdbId !== id || m.season === undefined || m.season === null) return;
      var k = Number(m.season) + ":" + Number(m.episode);
      var pct = e.dur > 0 ? e.pos / e.dur : 0;
      var w = !!e.watched || pct >= 0.9;
      var upd = e.updated || 0;
      var cur = out.map[k];
      if(!cur || upd >= cur.updated) out.map[k] = { watched: w, pct: pct, updated: upd };
      if(!out.last || upd >= out.last.updated) out.last = { season: Number(m.season), episode: Number(m.episode), watched: w, updated: upd };
    });
  }catch(e){}
  return out;
}

/* Episodio al que lleva el botón principal: reanudar el último empezado, el siguiente al último visto o el primero */
function playTarget(hist){
  var vids = (s.meta && s.meta.videos) || [];
  if(!vids.length) return null;
  function find(se, ep){ return vids.filter(function(v){ return v.season === se && v.episode === ep; })[0]; }
  if(hist.last){
    if(!hist.last.watched){
      var cur = find(hist.last.season, hist.last.episode);
      if(cur) return { kind: "resume", ep: cur };
    } else {
      var nx = nextEpisode(vids, hist.last.season, hist.last.episode);
      if(nx) return { kind: "next", ep: nx };
    }
  }
  var aired = vids.filter(function(v){ return v.season > 0 && !(v.released && Date.parse(v.released) > Date.now()); });
  if(!aired.length) aired = vids.slice();
  aired.sort(function(a, b){ return (a.season || 1e6) - (b.season || 1e6) || a.episode - b.episode; });
  return aired.length ? { kind: "first", ep: aired[0] } : null;
}

function renderDetail(focusSeason){
  s.level = "detail"; setHint();
  var meta = s.meta;
  var hist = seriesHistory(s.item.id);
  var tgt = s.seasons.length ? playTarget(hist) : null;
  s.playTgt = tgt;
  var realSeasons = s.seasons.filter(function(n){ return n > 0; }).length;

  var btns = "";
  if(tgt){
    btns += '<div class="srch-btn primary focusable" data-act="play">' + ICON_PLAY + '<span>' +
      App.esc(tgt.kind === "resume" ? t("search.v2.resume", { ep: epLabel(tgt.ep.season, tgt.ep.episode) }) : t("search.v2.playBest")) + '</span>' +
      (tgt.kind === "resume" ? '' : '<small>' + App.esc(epLabel(tgt.ep.season, tgt.ep.episode)) + '</small>') + '</div>';
  }
  if(App.follow && s.item){
    var fol = App.follow.isFollowing(s.item.id);
    btns += '<div class="srch-btn focusable' + (fol ? " on" : "") + '" data-act="follow">' + (fol ? ICON_CHECK : ICON_PLUS) +
            '<span>' + App.esc(t(fol ? "search.v2.following" : "search.v2.follow")) + '</span></div>';
  }
  if(addonBase() && s.seasons.length && s.season !== 0 && s.season !== null){
    btns += '<div class="srch-btn focusable" data-act="packs" data-mode="season"><span>' + App.esc(t("search.v2.fullSeason")) + '</span></div>';
  }
  btns += '<div class="srch-btn icon focusable" data-act="more" aria-label="' + App.esc(t("search.v2.more")) + '">' + ICON_DOTS + '</div>';

  var h = '<div class="srch-w">' + backdropHtml(meta.background) + '<div class="srch-scroll srch-dscroll">' +
          infoHtml(meta, realSeasons, btns);
  if(!s.seasons.length){
    h += stateBlock("", t("search.noEpisodes.title"), App.esc(t("search.noEpisodes.text")));
  } else {
    h += '<div class="srch-seasons">';
    s.seasons.forEach(function(n){
      h += '<div class="srch-chip focusable' + (n === s.season ? " active" : "") + '" data-act="season" data-s="' + n + '">' +
           App.esc(n === 0 ? t("search.specials") : t("search.season", { n: n })) + '</div>';
    });
    h += '</div><div class="srch-eps">';
    var now = Date.now();
    meta.videos.filter(function(v){ return v.season === s.season; })
      .sort(function(a, b){ return a.episode - b.episode; })
      .forEach(function(v){
        var future = v.released && Date.parse(v.released) > now;
        var pid = previewKey("series", s.item.id + ":" + v.season + ":" + v.episode);
        var hi = hist.map[v.season + ":" + v.episode];
        var nm = v.name || t("search.episode", { n: v.episode });
        var sub = future ? t("search.comingSoon") : (v.runtime ? t("search.v2.min", { n: v.runtime }) : (v.released ? String(v.released).slice(0, 10) : ""));
        h += '<div class="srch-ep focusable' + (future ? " dim" : "") + '" data-act="ep" data-e="' + v.episode + '">' +
             '<div class="srch-ep-img">' +
               '<span class="srch-ep-num">' + App.esc(pad2(v.episode)) + '</span>' +
               (v.thumbnail ? '<img src="' + App.esc(v.thumbnail) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
               (hi && hi.watched ? '<span class="srch-ep-seen">' + App.esc(t("search.v2.watched")) + '</span>' : '') +
               (hi && !hi.watched && hi.pct > 0.02 ? '<div class="srch-ep-bar"><i style="width:' + Math.round(hi.pct * 100) + '%"></i></div>' :
                 (hi && hi.watched ? '<div class="srch-ep-bar"><i style="width:100%"></i></div>' : '')) +
             '</div>' +
             '<div class="srch-ep-body">' +
               '<div class="srch-ep-title">' + App.esc(t("search.epShort", { e: pad2(v.episode) }) + " · " + nm) + '</div>' +
               (sub ? '<div class="srch-ep-sub">' + App.esc(sub) + '</div>' : '') +
               (v.overview ? '<div class="srch-ep-ov">' + App.esc(v.overview) + '</div>' : '') +
               (addonBase() && !future ? '<div class="srch-pv" data-pid="' + App.esc(pid) + '">' + previewHtml(pid) + '</div>' : '') +
             '</div></div>';
      });
    h += '</div>';
  }
  h += '</div></div>';
  s.el.innerHTML = h;
  var start = s.focusMem.detail;
  if(focusSeason){
    var all = s.el.querySelectorAll(".focusable");
    for(var i = 0; i < all.length; i++){ if(all[i].classList.contains("active") && all[i].getAttribute("data-act") === "season"){ start = i; break; } }
    s.focusMem.detail = start;
  }
  mountGrid(onDetailSelect, start);
}

function epFromEl(el){
  if(!el || el.getAttribute("data-act") !== "ep" || !s.meta) return null;
  var e = Number(el.getAttribute("data-e"));
  return s.meta.videos.filter(function(x){ return x.season === s.season && x.episode === e; })[0] || null;
}

function onDetailSelect(i, el){
  var act = el.getAttribute("data-act");
  if(act === "play"){
    if(s.playTgt){ remember(); s.ep = s.playTgt.ep; openStreams({ autoPlay: true }); }
    return;
  }
  if(act === "more"){ if(App.openMenu) App.openMenu(); return; }
  if(act === "follow"){
    var sr = curSeries();
    if(sr){ toggleFollow(sr); s.focusMem.detail = i; renderDetail(); }
    return;
  }
  if(act === "season"){
    var n = Number(el.getAttribute("data-s"));
    if(n !== s.season){ s.season = n; s.focusMem.detail = i; renderDetail(); }
    return;
  }
  if(act === "packs"){
    remember();
    openPacks(el.getAttribute("data-mode") === "series" ? "series" : "season");
    return;
  }
  if(act === "ep"){
    var v = epFromEl(el);
    if(!v) return;
    remember();
    s.ep = v;
    openStreams({ autoPlay: !!App.settings.get("autoPlayBest") });
  }
}

function changeSeason(dir){
  var i = s.seasons.indexOf(s.season);
  var n = s.seasons[i + dir];
  if(n === undefined) return;
  s.season = n;
  renderDetail(true);
}

/* ======================= Fuentes ======================= */

function curCtx(){
  var meta = s.meta || {};
  return {
    type: s.item.type === "series" ? "series" : "movie", id: s.item.id,
    name: meta.name || s.item.name, poster: meta.poster || s.item.poster, year: meta.year || s.item.year,
    season: s.ep ? s.ep.season : undefined, episode: s.ep ? s.ep.episode : undefined, epName: s.ep ? s.ep.name : ""
  };
}
function streamId(){
  if(s.item.type === "series" && s.ep) return s.item.id + ":" + s.ep.season + ":" + s.ep.episode;
  return s.item.id;
}
function titleLine(){
  var name = (s.meta && s.meta.name) || s.item.name;
  if(s.ep) return name + " · " + epLabel(s.ep.season, s.ep.episode) + (s.ep.name ? " · " + s.ep.name : "");
  var y = (s.meta && s.meta.year) || s.item.year;
  return name + (y ? " (" + y + ")" : "");
}

/* openStreams({autoPlay}) */
function openStreams(o){
  o = o || {};
  s.level = "streams"; s.focusMem.streams = 0; setHint();
  s.streams = null; s.hiddenStreams = []; s.showHidden = false; s.streamsErr = "";
  if(!addonBase()){ renderStreams(); return; }
  s.streamsLoading = true;
  renderStreams();
  var id = ++s.reqId;
  var type = s.item.type === "series" ? "series" : "movie";
  var sid = streamId();
  fetchStreams(type, sid, !!o.force)
    .then(function(r){
      pv.res[previewKey(type, sid)] = r;
      if(id !== s.reqId) return;
      s.streams = r.visible; s.hiddenStreams = r.hidden;
      s.streamsLoading = false;
      var onScreen = App.current() === "search" && s.level === "streams";
      if(onScreen) renderStreams();
      if(onScreen) warnAddonErrors(r.warnings);
      if(o.autoPlay && onScreen){
        var best = bestStream(s.streams);
        if(best){
          App.ui.toast(t("search.playingBest", { desc: describe(best) }), 5000);
          playStream(best);
        } else if(s.streams.length || s.hiddenStreams.length){
          App.ui.toast(t("search.noInstant"), 4000);
        }
      }
    })
    .catch(function(e){
      if(id !== s.reqId) return;
      s.streamsLoading = false;
      s.streamsErr = e.status === 404 ? t("search.err.addon404") : t("search.err.addon", { msg: e.message });
      if(App.current() === "search" && s.level === "streams") renderStreams();
    });
}

/* streamRow(x, i, incompatible, est) — est = tamaño estimado del pack completo (vista de packs) */
function streamRow(x, i, incompatible, est){
  var badges = "";
  if(x.hash) badges += '<span class="srch-st" data-sth="' + App.esc(x.hash) + '">' + statusBadge(statusOf(x)) + '</span>';
  if(incompatible) badges += tagHtml("bad", t("caps.unsupported"));
  if(x.pack) badges += tagHtml("warn", t(x.pack.kind === "series" ? "search.badge.seriesPack" : "search.badge.seasonPack"));
  if(x.cached) badges += tagHtml("solid", t("search.badge.cached"));
  else if(x.uncachedDebrid) badges += tagHtml("warn", t("search.badge.download"));
  else if(x.url) badges += tagHtml("ok", t("search.badge.direct"));
  if(x.quality) badges += tagHtml("", x.quality);
  langLabels(x).forEach(function(l){ badges += tagHtml("", l); });
  x.tags.forEach(function(tg){ badges += tagHtml("", tg); });
  if(x.addons && addonBases().length > 1) badges += tagHtml("mute", x.addons.join(" + "));
  var meta = [];
  if(incompatible && x.capsReasons.length) meta.push('<span class="srch-why">' + App.esc(x.capsReasons.map(function(r){ return t(r); }).join(" · ")) + '</span>');
  if(x.seeders !== null) meta.push('<span class="srch-seed">' + App.esc(t("search.v2.seeds", { n: x.seeders })) + '</span>');
  if(x.provider) meta.push(App.esc(x.provider));
  var sizeHtml = "";
  if(est) sizeHtml = App.esc(t("search.sizeEst", { size: App.fmtSize(est) })) + (x.size ? '<small>' + App.esc(App.fmtSize(x.size) + " " + t("search.sizeEpisode")) + '</small>' : '');
  else if(x.size) sizeHtml = App.esc(App.fmtSize(x.size)) + (x.pack ? '<small>' + App.esc(t("search.sizeEpisode")) + '</small>' : '');
  var relName = est && x.torrentName ? x.torrentName : x.release;
  return '<div class="srch-row focusable' + (incompatible ? " dim srch-incompat" : "") + '" data-act="stream" data-i="' + i + '">' +
      '<div class="srch-main"><div class="srch-rel">' + App.esc(relName) + '</div>' +
        '<div class="srch-sub">' + (x.name ? App.esc(x.name) : "") + (x.name && meta.length ? '<span class="srch-dot">·</span>' : '') + meta.join('<span class="srch-dot">·</span>') + '</div>' +
        (x.hash ? '<div class="srch-stx" data-stx="' + App.esc(x.hash) + '">' + statusExtra(statusOf(x)) + '</div>' : '') +
      '</div>' +
      '<div class="srch-badges">' + badges + '</div>' +
      '<div class="srch-size">' + sizeHtml + '</div>' +
    '</div>';
}

function hiddenRowHtml(n){
  return '<div class="srch-row srch-hidden-row focusable" data-act="showhidden">' +
         '<div class="srch-main"><div class="srch-rel">' + App.esc(t("caps.hidden", { n: n })) + '</div>' +
         '<div class="srch-sub">' + App.esc(t("caps.showHidden")) + '</div></div></div>';
}

/* Cabecera compacta (episodio / packs): título grande + sinopsis */
function headHtml(title, overview){
  return '<div class="srch-head"><div class="srch-head-title">' + App.esc(title) + '</div>' +
         (overview ? '<p class="srch-head-ov">' + App.esc(overview) + '</p>' : '') + '</div>';
}

function renderStreams(){
  s.level = "streams"; setHint();
  var meta = s.meta || {};
  var bg = meta.background || s.item.background;
  var h = '<div class="srch-w">' + backdropHtml(bg) + '<div class="srch-scroll srch-dscroll">';
  if(s.item.type === "movie"){
    h += infoHtml({ name: meta.name || s.item.name, year: meta.year || s.item.year, rating: meta.rating || s.item.imdbRating,
                    description: meta.description || s.item.description || "", genres: meta.genres || [] }, 0, "");
  } else {
    h += headHtml(titleLine(), s.ep && s.ep.overview ? s.ep.overview : "");
  }

  s.rendered = [];
  if(!addonBase()) h += noAddonHtml();
  else if(s.streamsLoading) h += '<div class="srch-state"><div class="spinner"></div><p>' + App.esc(t("search.findingSources")) + '</p></div>';
  else if(s.streamsErr) h += stateBlock("err", t("search.err.addonTitle"), App.esc(s.streamsErr));
  else if(s.streams && !s.streams.length && !s.hiddenStreams.length) h += stateBlock("", t("search.noSources.title"), App.esc(t("search.noSources.text")));
  else if(s.streams){
    var nNow = s.streams.filter(isInstant).length;
    h += '<div class="srch-sec">' + App.esc(t("search.sources")) + ' <span>' + s.streams.length +
         (nNow ? " · " + App.esc(t("search.instantCount", { n: nNow })) : "") + '</span></div><div class="srch-list">';
    s.streams.forEach(function(x){ h += streamRow(x, s.rendered.length, false); s.rendered.push(x); });
    if(s.hiddenStreams.length){
      if(s.showHidden){
        s.hiddenStreams.forEach(function(x){ h += streamRow(x, s.rendered.length, true); s.rendered.push(x); });
      } else {
        h += hiddenRowHtml(s.hiddenStreams.length);
      }
    }
    h += '</div>';
  }
  h += '</div></div>';
  s.el.innerHTML = h;
  mountGrid(onStreamSelect, s.focusMem.streams);
}

function magnetOf(x){
  return "magnet:?xt=urn:btih:" + x.hash + (x.filename || x.release ? "&dn=" + encodeURIComponent(x.filename || x.release) : "");
}

function trackDownload(x, title){
  if(!App.watch || typeof App.watch.track !== "function") return;
  try{
    var c = curCtx();
    App.watch.track({ hash: x.hash || "", name: (x.pack && x.torrentName) || x.filename || x.release, title: title || titleLine(),
                      meta: { type: c.type, imdbId: c.id, season: c.season, episode: c.episode } });
  }catch(e){ console.warn("[buscar] watch.track:", e.message); }
}

/* Pack sin caché → confirmar (TorBox descarga el torrent entero). Resuelve "dl" | "single" | null */
function confirmPack(x, offerSingle){
  return new Promise(function(resolve){
    var series = x.pack && x.pack.kind === "series";
    var buttons = [{ label: t(series ? "search.pack.downloadSeries" : "search.pack.downloadSeason"), value: "dl" }];
    if(offerSingle) buttons.push({ label: t("search.pack.preferSingle"), value: "single" });
    buttons.push({ label: t("ui.cancel"), value: null });
    App.ui.modal({
      title: t(series ? "search.pack.confirmTitleSeries" : "search.pack.confirmTitle"),
      html: '<p>' + App.esc(t(series ? "search.pack.confirmSeries" : "search.pack.confirmSeason",
                              { size: x.size ? App.fmtSize(x.size) : "?" })) + '</p>',
      buttons: buttons, cancelValue: null,
      onClose: function(v){ resolve(v === undefined ? null : v); }
    });
  });
}

/* En la lista de un episodio: alternativa de episodio suelto (no pack) para "Preferir episodio suelto" */
function singleAlternative(x){
  for(var i = 0; i < s.rendered.length; i++){
    var y = s.rendered[i];
    if(y !== x && !y.pack && y.compatible !== false) return i;
  }
  return -1;
}

/* Si la fuente es un pack sin caché, confirma antes; luego ejecuta fn */
function guardPack(x, fn){
  if(!x.pack || x.cached || s.level !== "streams"){ fn(); return; }
  var alt = singleAlternative(x);
  confirmPack(x, alt >= 0).then(function(v){
    if(v === "dl") fn();
    else if(v === "single" && s.grid){ s.grid.focus(alt); }
  });
}

function addToTorbox(x){
  if(!x.hash){ App.ui.toast(t("search.noHash")); return Promise.resolve(); }
  var nm = (x.pack && x.torrentName) || x.filename || undefined;
  var add = App.torbox.addMagnetTo ? App.torbox.addMagnetTo(x.svc, magnetOf(x), nm) : App.torbox.addMagnet(magnetOf(x), nm);
  return add.then(function(){
    App.torbox.invalidate();
    if(!x.cached) trackDownload(x);
    App.ui.toast(x.cached ? t("search.addedCached") : t("search.added"), 4500);
    refreshTorbox();
  }).catch(function(e){ App.ui.toast(t("search.addFailed", { msg: e.message }), 4500); });
}

/* Reproducir desde la biblioteca de TorBox el archivo que corresponde a la fuente */
function epRegex(season, episode){
  if(season === undefined || episode === undefined) return null;
  return new RegExp("(\\bS0?" + season + "[\\s._-]*E0?" + episode + "(?!\\d))|(\\b" + season + "x0?" + episode + "(?!\\d))", "i");
}
function playFromLibrary(x, item){
  var c = curCtx();
  var files = (item.files || []).filter(function(f){ return App.isVideo(f); });
  if(!files.length) files = item.files || [];
  var base = function(f){ return String(f.short_name || f.name || "").split("/").pop().toLowerCase(); };
  var want = String(x.filename || "").toLowerCase();
  var pick = null;
  if(want) files.forEach(function(f){ if(!pick && base(f) === want) pick = f; });
  if(!pick && want) files.forEach(function(f){ if(!pick && (base(f).indexOf(want) >= 0 || want.indexOf(base(f)) >= 0)) pick = f; });
  var re = c.type === "series" ? epRegex(c.season, c.episode) : null;
  if(!pick && re) files.forEach(function(f){ if(!pick && re.test(base(f))) pick = f; });
  if(!pick && files.length === 1) pick = files[0];
  var go = function(f){
    App.ui.toast(t("search.playingLibrary"), 2500);
    App.torbox.link("torrents", item.id, f.id).then(function(url){
      s.playing = true;
      App.player.play(buildOpts(c, { url: url, quality: x.quality, hash: x.hash, fileIdx: f.id, i: x.i,
                                     filename: f.short_name || f.name }));
    }).catch(function(e){ App.ui.toast(t("search.addFailed", { msg: e.message }), 4500); });
  };
  if(pick){ go(pick); return; }
  App.ui.menu(t("search.chooseFile"), files.slice(0, 40).map(function(f){ return { label: base(f), value: f }; }))
    .then(function(f){ if(f) go(f); });
}

function playStream(x){
  if(!App.player){ App.hint(t("search.noPlayer")); return; }
  s.playing = true;
  App.player.play(buildOpts(curCtx(), x));
}

/* Fuente sin caché vía debrid: pedir al add-on que la mande a TorBox (o añadir el magnet) */
function sendToDebrid(x){
  var p;
  if(x.hash) p = App.torbox.addMagnetTo ? App.torbox.addMagnetTo(x.svc, magnetOf(x), x.filename || undefined)
                                        : App.torbox.addMagnet(magnetOf(x), x.filename || undefined);
  else p = App.net.fetch(x.url, { method: "GET" }).then(function(r){
    // Solo interesa que el add-on reciba la petición; no descargamos el vídeo de aviso
    try{ if(r.body && r.body.cancel) r.body.cancel(); }catch(e){}
    return r;
  });
  return p.then(function(){
    App.torbox.invalidate();
    trackDownload(x);
    console.info("[buscar] enviado a descargar en TorBox:", x.release);
    App.ui.toast(t("search.sentToDebrid"), 5000);
  }).catch(function(e){
    console.warn("[buscar] error al mandar a descargar:", e.message);
    App.ui.toast(t("search.sendFailed", { msg: e.message }), 4500);
  });
}

function onStreamSelect(i, el){
  if(el.getAttribute("data-act") === "showhidden"){
    s.showHidden = true;
    if(s.level === "packs"){ s.focusMem.packs = i; renderPacks(); } else { s.focusMem.streams = i; renderStreams(); }
    return;
  }
  var x = s.rendered[Number(el.getAttribute("data-i"))];
  if(!x) return;
  remember();
  if(s.level === "packs"){ onPackSelect(x); return; }
  var st = statusOf(x);
  if(st && st.kind === "library"){ playFromLibrary(x, st.item); return; }
  if(st && st.kind === "downloading" && !isPlayableNow(x)){
    App.ui.toast(t("search.dlInProgress", { pct: st.pct }), 3500); return;
  }
  if(x.uncachedDebrid){
    App.ui.menu(t("search.uncached.title"), [
      { label: t("search.uncached.download"), value: "dl" },
      { label: t("search.uncached.play"), value: "play" },
      { label: t("ui.cancel"), value: null }
    ]).then(function(v){
      if(v === "dl") guardPack(x, function(){ sendToDebrid(x); });
      else if(v === "play") playStream(x);
    });
    return;
  }
  if(x.url){ playStream(x); return; }
  App.ui.confirm(t("search.addConfirm"), x.release + (x.cached ? " · " + t("search.alreadyCached") : ""), t("search.add"), t("ui.cancel"))
    .then(function(ok){ if(ok) guardPack(x, function(){ addToTorbox(x); }); });
}

/* ======================= Temporada completa / packs ======================= */

function packTitle(){
  var name = (s.meta && s.meta.name) || s.item.name;
  return s.packMode === "series" ? t("search.pack.titleSeries", { name: name }) : t("search.pack.title", { name: name, n: s.season });
}

function airedEpisodes(filterFn){
  var now = Date.now();
  return ((s.meta && s.meta.videos) || []).filter(function(v){
    return !(v.released && Date.parse(v.released) > now) && filterFn(v);
  });
}

/* Tamaño estimado del pack: nº de episodios que cubre × tamaño del episodio que da el add-on */
function packEstimate(x){
  if(!x.size || !x.pack) return 0;
  var n;
  if(x.pack.kind === "series"){
    n = airedEpisodes(function(v){ return v.season > 0 && (!x.pack.seasons || x.pack.seasons.indexOf(v.season) >= 0); }).length;
  } else {
    var seasons = x.pack.seasons || [s.season];
    n = airedEpisodes(function(v){ return seasons.indexOf(v.season) >= 0; }).length;
  }
  return n > 1 ? x.size * n : 0;
}

function sortPacks(list){
  return list.sort(function(a, b){
    var ca = a.cached ? 1 : 0, cb = b.cached ? 1 : 0;
    if(ca !== cb) return cb - ca;
    var la = langScore(a), lb = langScore(b);
    if(la !== lb) return lb - la;
    var qa = Q_RANK[a.quality] || 0, qb = Q_RANK[b.quality] || 0;
    if(qa !== qb) return qb - qa;
    return (b.seeders || 0) - (a.seeders || 0);
  });
}

function openPacks(mode, force){
  s.level = "packs"; s.packMode = mode; s.focusMem.packs = 0; setHint();
  s.packs = null; s.packsHidden = []; s.packsErr = ""; s.packsLoading = true; s.showHidden = false;
  renderPacks();
  var id = ++s.reqId;
  var season = mode === "series" ? (s.season > 0 ? s.season : 1) : s.season;
  var eps = airedEpisodes(function(v){ return v.season === season; }).sort(function(a, b){ return a.episode - b.episode; }).slice(0, 2);
  if(!eps.length) eps = [{ season: season, episode: 1 }];
  Promise.all(eps.map(function(v){
    return fetchStreams("series", s.item.id + ":" + v.season + ":" + v.episode, !!force).catch(function(){ return null; });
  })).then(function(results){
    if(id !== s.reqId) return;
    s.packsLoading = false;
    var ok = results.filter(Boolean);
    if(!ok.length){ s.packsErr = t("search.err.addon", { msg: "" }); renderPacks(); return; }
    var seen = {}, vis = [], hid = [];
    var hide = App.caps && App.caps.hideUnsupported ? App.caps.hideUnsupported() : false;
    ok.forEach(function(r){
      r.visible.concat(r.hidden).forEach(function(x){
        if(!x.pack) return;
        if(mode === "series" ? x.pack.kind !== "series" : !packCovers(x, season)) return;
        var k = x.hash || x.torrentName || x.release;
        if(seen[k]) return;
        seen[k] = true;
        (hide && x.compatible === false ? hid : vis).push(x);
      });
    });
    s.packs = sortPacks(vis); s.packsHidden = sortPacks(hid);
    if(App.current() === "search" && s.level === "packs") renderPacks();
  });
}

function renderPacks(){
  s.level = "packs"; setHint();
  var meta = s.meta || {};
  var bg = meta.background || s.item.background;
  var h = '<div class="srch-w">' + backdropHtml(bg) + '<div class="srch-scroll srch-dscroll">' + headHtml(packTitle(), t("search.pack.sizeNote"));
  s.rendered = [];
  if(s.packsLoading) h += '<div class="srch-state"><div class="spinner"></div><p>' + App.esc(t("search.pack.loading")) + '</p></div>';
  else if(s.packsErr) h += stateBlock("err", t("search.err.addonTitle"), App.esc(s.packsErr));
  else if(s.packs && !s.packs.length && !s.packsHidden.length) h += stateBlock("", t("search.pack.none"), App.esc(t("search.pack.noneText")));
  else if(s.packs){
    var nC = s.packs.filter(function(x){ return x.cached; }).length;
    h += '<div class="srch-sec">' + App.esc(t("search.pack.list")) + ' <span>' + s.packs.length +
         (nC ? " · " + App.esc(t("search.instantCount", { n: nC })) : "") + '</span></div><div class="srch-list">';
    s.packs.forEach(function(x){ h += streamRow(x, s.rendered.length, false, packEstimate(x)); s.rendered.push(x); });
    if(s.packsHidden.length){
      if(s.showHidden){
        s.packsHidden.forEach(function(x){ h += streamRow(x, s.rendered.length, true, packEstimate(x)); s.rendered.push(x); });
      } else {
        h += hiddenRowHtml(s.packsHidden.length);
      }
    }
    h += '</div>';
  }
  h += '</div></div>';
  s.el.innerHTML = h;
  mountGrid(onStreamSelect, s.focusMem.packs);
}

function addPack(x){
  if(!x.hash){ App.ui.toast(t("search.noHash")); return; }
  App.torbox.addMagnet(magnetOf(x), x.torrentName || x.release).then(function(){
    App.torbox.invalidate();
    if(!x.cached) trackDownload(x, packTitle());
    App.ui.toast(t(x.cached ? "search.pack.addedCached" : "search.pack.added"), 5000);
    refreshTorbox();
  }).catch(function(e){ App.ui.toast(t("search.addFailed", { msg: e.message }), 4500); });
}

function onPackSelect(x){
  var st = statusOf(x);
  if(st && st.kind === "library"){ App.ui.toast(t("search.pack.inLibrary"), 3500); return; }
  if(st && st.kind === "downloading"){ App.ui.toast(t("search.pack.downloading", { pct: st.pct }), 3500); return; }
  if(x.cached){ addPack(x); return; }
  confirmPack(x, false).then(function(v){ if(v === "dl") addPack(x); });
}

/* ======================= Elemento enfocado / lista completa ======================= */

/* Elemento enfocado sobre el que tiene sentido "mejor fuente": película en raíz o episodio en detalle */
function bestTarget(){
  var el = s.grid && s.grid.current();
  if(!el) return null;
  if(s.level === "root"){
    var m = itemFromEl(el);
    return m && m.type === "movie" ? { kind: "movie", el: el, item: m } : null;
  }
  if(s.level === "detail"){
    var v = epFromEl(el);
    return v ? { kind: "ep", el: el, ep: v } : null;
  }
  return null;
}

function openTarget(tg, autoPlay){
  remember();
  if(tg.kind === "movie") openItem(tg.item, { autoPlay: autoPlay });
  else { s.ep = tg.ep; openStreams({ autoPlay: autoPlay }); }
}

/* ======================= Navegación ======================= */

function leaveOpen(){
  s.openMode = false; s.openLevel = null;
  s.level = "root"; s.item = null; s.meta = null; s.ep = null;
  return false;   // main.js hace App.back()
}

function goBack(){
  if(s.openMode && s.level === s.openLevel){ s.reqId++; return leaveOpen(); }
  if(s.level === "packs"){ s.reqId++; renderDetail(); return true; }
  if(s.level === "streams"){
    s.reqId++;
    if(s.item && s.item.type === "series" && s.meta){ renderDetail(); }
    else renderRoot();
    return true;
  }
  if(s.level === "detail"){ s.reqId++; renderRoot(); return true; }
  return false;
}

function newSearch(){
  s.openMode = false; s.openLevel = null;
  if(s.level !== "root"){ s.reqId++; renderRoot(); }
  openKeyboard();
}

function toggleFollow(m){
  if(!App.follow) return;
  var on = App.follow.toggle({ imdbId: m.id, name: m.name, poster: m.poster });
  App.ui.toast(t(on ? "search.follow.added" : "search.follow.removed", { name: m.name || "" }), 3500);
  return on;
}
function followLabel(id){ return t(App.follow && App.follow.isFollowing(id) ? "search.act.unfollow" : "search.act.follow"); }
function curSeries(){
  if(!s.item || s.item.type !== "series") return null;
  var meta = s.meta || {};
  return { id: s.item.id, name: meta.name || s.item.name, poster: meta.poster || s.item.poster };
}

/* A1: acciones del menú contextual (OK mantenido). Incluye todo lo que hay en teclas de color/INFO. */
function actions(){
  var a = [];
  var el = s.grid && s.grid.current();
  var hasAddon = !!addonBase();
  if(s.level === "root"){
    var m = itemFromEl(el);
    if(m){
      if(m.type === "movie"){
        if(hasAddon) a.push({ label: t("search.act.bestSource"), run: function(){ remember(); openItem(m, { autoPlay: true }); } });
        a.push({ label: t("search.act.allSources"), run: function(){ remember(); openItem(m, { autoPlay: false }); } });
      } else {
        a.push({ label: t("search.act.open"), run: function(){ remember(); openItem(m, {}); } });
        if(App.follow) a.push({ label: followLabel(m.id), run: function(){ toggleFollow(m); } });
      }
    }
    if(recent().length) a.push({ label: t("search.act.clearRecent"), run: function(){ App.store.set(RECENT_KEY, []); renderRoot(); } });
  } else if(s.level === "detail"){
    var v = epFromEl(el);
    if(v){
      if(hasAddon) a.push({ label: t("search.act.bestSource"), run: function(){ remember(); s.ep = v; openStreams({ autoPlay: true }); } });
      a.push({ label: t("search.act.allSources"), run: function(){ remember(); s.ep = v; openStreams({ autoPlay: false }); } });
    }
    if(hasAddon){
      if(s.season !== 0 && s.season !== null) a.push({ label: t("search.pack.fullSeason", { n: s.season }), run: function(){ remember(); openPacks("season"); } });
      a.push({ label: t("search.pack.series"), run: function(){ remember(); openPacks("series"); } });
    }
    var sr = curSeries();
    if(sr && App.follow) a.push({ label: followLabel(sr.id), run: function(){ toggleFollow(sr); renderDetail(); } });
    var si = s.seasons.indexOf(s.season);
    if(si > 0) a.push({ label: t("search.act.prevSeason"), run: function(){ changeSeason(-1); } });
    if(si >= 0 && si < s.seasons.length - 1) a.push({ label: t("search.act.nextSeason"), run: function(){ changeSeason(1); } });
  } else if(s.level === "streams" || s.level === "packs"){
    var isPacks = s.level === "packs";
    var act = el ? el.getAttribute("data-act") : "";
    var x = act === "stream" ? s.rendered[Number(el.getAttribute("data-i"))] : null;
    if(x){
      a.push({ label: t(isPacks ? "search.act.addPack" : "search.act.playAdd"), run: function(){ onStreamSelect(0, el); } });
      if(!isPacks && x.hash) a.push({ label: t("search.act.addTorbox"), run: function(){ guardPack(x, function(){ addToTorbox(x); }); } });
    }
    if(act === "showhidden") a.push({ label: t("search.act.showHidden"), run: function(){ onStreamSelect(0, el); } });
    a.push({ label: t("search.act.reload"), run: function(){ if(isPacks) openPacks(s.packMode, true); else openStreams({ autoPlay: false, force: true }); } });
    var sr2 = curSeries();
    if(sr2 && App.follow) a.push({ label: followLabel(sr2.id), run: function(){ toggleFollow(sr2); } });
  }
  a.push({ label: t("search.act.newSearch"), run: newSearch });
  return a;
}

function rerender(){
  if(s.level === "detail" && s.meta) renderDetail();
  else if(s.level === "streams" && s.item) renderStreams();
  else if(s.level === "packs" && s.item && s.meta) renderPacks();
  else renderRoot();
}

/* ======================= Ajustes: add-ons ======================= */

function removeAddon(base){
  var arr = App.settings.get("stremioAddons");
  arr = Array.isArray(arr) ? arr.filter(function(u){ return normAddon(u) !== base; }) : [];
  if(normAddon(App.settings.get("stremioAddon")) === base) App.settings.set("stremioAddon", "");
  App.settings.set("stremioAddons", arr);
  App.ui.toast(t("search.addons.removed", { name: addonName(base) }), 3000);
}
function showAddonHelp(){
  var url = App.remote && App.remote.url ? App.remote.url() : "";
  App.ui.modal({
    title: t("search.addons.helpTitle"),
    html: '<p>' + App.esc(t("search.addons.help")) + (url ? ' <b>' + App.esc(url) + '</b>' : '') + '</p>' +
          '<p>' + App.esc(t("search.addons.suggest")) + '</p>' +
          '<p>Torrentio — torrentio.strem.fun/configure<br>Comet — comet.elfhosted.com/configure<br>MediaFusion — mediafusion.elfhosted.com/configure</p>',
    buttons: [{ label: t("ui.close"), value: true }]
  });
}
/* Añadir un add-on pegando/escribiendo la URL de su manifest (Ctrl+V funciona en el teclado) */
function addAddon(){
  App.ui.keyboard.open({
    title: t("search.addons.addTitle"), placeholder: "https://…/manifest.json",
    onDone: function(v){
      var base = normAddon(v);
      if(!/^https?:\/\/[^\s\/]+\.[^\s]+/i.test(base)){ App.ui.toast(t("search.addons.invalid"), 4000); return; }
      if(addonBases().indexOf(base) >= 0){ App.ui.toast(t("search.addons.exists"), 3000); return; }
      App.ui.toast(t("search.addons.checking"), 2000);
      // Comprobar que responde como add-on de Stremio con recurso "stream"
      withTimeout(App.net.fetch(base + "/manifest.json").then(function(r){
        if(!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }), 15000, "timeout").then(function(m){
        var res = (m && m.resources) || [];
        var hasStream = res.some(function(x){ return x === "stream" || (x && x.name === "stream"); });
        if(!hasStream) throw new Error(t("search.addons.noStreams"));
        var arr = App.settings.get("stremioAddons");
        arr = Array.isArray(arr) ? arr.slice() : [];
        arr.push(base + "/manifest.json");
        App.settings.set("stremioAddons", arr);
        App.ui.toast(t("search.addons.added", { name: (m && m.name) || addonName(base) }), 4000);
      }).catch(function(e){
        App.ui.toast(t("search.addons.addFailed", { msg: e.message }), 6000);
      });
    }
  });
}
function manageAddons(){
  var list = addonBases();
  var items = [{ label: "＋ " + t("search.addons.add"), value: "__add" }].concat(
    list.map(function(b){ return { label: addonName(b) + " · " + addonHost(b), value: b }; }));
  items.push({ label: t("search.addons.helpItem"), value: "__help" });
  App.ui.menu(t(list.length ? "search.addons.menuTitle" : "search.addons.none"), items).then(function(v){
    if(!v) return;
    if(v === "__add"){ addAddon(); return; }
    if(v === "__help"){ showAddonHelp(); return; }
    App.ui.confirm(t("search.addons.removeTitle", { name: addonName(v) }), t("search.addons.removeText"), t("search.addons.remove"), t("ui.cancel"))
      .then(function(ok){ if(ok) removeAddon(v); });
  });
}
if(App.settingsUI){
  App.settingsUI.add("settings.group.search", { id: "stremioAddonsList", type: "action",
    label: function(){ return t("search.addons.label") + " (" + addonBases().length + ")"; },
    desc: function(){ return t("search.addons.desc"); },
    run: manageAddons });
}

App.screens.register({
  id: "search", label: App.t("nav.search"), nav: true, order: 40,
  get hint(){ return hintFor(s.level); },
  mount: function(el){
    s.el = el;
    App.bus.on("settings:change", function(ev){
      if(ev && ev.key && ev.key !== "stremioAddon" && ev.key !== "stremioAddons" && ev.key !== "hideUnsupported") return;
      if(App.current() === "search" && s.el) rerender();
    });
  },
  show: function(params){
    params = params || {};
    if(params.open && !params._back){
      var o = params.open;
      s.openMode = true;
      s.openLevel = o.type === "series" && o.episode === undefined ? "detail" : "streams";
      s.focusMem.detail = 0; s.focusMem.streams = 0;
      var m = { id: o.id, type: o.type === "series" ? "series" : "movie", name: o.name || "", poster: o.poster || "",
                background: o.background || "", year: o.year || "" };
      var auto = m.type === "movie" ? !!App.settings.get("autoPlayBest") : false;
      openItem(m, { autoPlay: auto, season: o.season, episode: o.episode });
      return;
    }
    if(params.q && !params._back){
      s.level = "root"; s.item = null; s.meta = null; s.ep = null;
      doSearch(String(params.q));
      return;
    }
    rerender();
  },
  hide: function(){ remember(); stopPolling(); clearTimeout(pv.timer); },
  focus: function(){
    if(s.playing){ s.playing = false; }
    setTimeout(syncPolling, 300);
    if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); }
  },
  blur: function(){ if(s.grid) s.grid.blur(); },
  actions: actions,
  onKey: function(k, e){
    if(k === K.YELLOW){ newSearch(); return true; }
    if(App.isBack(k)) return goBack();

    // INFO / VERDE → lista completa de fuentes; OK → mejor fuente (si autoPlayBest) vía onSelect
    if(s.level === "root" || s.level === "detail"){
      var tg = bestTarget();
      if(tg && (k === K.INFO || k === K.GREEN)){ openTarget(tg, false); return true; }
    }
    if(s.level === "detail" && (k === K.CHUP || k === K.CHDOWN)){ changeSeason(k === K.CHUP ? 1 : -1); return true; }
    if(s.level === "packs" && k === K.GREEN){
      var pc = s.grid && s.grid.current();
      var px = pc && pc.getAttribute("data-act") === "stream" ? s.rendered[Number(pc.getAttribute("data-i"))] : null;
      if(px) onPackSelect(px);
      return true;
    }
    if(s.level === "packs" && k === K.RED){ openPacks(s.packMode, true); return true; }
    if(s.level === "streams" && k === K.GREEN){
      var cur = s.grid && s.grid.current();
      var x = cur && cur.getAttribute("data-act") === "stream" ? s.rendered[Number(cur.getAttribute("data-i"))] : null;
      if(x) guardPack(x, function(){ addToTorbox(x); });
      return true;
    }
    if(s.level === "streams" && k === K.RED){ openStreams({ autoPlay: false, force: true }); return true; }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
