/* screens/search.js — buscar como Stremio: catálogo Cinemeta + add-on de Stremio del usuario.
 * TorBox cerró su Search API; ahora:
 *   1) Cinemeta (sin clave) da títulos con su id de IMDb.
 *   2) El add-on configurado (Torrentio, Comet, AIOStreams…) devuelve las fuentes.
 *   3) Fuente con url → se reproduce; solo infoHash → se añade a TorBox.
 */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var CINEMETA = "https://v3-cinemeta.strem.io";
var RECENT_KEY = "recentSearches";
var ADDON_TIMEOUT = 20000;

/* ======================= Utilidades ======================= */

function addonBase(){
  var u = String(App.settings.get("stremioAddon") || "").trim();
  if(!u) return "";
  u = u.replace(/^stremio:\/\//i, "https://");
  u = u.replace(/\/manifest\.json(\?.*)?$/i, "");
  return u.replace(/\/+$/, "");
}

function withTimeout(p, ms, msg){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error(msg || "Tiempo de espera agotado")); }, ms);
    p.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
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
function epLabel(season, episode){ return "T" + season + "·E" + pad2(episode); }

/* ---- Normalización de fuentes ---- */
var Q_RANK = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1 };

function parseSize(txt){
  var m = String(txt || "").match(/(?:💾\s*)?(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if(!m) return 0;
  var n = parseFloat(m[1].replace(",", "."));
  var mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[2].toUpperCase()];
  return Math.round(n * mult);
}
function parseQuality(txt){
  var t = String(txt || "");
  var res = "";
  if(/\b(2160p|4k|uhd)\b/i.test(t)) res = "4K";
  else if(/\b1080p\b/i.test(t)) res = "1080p";
  else if(/\b720p\b/i.test(t)) res = "720p";
  else if(/\b(480p|576p|sd)\b/i.test(t)) res = "480p";
  var tags = [];
  if(/\b(dolby.?vision|dovi|\bdv\b)/i.test(t)) tags.push("DV");
  else if(/\bhdr(10\+?)?\b/i.test(t)) tags.push("HDR");
  if(/\b(hevc|x\.?265|h\.?265)\b/i.test(t)) tags.push("HEVC");
  return { res: res, tags: tags };
}
function isCachedMark(name, title){
  var s = String(name || "") + " " + String(title || "");
  // Torrentio: "[TB+]" (el + indica caché), "[TB download]" no. Comet/AIOStreams: ⚡, "cached", "Instant".
  if(/\[[A-Z]{2,4}\+\]/.test(s)) return true;
  if(/⚡/.test(s)) return true;
  if(/\b(cached|instant)\b/i.test(s) && !/\buncached\b/i.test(s)) return true;
  return false;
}

function normStream(st, idx){
  var name = String(st.name || "");
  var title = String(st.title || st.description || "");
  var bh = st.behaviorHints || {};
  var lines = title.split("\n").map(function(l){ return l.trim(); }).filter(Boolean);
  var filename = bh.filename || "";
  var release = filename || lines[0] || name.replace(/\n/g, " ") || "(sin nombre)";
  var all = name + "\n" + title + "\n" + filename;
  var q = parseQuality(all);
  var seedM = title.match(/👤\s*(\d+)/);
  var provM = title.match(/⚙️\s*([^\n]+)/);
  var size = Number(bh.videoSize) || parseSize(title);
  var hash = st.infoHash ? String(st.infoHash).toLowerCase() : "";
  return {
    i: idx,
    name: name.replace(/\n/g, " · "),
    release: release,
    sub: lines.length > 1 && lines[1] !== release ? lines[1] : (filename && lines[0] !== filename ? lines[0] : ""),
    url: st.url && /^https?:/i.test(st.url) ? st.url : "",
    hash: hash,
    fileIdx: st.fileIdx,
    quality: q.res, tags: q.tags,
    size: size,
    seeders: seedM ? Number(seedM[1]) : null,
    provider: provM ? provM[1].trim() : "",
    cached: isCachedMark(name, title),
    // Torrentio/Comet con debrid y SIN caché: "[TB download]", "[TB⏳]"… → el enlace solo
    // manda a descargar y sirve un vídeo de aviso ("Torrent is being downloaded to debrid…")
    uncachedDebrid: !isCachedMark(name, title) && /\[[A-Z]{2,4}(\s*download|\s*⏳|\s*⏳)?\]/i.test(name) && !!st.url,
    filename: filename
  };
}

function sortStreams(list){
  return list.sort(function(a, b){
    var pa = a.cached ? 2 : (a.url && !a.uncachedDebrid ? 1 : 0);
    var pb = b.cached ? 2 : (b.url && !b.uncachedDebrid ? 1 : 0);
    if(pa !== pb) return pb - pa;
    var qa = Q_RANK[a.quality] || 0, qb = Q_RANK[b.quality] || 0;
    if(qa !== qb) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  });
}

/* ======================= Estado ======================= */

var s = {
  el: null, grid: null,
  level: "root",               // root | detail | streams
  q: "", reqId: 0,
  results: null,               // {movies:[], series:[]} | null
  loading: false, error: "",
  item: null,                  // meta resumida del catálogo
  meta: null,                  // meta completa (serie)
  season: null, seasons: [],
  ep: null,                    // {season, episode, name}
  streams: null, streamsErr: "", streamsLoading: false,
  focusMem: {},                // índice de foco por nivel
  playing: false
};

var HINTS = {
  root: "OK buscar · AMARILLO teclado · ▲▼◄► moverse",
  detail: "◄► temporada · OK fuentes del episodio · Atrás volver",
  streams: "OK reproducir/añadir · VERDE añadir a TorBox · Atrás volver"
};
function setHint(){ App.setHintDefault(HINTS[s.level] || ""); }

/* ======================= Render común ======================= */

function posterCard(m, i){
  var title = m.name || "?";
  var year = m.year || m.releaseInfo || "";
  var rating = m.imdbRating ? "★ " + m.imdbRating : "";
  return '<div class="lib-card lib-card-sm focusable" data-act="item" data-type="' + App.esc(m.type) + '" data-i="' + i + '">' +
      '<div class="lib-poster' + (m.poster ? " has-img" : "") + '" style="' + App.ui.placeholderStyle(title) + '">' +
        '<div class="lib-initials">' + App.esc(App.ui.initials(title)) + '</div>' +
        (m.poster ? '<img class="lib-img" src="' + App.esc(m.poster) + '" alt="" onerror="this.parentNode.classList.remove(\'has-img\')">' : '') +
        (rating ? '<div class="lib-rating">' + App.esc(rating) + '</div>' : '') +
        (m.type === "series" ? '<div class="lib-badge">SERIE</div>' : '') +
      '</div>' +
      '<div class="lib-card-title">' + App.esc(title) + '</div>' +
      '<div class="lib-card-sub">' + App.esc(year) + '</div>' +
    '</div>';
}

function stateBlock(cls, title, text){
  return '<div class="srch-state' + (cls ? " " + cls : "") + '"><h2>' + App.esc(title) + '</h2>' +
         (text ? '<p>' + text + '</p>' : '') + '</div>';
}

function noAddonHtml(){
  var url = App.remote && App.remote.url ? App.remote.url() : "";
  return stateBlock("", "Configura tu add-on de Stremio",
    "Para ver fuentes necesitas un add-on de Stremio (Torrentio, Comet, AIOStreams…) configurado con tu API key de TorBox. " +
    "Copia la URL de su <b>manifest.json</b> y pégala en la web del móvil" +
    (url ? ': <b>' + App.esc(url) + '</b>' : "") + " o en Ajustes.");
}

function mountGrid(onSelect, startIndex){
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect });
  var idx = startIndex || 0;
  if(idx >= s.grid.items.length) idx = 0;
  s.grid.focus(idx, true);
  if(document.body.classList.contains("zone-header")) s.grid.blur();
}

