/* parse.js — interpreta nombres de release: título, año, temporada/episodio, calidad. */
(function(){
"use strict";

var App = window.App = window.App || {};
var P = App.parse = App.parse || {};

/* Tokens que marcan el final del título (calidad, códec, idioma, origen…) */
var JUNK = [
  "2160p","1080p","1080i","720p","576p","480p","4k","uhd","hdr","hdr10","hdr10plus","dv","dovi","sdr",
  "x264","x265","h264","h265","hevc","avc","av1","xvid","divx","10bit","8bit",
  "web-dl","webdl","web","webrip","web-rip","bluray","blu-ray","bdrip","brrip","bdremux","remux","dvdrip",
  "dvd","dvdr","hdtv","hdrip","microhd","proper","repack","internal","limited","extended","unrated",
  "spanish","castellano","español","espanol","esp","spa","latino","lat","dual","multi","vose","vos",
  "subs","subtitulado","subtitulos","english","eng","ita","fre","french","aac","aac2","ac3","eac3",
  "dts","dts-hd","truehd","atmos","ddp","ddp5","dd5","5.1","7.1","2.0","mkv","mp4","avi","nf","amzn",
  "dsnp","hmax","atvp","hulu","imax","complete","completa","completo","serie","series","pack"
];
var JUNK_SET = {};
JUNK.forEach(function(j){ JUNK_SET[j] = true; });

function stripAccents(s){
  try{ return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }catch(e){ return s; }
}

function baseOf(str){
  var s = String(str || "");
  s = s.replace(/\\/g, "/");
  var parts = s.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function preclean(str){
  var s = baseOf(str);
  s = s.replace(/\.(mkv|mp4|avi|m4v|mov|ts|m2ts|webm|wmv|mpg|mpeg|srt|vtt|ass|ssa|sub|nfo|txt|rar|zip)$/i, "");
  s = s.replace(/\bwww\.[a-z0-9\-]+\.[a-z]{2,6}\b/ig, " ");       // www.dominio.com
  s = s.replace(/\b[a-z0-9\-]+\.(com|net|org|to|tv|me|cc|io)\b/ig, " ");
  s = s.replace(/^\s*(\[[^\]]*\]\s*)+/, " ");                    // [grupo] inicial
  s = s.replace(/[\[\]{}]/g, " ");                                 // resto de corchetes
  s = s.replace(/【[^】]*】/g, " ");
  // puntos y guiones bajos → espacios (pero conserva 5.1 / 7.1 / 2.0)
  s = s.replace(/(\d)\.(\d)(?!\d)/g, "$1·$2");
  s = s.replace(/[._]+/g, " ").replace(/·/g, ".");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function detectQuality(s){
  var m = /\b(2160p|4k|uhd)\b/i.exec(s);
  if(m) return "4K";
  m = /\b(1080p|1080i|720p|576p|480p)\b/i.exec(s);
  if(m) return m[1].toLowerCase().replace("i", "p");
  if(/\bmicrohd\b/i.test(s)) return "1080p";
  if(/\b(dvdrip|dvd)\b/i.test(s)) return "DVD";
  return "";
}

/* Patrones de episodio, por orden de fiabilidad. Cada uno devuelve {index, season, episode} */
var EP_PATTERNS = [
  function(s){ var m = /\bS(\d{1,2})\s?-?\s?E(\d{1,3})(?:\s?-?\s?E?\d{1,3})*\b/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; },
  function(s){ var m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; },
  function(s){ var m = /\bTemporada\s*(\d{1,2})\b.*?\bCap(?:i|í)tulo\s*(\d{1,3})\b/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; },
  function(s){ var m = /\bCap(?:i|í)?(?:tulo)?\s?\.?\s?(\d{1,2})(\d{2})\b(?!\s?-?\s?\d{3,4})/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; },
  function(s){ var m = /\bT(\d{1,2})\s?(?:Cap(?:i|í)?(?:tulo)?|Ep|E)\s?\.?\s?(\d{1,3})\b/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; },
  function(s){ var m = /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/i.exec(s);
    return m && { index: m.index, season: +m[1], episode: +m[2] }; }
];
var SEASON_PATTERNS = [
  /\bS(\d{1,2})(?!\s?E\d)\b/i,
  /\bSeason\s*(\d{1,2})\b/i,
  /\bTemporada\s*(\d{1,2})\b/i,
  /\bTemp\s*(\d{1,2})\b/i,
  /\b(\d{1,2})(?:ª|a)?\s*Temporada\b/i
];
var SERIES_HINTS = /\b(complete series|serie completa|miniserie|miniseries|temporadas?\s*\d+\s*(?:a|-|al)\s*\d+|seasons?\s*\d+\s*-\s*\d+|S\d{1,2}\s*-\s*S\d{1,2})\b/i;

function findEpisode(s){
  for(var i = 0; i < EP_PATTERNS.length; i++){
    var r = EP_PATTERNS[i](s);
    if(r) return r;
  }
  return null;
}
function findSeason(s){
  for(var i = 0; i < SEASON_PATTERNS.length; i++){
    var m = SEASON_PATTERNS[i].exec(s);
    if(m) return { index: m.index, season: +m[1] };
  }
  return null;
}

function cutAtJunk(s){
  var words = s.split(" ");
  for(var i = 0; i < words.length; i++){
    var w = words[i].toLowerCase().replace(/^[\(\-]+|[\)\-,]+$/g, "");
    if(i > 0 && JUNK_SET[w]) return words.slice(0, i).join(" ");
  }
  return s;
}

function tidyTitle(t){
  t = t.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^[\s\-–:|,(]+|[\s\-–:|,(]+$/g, "").trim();
  // mayúsculas/minúsculas raras → Title Case
  if(t && (t === t.toUpperCase() || t === t.toLowerCase()) && /[a-z]/i.test(t)){
    t = t.toLowerCase().replace(/(^|\s)(\S)/g, function(_, a, b){ return a + b.toUpperCase(); });
  }
  return t;
}

/* App.parse.name(str) → {title, year, season, episode, type, quality} */
P.name = function(str){
  var raw = String(str || "");
  var s = preclean(raw);
  var out = { title: "", year: null, season: null, episode: null, type: "movie", quality: detectQuality(s) };
  var cut = s.length;

  var ep = findEpisode(s);
  if(ep){
    out.type = "tv"; out.season = ep.season; out.episode = ep.episode;
    cut = Math.min(cut, ep.index);
    var se0 = findSeason(s);
    if(se0 && se0.index < cut) cut = se0.index;
  } else {
    var se = findSeason(s);
    if(se){ out.type = "tv"; out.season = se.season; cut = Math.min(cut, se.index); }
    var sh = SERIES_HINTS.exec(s);
    if(sh){ out.type = "tv"; cut = Math.min(cut, sh.index); }
  }

  // Año: el último candidato antes del corte que no esté al principio (1917, 2001, Blade Runner 2049 2017…)
  var yre = /\(?\b(19[2-9]\d|20[0-4]\d)\b\)?/g, ym, yearAt = -1;
  var limit = Math.min(cut, cutAtJunk(s).length);
  while((ym = yre.exec(s))){
    if(ym.index === 0) continue;
    if(ym.index > limit && yearAt >= 0) break;
    out.year = +ym[1]; yearAt = ym.index;
    if(ym.index >= limit) break;
  }
  if(yearAt >= 0 && yearAt < cut) cut = yearAt;

  var title = s.slice(0, cut);
  title = cutAtJunk(title);
  title = tidyTitle(title);
  if(!title){
    // nombre que empieza por el año o sin título reconocible
    title = tidyTitle(cutAtJunk(s.replace(/\bS\d{1,2}(E\d{1,3})?\b/i, ""))) || s;
  }
  out.title = title;
  return out;
};

/* Episodio de un archivo dentro de un pack: {season, episode} | null */
P.episodeOfFile = function(fileName, fallbackSeason){
  var full = String(fileName || "").replace(/\\/g, "/");
  var base = preclean(full);
  var ep = findEpisode(base);
  if(ep) return { season: ep.season, episode: ep.episode };

  // Carpeta de temporada en la ruta: "Season 2/03 - Nombre.mkv"
  var folderSeason = null;
  var parts = full.split("/");
  for(var i = parts.length - 2; i >= 0; i--){
    var fs = findSeason(preclean(parts[i]));
    if(fs){ folderSeason = fs.season; break; }
  }
  var season = folderSeason || fallbackSeason || null;

  var m = /\b(?:E|Ep|Episodio|Episode|Cap(?:i|í)tulo|Cap)\s?\.?\s?(\d{1,3})\b/i.exec(base);
  if(m) return { season: season || 1, episode: +m[1] };
  m = /^(\d{1,3})(?:\s|-|$)/.exec(base);                       // "03 - Nombre"
  if(m && +m[1] < 200) return { season: season || 1, episode: +m[1] };
  m = /\s-\s(\d{1,3})\s(?:-|$)/.exec(base);                      // "Serie - 05 - Nombre"
  if(m) return { season: season || 1, episode: +m[1] };
  return null;
};

/* Título normalizado para agrupar y como clave de caché */
P.norm = function(title){
  return stripAccents(String(title || "").toLowerCase())
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|el|la|los|las) /, "")
    .replace(/\s+/g, "")
    .trim();
};

/* Peso de calidad para elegir entre duplicados */
P.qualityRank = function(q){
  return { "4K": 5, "1080p": 4, "720p": 3, "576p": 2, "480p": 1, "DVD": 1 }[q] || 0;
};

})();