function remember(){ if(s.grid) s.focusMem[s.level] = s.grid.index; }

/* ======================= Nivel raíz ======================= */

function renderRoot(){
  s.level = "root"; setHint();
  var h = '<div class="scroll srch-scroll">';
  h += '<div class="srch-top"><div class="srch-box focusable" data-act="kb"><span class="srch-icon">⌕</span>' +
       '<span class="' + (s.q ? "" : "muted") + '">' + App.esc(s.q || "Buscar películas, series…") + '</span></div></div>';

  if(s.loading){
    h += '<div class="srch-state"><div class="spinner"></div><p>Buscando “' + App.esc(s.q) + '”…</p></div>';
  } else if(s.error){
    h += stateBlock("err", "No se pudo buscar", App.esc(s.error));
  } else if(s.results){
    var mv = s.results.movies, sr = s.results.series;
    if(!mv.length && !sr.length){
      h += stateBlock("", "Sin resultados", "No hay títulos para “" + App.esc(s.q) + "”. Prueba con el título original en inglés.");
    } else {
      if(mv.length){
        h += '<div class="section-title">Películas <span class="muted">' + mv.length + '</span></div><div class="hscroll srch-hrow">';
        mv.forEach(function(m, i){ h += posterCard(m, i); });
        h += '</div>';
      }
      if(sr.length){
        h += '<div class="section-title">Series <span class="muted">' + sr.length + '</span></div><div class="hscroll srch-hrow">';
        sr.forEach(function(m, i){ h += posterCard(m, i); });
        h += '</div>';
      }
      if(!addonBase()) h += '<p class="srch-note">Sin add-on de Stremio configurado: podrás ver las fichas, pero no las fuentes.</p>';
    }
  } else {
    var rc = recent();
    if(rc.length){
      h += '<div class="section-title">Búsquedas recientes</div><div class="chips srch-recent">';
      rc.forEach(function(q, i){ h += '<div class="chip focusable" data-act="recent" data-i="' + i + '">' + App.esc(q) + '</div>'; });
      h += '</div>';
    }
    if(!addonBase()) h += noAddonHtml();
    else h += stateBlock("", "Busca cualquier película o serie", "Las fuentes salen de tu add-on de Stremio y se reproducen con TorBox.");
  }
  h += '</div>';
  s.el.innerHTML = h;
  mountGrid(onRootSelect, s.focusMem.root);
}

function onRootSelect(i, el){
  var act = el.getAttribute("data-act");
  if(act === "kb") return openKeyboard();
  if(act === "recent"){ var q = recent()[Number(el.getAttribute("data-i"))]; if(q) doSearch(q); return; }
  if(act === "item"){
    var list = el.getAttribute("data-type") === "series" ? s.results.series : s.results.movies;
    var m = list[Number(el.getAttribute("data-i"))];
    if(!m) return;
    remember();
    openItem(m);
  }
}

function openKeyboard(){
  if(!App.ui.keyboard){ App.hint("Teclado no disponible"); return; }
  App.ui.keyboard.open({
    title: "Buscar película o serie", value: s.q, placeholder: "Título…",
    onDone: function(v){ v = String(v || "").trim(); if(v) doSearch(v); }
  });
}

function catalog(type, q){
  return getJson(CINEMETA + "/catalog/" + type + "/top/search=" + encodeURIComponent(q) + ".json", 15000, "Cinemeta no responde")
    .then(function(j){
      return (j.metas || []).filter(function(m){ return m && m.id && /^tt\d+/.test(m.id); }).map(function(m){
        return { id: m.id, type: type, name: m.name, poster: m.poster, background: m.background,
                 year: m.releaseInfo || m.year || "", imdbRating: m.imdbRating || "", description: m.description || "" };
      });
    });
}

function doSearch(q){
  s.q = q; s.loading = true; s.error = ""; s.results = null; s.focusMem.root = 0;
  pushRecent(q);
  var id = ++s.reqId;
  renderRoot();
  Promise.all([
    catalog("movie", q).catch(function(e){ return { err: e }; }),
    catalog("series", q).catch(function(e){ return { err: e }; })
  ]).then(function(r){
    if(id !== s.reqId) return;
    s.loading = false;
    if(r[0].err && r[1].err){ s.error = "Cinemeta (el catálogo de Stremio) no responde: " + r[0].err.message; }
    else s.results = { movies: r[0].err ? [] : r[0], series: r[1].err ? [] : r[1] };
    // foco directo al primer resultado
    s.focusMem.root = s.results && (s.results.movies.length || s.results.series.length) ? 1 : 0;
    if(App.current() === "search" && s.level === "root") renderRoot();
  });
}

/* ======================= Detalle de serie ======================= */

function openItem(m){
  s.item = m; s.meta = null; s.ep = null;
  if(m.type === "movie"){ openStreams(); return; }
  s.level = "detail"; s.focusMem.detail = 0; setHint();
  App.ui.loading(s.el, "Cargando episodios de " + m.name + "…");
  var id = ++s.reqId;
  getJson(CINEMETA + "/meta/series/" + encodeURIComponent(m.id) + ".json", 15000, "Cinemeta no responde")
    .then(function(j){
      if(id !== s.reqId) return;
      var meta = j.meta || {};
      var vids = (meta.videos || []).map(function(v){
        return { season: Number(v.season), episode: Number(v.episode || v.number), name: v.name || v.title || "",
                 released: v.released || v.firstAired || "", thumbnail: v.thumbnail || "", overview: v.overview || v.description || "" };
      }).filter(function(v){ return !isNaN(v.season) && !isNaN(v.episode); });
      var seasons = [];
      vids.forEach(function(v){ if(seasons.indexOf(v.season) < 0) seasons.push(v.season); });
      seasons.sort(function(a, b){ return (a === 0 ? 1e6 : a) - (b === 0 ? 1e6 : b); }); // especiales al final
      s.meta = { name: meta.name || m.name, year: meta.releaseInfo || meta.year || m.year, rating: meta.imdbRating || m.imdbRating,
                 description: meta.description || "", poster: meta.poster || m.poster, background: meta.background || m.background,
                 genres: (meta.genres || meta.genre || []).slice(0, 4), videos: vids };
      s.seasons = seasons;
      if(s.season === null || seasons.indexOf(s.season) < 0) s.season = seasons.length ? seasons[0] : null;
      renderDetail();
    })
    .catch(function(e){
      if(id !== s.reqId) return;
      App.ui.error(s.el, "No se pudo cargar la serie", e.message);
      s.grid = null;
    });
}

function heroHtml(meta){
  var line = [];
  if(meta.year) line.push(App.esc(meta.year));
  if(meta.rating) line.push('<span class="lib-star">★ ' + App.esc(meta.rating) + '</span>');
  return '<div class="lib-hero">' +
      '<div class="lib-hero-poster"><div class="lib-poster' + (meta.poster ? " has-img" : "") + '" style="' + App.ui.placeholderStyle(meta.name) + '">' +
        '<div class="lib-initials">' + App.esc(App.ui.initials(meta.name)) + '</div>' +
        (meta.poster ? '<img class="lib-img" src="' + App.esc(meta.poster) + '" alt="">' : '') +
      '</div></div>' +
      '<div class="lib-hero-info"><div class="lib-hero-title">' + App.esc(meta.name) + '</div>' +
        '<div class="lib-hero-line">' + line.join('<span class="lib-dot">·</span>') + '</div>' +
        (meta.genres && meta.genres.length ? '<div class="lib-hero-genres">' + App.esc(meta.genres.join(" · ")) + '</div>' : '') +
        (meta.description ? '<div class="lib-hero-overview">' + App.esc(meta.description) + '</div>' : '') +
      '</div></div>';
}

function renderDetail(){
  s.level = "detail"; setHint();
  var meta = s.meta;
  var h = '<div class="lib-backdrop' + (meta.background ? " on" : "") + '"' +
          (meta.background ? ' style="background-image:url(\'' + App.esc(meta.background) + '\')"' : '') + '></div><div class="lib-shade"></div>';
  h += '<div class="scroll lib-detail-scroll">' + heroHtml(meta);
  if(!s.seasons.length){
    h += stateBlock("", "Sin episodios", "Cinemeta no tiene episodios para esta serie.");
  } else {
    h += '<div class="chips lib-seasons">';
    s.seasons.forEach(function(n){
      h += '<div class="chip focusable' + (n === s.season ? " active" : "") + '" data-act="season" data-s="' + n + '">' +
           (n === 0 ? "Especiales" : "Temporada " + n) + '</div>';
    });
    h += '</div><div class="lib-eps">';
    var now = Date.now();
    meta.videos.filter(function(v){ return v.season === s.season; })
      .sort(function(a, b){ return a.episode - b.episode; })
      .forEach(function(v){
        var future = v.released && Date.parse(v.released) > now;
        h += '<div class="row lib-ep focusable' + (future ? " dim" : "") + '" data-act="ep" data-e="' + v.episode + '">' +
             '<span class="lib-ep-num">E' + pad2(v.episode) + '</span>' +
             '<span class="title">' + App.esc(v.name || ("Episodio " + v.episode)) + '</span>' +
             (future ? '<span class="meta">Próximamente</span>' :
               (v.released ? '<span class="meta num">' + App.esc(String(v.released).slice(0, 10)) + '</span>' : '')) +
             '</div>';
      });
    h += '</div>';
  }
  h += '</div>';
  s.el.innerHTML = h;
  mountGrid(onDetailSelect, s.focusMem.detail);
}

function onDetailSelect(i, el){
  var act = el.getAttribute("data-act");
  if(act === "season"){
    var n = Number(el.getAttribute("data-s"));
    if(n !== s.season){ s.season = n; s.focusMem.detail = i; renderDetail(); }
    return;
  }
  if(act === "ep"){
    var e = Number(el.getAttribute("data-e"));
    var v = s.meta.videos.filter(function(x){ return x.season === s.season && x.episode === e; })[0];
    if(!v) return;
    remember();
    s.ep = v;
    openStreams();
  }
}

function changeSeason(dir){
  var i = s.seasons.indexOf(s.season);
  var n = s.seasons[i + dir];
  if(n === undefined) return;
  s.season = n;
  // foco en el chip de la temporada nueva
  s.focusMem.detail = s.seasons.indexOf(n);
  renderDetail();
}

/* ======================= Fuentes ======================= */

function streamId(){
  if(s.item.type === "series" && s.ep) return s.item.id + ":" + s.ep.season + ":" + s.ep.episode;
  return s.item.id;
}
function titleLine(){
  var name = (s.meta && s.meta.name) || s.item.name;
  if(s.ep) return name + " · " + epLabel(s.ep.season, s.ep.episode) + (s.ep.name ? " · " + s.ep.name : "");
  return name + (s.item.year ? " (" + s.item.year + ")" : "");
}

function openStreams(){
  s.level = "streams"; s.focusMem.streams = 0; setHint();
  s.streams = null; s.streamsErr = "";
  var base = addonBase();
  if(!base){ renderStreams(); return; }
  s.streamsLoading = true;
  renderStreams();
  var id = ++s.reqId;
  var type = s.item.type === "series" ? "series" : "movie";
  getJson(base + "/stream/" + type + "/" + encodeURIComponent(streamId()).replace(/%3A/g, ":") + ".json",
          ADDON_TIMEOUT, "El add-on no responde (20 s)")
    .then(function(j){
      if(id !== s.reqId) return;
      var list = (j.streams || []).map(normStream).filter(function(x){ return x.url || x.hash; });
      // Marcar caché con TorBox para los que solo traen infoHash
      var hashes = list.filter(function(x){ return x.hash && !x.cached; }).map(function(x){ return x.hash; });
      var chk = hashes.length && App.torbox.checkCached ? App.torbox.checkCached(hashes).catch(function(){ return {}; }) : Promise.resolve({});
      return chk.then(function(set){
        if(id !== s.reqId) return;
        list.forEach(function(x){ if(x.hash && set[x.hash]) x.cached = true; });
        s.streams = sortStreams(list);
        s.streamsLoading = false;
        if(App.current() === "search" && s.level === "streams") renderStreams();
      });
    })
    .catch(function(e){
      if(id !== s.reqId) return;
      s.streamsLoading = false;
      s.streamsErr = e.status === 404 ? "El add-on no tiene este título (404). Revisa que la URL del manifest sea correcta." :
                     ("No se pudo consultar el add-on: " + e.message);
      if(App.current() === "search" && s.level === "streams") renderStreams();
    });
}

function streamRow(x, i){
  var badges = "";
  if(x.cached) badges += '<span class="srch-cached">EN CACHÉ</span>';
  else if(x.uncachedDebrid) badges += '<span class="srch-cached srch-dl">⬇ DESCARGAR</span>';
  else if(x.url) badges += '<span class="srch-cached srch-play">▶ DIRECTO</span>';
  if(x.quality) badges += '<span class="badge srch-q">' + App.esc(x.quality) + '</span>';
  x.tags.forEach(function(t){ badges += '<span class="badge srch-q">' + App.esc(t) + '</span>'; });
  var meta = [];
  if(x.seeders !== null) meta.push('<span class="srch-seed">👤 ' + x.seeders + '</span>');
  if(x.provider) meta.push(App.esc(x.provider));
  return '<div class="row srch-row focusable" data-act="stream" data-i="' + i + '">' +
      '<div class="srch-main"><div class="srch-rel">' + App.esc(x.release) + '</div>' +
        '<div class="srch-sub">' + (x.name ? App.esc(x.name) : "") + (meta.length ? '<span class="lib-dot">·</span>' + meta.join(" · ") : "") + '</div></div>' +
      '<div class="srch-badges">' + badges + '</div>' +
      '<div class="meta num srch-size">' + (x.size ? App.fmtSize(x.size) : "") + '</div>' +
    '</div>';
}

function renderStreams(){
  s.level = "streams"; setHint();
  var meta = s.meta || s.item;
  var bg = meta.background || s.item.background;
  var h = '<div class="lib-backdrop' + (bg ? " on" : "") + '"' + (bg ? ' style="background-image:url(\'' + App.esc(bg) + '\')"' : '') + '></div><div class="lib-shade"></div>';
  h += '<div class="scroll lib-detail-scroll">';
  if(s.item.type === "movie") h += heroHtml({ name: s.item.name, year: s.item.year, rating: s.item.imdbRating, poster: s.item.poster,
                                               description: s.item.description, genres: [] });
  else h += '<div class="srch-head"><div class="srch-head-title">' + App.esc(titleLine()) + '</div>' +
            (s.ep && s.ep.overview ? '<p class="srch-head-ov">' + App.esc(s.ep.overview) + '</p>' : '') + '</div>';

  if(!addonBase()) h += noAddonHtml();
  else if(s.streamsLoading) h += '<div class="srch-state"><div class="spinner"></div><p>Buscando fuentes en tu add-on…</p></div>';
  else if(s.streamsErr) h += stateBlock("err", "Error del add-on", App.esc(s.streamsErr));
  else if(s.streams && !s.streams.length) h += stateBlock("", "Sin fuentes", "Sin fuentes para este título en tu add-on.");
  else if(s.streams){
    var nCached = s.streams.filter(function(x){ return x.cached || (x.url && !x.uncachedDebrid); }).length;
    h += '<div class="section-title">Fuentes <span class="muted">' + s.streams.length +
         (nCached ? " · " + nCached + " al instante" : "") + '</span></div><div class="srch-list">';
    s.streams.forEach(function(x, i){ h += streamRow(x, i); });
    h += '</div>';
  }
  h += '</div>';
  s.el.innerHTML = h;
  mountGrid(onStreamSelect, s.focusMem.streams);
}

function magnetOf(x){
  return "magnet:?xt=urn:btih:" + x.hash + (x.filename || x.release ? "&dn=" + encodeURIComponent(x.filename || x.release) : "");
}

function addToTorbox(x){
  if(!x.hash){ App.ui.toast("Esta fuente no tiene hash: no se puede añadir a TorBox"); return Promise.resolve(); }
  return App.torbox.addMagnet(magnetOf(x), x.filename || undefined).then(function(){
    App.torbox.invalidate();
    App.ui.toast(x.cached ? "Ya está en caché: aparecerá en tu Biblioteca en segundos" :
                            "Añadido. Lo verás en Descargas / Biblioteca cuando termine", 4500);
  }).catch(function(e){ App.ui.toast("No se pudo añadir: " + e.message, 4500); });
}

function playStream(x){
  var name = (s.meta && s.meta.name) || s.item.name;
  var sub = s.ep ? epLabel(s.ep.season, s.ep.episode) + (s.ep.name ? " · " + s.ep.name : "") : (s.item.year || "");
  if(x.quality) sub += (sub ? " · " : "") + x.quality;
  s.playing = true;
  App.player.play({
    title: name, subtitle: sub, url: x.url,
    key: "stremio:" + streamId() + ":" + (x.hash ? x.hash + ":" + (x.fileIdx === undefined ? "" : x.fileIdx) : x.i),
    poster: (s.meta && s.meta.poster) || s.item.poster,
    meta: { type: s.item.type, imdbId: s.item.id, season: s.ep ? s.ep.season : undefined,
            episode: s.ep ? s.ep.episode : undefined, title: name, source: "stremio" }
  });
}

/* Fuente sin caché vía debrid: pedir al add-on que la mande a TorBox (o añadir el magnet) */
function sendToDebrid(x){
  var p;
  if(x.hash) p = App.torbox.addMagnet(magnetOf(x), x.filename || undefined);
  else p = App.net.fetch(x.url, { method: "GET" }).then(function(r){
    // Solo interesa que el add-on reciba la petición; no descargamos el vídeo de aviso
    try{ if(r.body && r.body.cancel) r.body.cancel(); }catch(e){}
    return r;
  });
  return p.then(function(){
    App.torbox.invalidate();
    console.info("[buscar] enviado a descargar en TorBox:", x.release);
    App.ui.toast("Descargando en TorBox. Míralo en Descargas; cuando termine saldrá en tu Biblioteca", 5000);
  }).catch(function(e){
    console.warn("[buscar] error al mandar a descargar:", e.message);
    App.ui.toast("No se pudo mandar a descargar: " + e.message, 4500);
  });
}

function onStreamSelect(i, el){
  var x = s.streams && s.streams[Number(el.getAttribute("data-i"))];
  if(!x) return;
  remember();
  if(x.uncachedDebrid){
    App.ui.menu("No está en caché en TorBox", [
      { label: "Mandar a descargar a TorBox", value: "dl" },
      { label: "Reproducir igualmente (verás un aviso)", value: "play" },
      { label: "Cancelar", value: null }
    ]).then(function(v){
      if(v === "dl") sendToDebrid(x);
      else if(v === "play") playStream(x);
    });
    return;
  }
  if(x.url){
    if(!App.player){ App.hint("Reproductor no disponible"); return; }
    playStream(x);
    return;
  }
  App.ui.confirm("¿Añadir a TorBox?", x.release + (x.cached ? " · ya está en caché" : ""), "Añadir", "Cancelar")
    .then(function(ok){ if(ok) addToTorbox(x); });
}

/* ======================= Navegación ======================= */

function goBack(){
  if(s.level === "streams"){
    s.reqId++;
    if(s.item && s.item.type === "series" && s.meta){ renderDetail(); }
    else renderRoot();
    return true;
  }
  if(s.level === "detail"){ s.reqId++; renderRoot(); return true; }
  return false;
}

function rerender(){
  if(s.level === "detail" && s.meta) renderDetail();
  else if(s.level === "streams") renderStreams();
  else renderRoot();
}

App.screens.register({
  id: "search", label: "Buscar", nav: true, order: 40,
  hint: HINTS.root,
  mount: function(el){
    s.el = el;
    App.bus.on("settings:change", function(ev){
      if(ev && ev.key && ev.key !== "stremioAddon") return;
      if(App.current() === "search" && s.el) rerender();
    });
  },
  show: function(params){
    params = params || {};
    if(params.q && !params._back){
      s.level = "root"; s.item = null; s.meta = null; s.ep = null;
      doSearch(String(params.q));
      return;
    }
    rerender();
  },
  hide: function(){ remember(); },
  focus: function(){
    if(s.playing){ s.playing = false; }
    if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); }
  },
  blur: function(){ if(s.grid) s.grid.blur(); },
  onKey: function(k){
    if(k === K.YELLOW){ if(s.level !== "root"){ s.reqId++; renderRoot(); } openKeyboard(); return true; }
    if(App.isBack(k)) return goBack();
    if(s.level === "detail" && (k === K.CHUP || k === K.CHDOWN)){ changeSeason(k === K.CHUP ? 1 : -1); return true; }
    if(s.level === "streams" && k === K.GREEN){
      var cur = s.grid && s.grid.current();
      var x = cur && s.streams ? s.streams[Number(cur.getAttribute("data-i"))] : null;
      if(x) addToTorbox(x);
      return true;
    }
    if(s.level === "streams" && k === K.RED){ openStreams(); return true; }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
