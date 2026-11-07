/* screens/library.js — Biblioteca con carátulas, series agrupadas, detalle de serie/película y archivos. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var esc = App.esc;

/* ====================================================================
 * Modelo: descargas → tarjetas (series agrupadas / películas)
 * ==================================================================== */
var state = {
  filter: null,          // all | torrents | usenet | webdl
  items: [],
  model: null,           // { cards:[], byId:{} }
  loadedAt: 0
};

function parseName(s){ return App.parse ? App.parse.name(s) : { title: s, year: null, season: null, episode: null, type: "movie", quality: "" }; }
function normTitle(t){ return App.parse ? App.parse.norm(t) : String(t).toLowerCase(); }
function qRank(q){ return App.parse ? App.parse.qualityRank(q) : 0; }
function fileName(f){ return f.short_name || String(f.name || "").split("/").pop() || "(archivo)"; }
function itemSize(d){ return d.size || (d.files || []).reduce(function(a, f){ return a + (f.size || 0); }, 0); }
function itemTime(d){ return String(d.created_at || d.updated_at || ""); }
function keyOf(source, itemId, fileId){ return App.torbox.key(source, itemId, fileId); }

function epOfFile(f, item, parsed, nVideos){
  var e = App.parse ? App.parse.episodeOfFile(f.name || f.short_name, parsed.season) : null;
  if(e) return e;
  if(nVideos === 1 && parsed.episode) return { season: parsed.season || 1, episode: parsed.episode };
  return null;
}

function buildModel(items){
  var cards = [], byId = {}, shows = {};

  items.forEach(function(item){
    var files = item.files || [];
    var vids = files.filter(App.isVideo);
    var p = parseName(item.name || (vids[0] ? fileName(vids[0]) : ""));
    var src = item._source;

    // ¿Es serie? por nombre o porque sus archivos tienen pinta de episodios
    var epFiles = [];
    vids.forEach(function(f){
      var e = epOfFile(f, item, p, vids.length);
      if(e) epFiles.push({ f: f, e: e });
    });
    var isShow = p.type === "tv" || (vids.length > 1 && epFiles.length >= Math.max(2, vids.length / 2));

    if(isShow){
      var nk = normTitle(p.title);
      var show = shows[nk];
      if(!show){
        show = shows[nk] = {
          kind: "show", id: "show:" + nk, title: p.title, year: p.year, quality: p.quality,
          seasons: {}, extras: [], items: [], latest: "", meta: null
        };
        cards.push(show); byId[show.id] = show;
      }
      if(!show.year && p.year) show.year = p.year;
      if(qRank(p.quality) > qRank(show.quality)) show.quality = p.quality;
      show.items.push(item);
      if(itemTime(item) > show.latest) show.latest = itemTime(item);

      var withEp = {};
      epFiles.forEach(function(x){
        withEp[x.f.id] = true;
        var s = x.e.season || 1, n = x.e.episode;
        var fq = parseName(fileName(x.f)).quality || p.quality;
        var ep = {
          season: s, episode: n, source: src, itemId: item.id, fileId: x.f.id,
          fileName: fileName(x.f), size: x.f.size || 0, quality: fq, item: item,
          key: keyOf(src, item.id, x.f.id)
        };
        var season = show.seasons[s] = show.seasons[s] || {};
        var prev = season[n];
        if(!prev || qRank(fq) > qRank(prev.quality) || (qRank(fq) === qRank(prev.quality) && ep.size > prev.size)){
          season[n] = ep;
        }
      });
      vids.forEach(function(f){
        if(!withEp[f.id]) show.extras.push({ source: src, itemId: item.id, fileId: f.id, fileName: fileName(f), size: f.size || 0, item: item, key: keyOf(src, item.id, f.id) });
      });
    } else {
      var card = {
        kind: "movie", id: "item:" + src + ":" + item.id, title: p.title, year: p.year,
        quality: p.quality, type: "movie", item: item, videos: vids, latest: itemTime(item), meta: null
      };
      cards.push(card); byId[card.id] = card;
    }
  });

  cards.forEach(function(c){
    if(c.kind === "show"){
      c.seasonNums = Object.keys(c.seasons).map(Number).sort(function(a, b){ return a - b; });
      c.episodes = [];
      c.seasonNums.forEach(function(s){
        Object.keys(c.seasons[s]).map(Number).sort(function(a, b){ return a - b; })
          .forEach(function(n){ c.episodes.push(c.seasons[s][n]); });
      });
    }
  });
  cards.sort(function(a, b){ return b.latest.localeCompare(a.latest); });
  return { cards: cards, byId: byId };
}

/* ====================================================================
 * Carga de datos
 * ==================================================================== */
function fetchItems(filter, fresh){
  var sources = filter === "all" || !filter ? App.torbox.SOURCES : [filter];
  var errors = [];
  return Promise.all(sources.map(function(s){
    return App.torbox.list(s, { fresh: !!fresh }).catch(function(e){ errors.push(e); return []; });
  })).then(function(lists){
    if(errors.length === sources.length) throw errors[0];
    var out = [];
    lists.forEach(function(l){ out = out.concat(l); });
    return out;
  });
}

var tmdbToastShown = false;
function lookupMeta(card){
  if(card.meta || card._metaP) return card._metaP || Promise.resolve(card.meta);
  if(!App.meta){ return Promise.resolve(null); }
  card._metaP = App.meta.lookup({ title: card.title, year: card.year, type: card.kind === "show" ? "tv" : "movie" })
    .then(function(m){ card.meta = m; return m; })
    .catch(function(){ return null; });
  return card._metaP;
}

/* ====================================================================
 * Historial (tolerante a que App.history aún no exista)
 * ==================================================================== */
var H = {
  get: function(k){ return App.history && App.history.get ? App.history.get(k) : null; },
  watched: function(k){ return !!(App.history && App.history.isWatched && App.history.isWatched(k)); },
  progress: function(k){ return App.history && App.history.progress ? (App.history.progress(k) || 0) : 0; },
  list: function(){ return App.history && App.history.list ? (App.history.list({ unfinished: true }) || []) : []; }
};

function toggleWatched(key, info){
  if(!App.history){ App.hint("Historial no disponible"); return; }
  if(H.watched(key)){
    App.history.remove(key);
    App.ui.toast("Marcado como no visto");
  } else {
    if(!App.history.get(key)){
      App.history.save({ key: key, pos: 0, dur: 0, updated: Date.now(), title: info.title, subtitle: info.subtitle || "",
        poster: info.poster || "", watched: true, meta: info.meta || {} });
    }
    App.history.markWatched(key);
    App.ui.toast("Marcado como visto");
  }
}

function showProgress(show){
  if(!show.episodes || !show.episodes.length) return 0;
  var w = 0;
  show.episodes.forEach(function(e){ if(H.watched(e.key)) w++; });
  return w / show.episodes.length;
}

/* Siguiente episodio a ver: el último a medias, o el siguiente al último visto */
function nextUp(show){
  var eps = show.episodes || [];
  if(!eps.length) return null;
  var best = null, bestT = 0, lastWatched = -1;
  eps.forEach(function(e, i){
    var h = H.get(e.key);
    if(h && !h.watched && h.pos > 30 && h.updated > bestT){ best = e; bestT = h.updated; }
    if(H.watched(e.key)) lastWatched = i;
  });
  if(best) return { ep: best, resume: H.get(best.key).pos };
  var nxt = eps[lastWatched + 1] || eps[0];
  return { ep: nxt, resume: 0 };
}

/* ====================================================================
 * Reproducción
 * ==================================================================== */
function withTimeout(p, ms){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error("timeout")); }, ms);
    p.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
  });
}

function subLang(name){
  var n = String(name).toLowerCase();
  if(/(^|[\W_])(spa|esp|es|spanish|espa(n|ñ)ol|castellano|cast)([\W_]|$)/.test(n)) return "spa";
  if(/(^|[\W_])(lat|latino)([\W_]|$)/.test(n)) return "spa";
  if(/(^|[\W_])(eng|en|english|ingles|inglés)([\W_]|$)/.test(n)) return "eng";
  if(/(^|[\W_])(fre|fra|fr|french)([\W_]|$)/.test(n)) return "fre";
  if(/(^|[\W_])(ita|it|italian)([\W_]|$)/.test(n)) return "ita";
  return "";
}
var LANG_LABEL = { spa: "Español", eng: "Inglés", fre: "Francés", ita: "Italiano" };

function subtitlesFor(item, videoFile, source){
  var files = item.files || [];
  var subs = files.filter(App.isSubtitle);
  if(!subs.length) return Promise.resolve([]);
  var vids = files.filter(App.isVideo);
  var vb = App.baseName(videoFile).toLowerCase();
  var vdir = String(videoFile.name || "").split("/").slice(0, -1).join("/");
  var chosen = subs.filter(function(s){
    var sb = App.baseName(s).toLowerCase();
    if(vids.length === 1) return true;
    if(sb.indexOf(vb) === 0 || (sb.length > 6 && vb.indexOf(sb) === 0)) return true;
    // misma carpeta "Subs/<video>/*.srt"
    return String(s.name || "").toLowerCase().indexOf(vb) >= 0 && String(s.name || "").indexOf(vdir) === 0;
  }).slice(0, 8);
  return Promise.all(chosen.map(function(s){
    return withTimeout(App.torbox.link(source, item.id, s.id), 6000).then(function(url){
      var lang = subLang(App.baseName(s).replace(new RegExp("^" + vb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ""));
      var forced = /forced|forzad/i.test(s.name || "");
      var label = (LANG_LABEL[lang] || App.baseName(s).slice(-24)) + (forced ? " (forzados)" : "");
      return { label: label, lang: lang, url: url, forced: forced };
    }).catch(function(){ return null; });
  })).then(function(list){ return list.filter(Boolean); });
}

function findFile(item, fileId){
  var f = null;
  (item.files || []).forEach(function(x){ if(String(x.id) === String(fileId)) f = x; });
  return f;
}

function epLabel(ep, name){
  return "T" + ep.season + "·E" + (ep.episode < 10 ? "0" : "") + ep.episode + (name ? " · " + name : "");
}

/* Construye los opts del reproductor para un episodio */
function episodeOpts(show, ep, startAt){
  var file = findFile(ep.item, ep.fileId) || { id: ep.fileId, name: ep.fileName };
  var tmdbId = show.meta ? show.meta.tmdbId : null;
  var nameP = (show.meta && App.meta) ? App.meta.season(tmdbId, ep.season).then(function(s){
    var name = "";
    if(s) s.episodes.forEach(function(x){ if(x.episode === ep.episode) name = x.name; });
    return name;
  }).catch(function(){ return ""; }) : Promise.resolve("");
  return Promise.all([
    App.torbox.link(ep.source, ep.itemId, ep.fileId),
    subtitlesFor(ep.item, file, ep.source),
    withTimeout(nameP, 3000).catch(function(){ return ""; })
  ]).then(function(r){
    var idx = show.episodes.indexOf(ep);
    var nextEp = idx >= 0 ? show.episodes[idx + 1] : null;
    return {
      title: show.meta ? show.meta.title : show.title,
      subtitle: epLabel(ep, r[2]),
      url: r[0],
      key: ep.key,
      startAt: startAt,
      poster: show.meta ? show.meta.poster : "",
      meta: { source: ep.source, itemId: ep.itemId, fileId: ep.fileId, showTitle: show.meta ? show.meta.title : show.title,
              showId: show.id, season: ep.season, episode: ep.episode, tmdbId: tmdbId, type: "tv", subtitles: r[1] },
      subtitles: r[1],
      next: nextEp ? function(){ return episodeOpts(show, nextEp, 0).catch(function(){ return null; }); } : null
    };
  });
}

function fileOpts(card, source, item, file, startAt){
  return Promise.all([
    App.torbox.link(source, item.id, file.id),
    subtitlesFor(item, file, source)
  ]).then(function(r){
    var m = card && card.meta;
    var multi = card && card.videos && card.videos.length > 1;
    return {
      title: m ? m.title : (card ? card.title : fileName(file)),
      subtitle: multi ? fileName(file) : (m && m.year ? String(m.year) : (card && card.year ? String(card.year) : "")),
      url: r[0],
      key: keyOf(source, item.id, file.id),
      startAt: startAt,
      poster: m ? m.poster : "",
      meta: { source: source, itemId: item.id, fileId: file.id, title: m ? m.title : (card ? card.title : ""),
              cardId: card ? card.id : null, tmdbId: m ? m.tmdbId : null, type: "movie", subtitles: r[1] },
      subtitles: r[1],
      next: null
    };
  });
}

var busy = false;
function launch(promise){
  if(!App.player || !App.player.play){ App.hint("Reproductor no disponible"); return; }
  if(busy) return;
  busy = true;
  App.hint("Preparando reproducción…", 8000);
  promise.then(function(opts){
    busy = false;
    App.hint("", 1);
    App.player.play(opts);
  }).catch(function(e){
    busy = false;
    App.hint("Error: " + (e && e.message ? e.message : e), 5000);
  });
}

function playEpisode(show, ep, startAt){ launch(episodeOpts(show, ep, startAt)); }
function playFile(card, source, item, file, startAt){ launch(fileOpts(card, source, item, file, startAt)); }

/* Reanudar desde una entrada del historial ("Continuar viendo") */
function playHistory(entry){
  var m = entry.meta || {};
  if(!m.source || m.itemId === undefined){ App.hint("No se puede reanudar este elemento"); return; }
  var model = state.model;
  if(model && m.showId && model.byId[m.showId]){
    var show = model.byId[m.showId], ep = null;
    show.episodes.forEach(function(e){ if(e.key === entry.key) ep = e; });
    if(ep){ playEpisode(show, ep, undefined); return; }
  }
  if(model && m.cardId && model.byId[m.cardId]){
    var card = model.byId[m.cardId], f = findFile(card.item, m.fileId);
    if(f){ playFile(card, m.source, card.item, f, undefined); return; }
  }
  launch(App.torbox.link(m.source, m.itemId, m.fileId).then(function(url){
    return { title: entry.title, subtitle: entry.subtitle, url: url, key: entry.key, poster: entry.poster, meta: m, subtitles: [] };
  }));
}

/* ====================================================================
 * Componentes de UI
 * ==================================================================== */
function posterHtml(title, poster, extra){
  return '<div class="lib-poster" style="' + App.ui.placeholderStyle(title) + '">' +
    '<span class="lib-initials">' + esc(App.ui.initials(title)) + '</span>' +
    (poster ? '<img class="lib-img" src="' + esc(poster) + '" alt="" onload="this.parentNode.classList.add(\'has-img\')" onerror="this.parentNode.removeChild(this)">' : '') +
    (extra || "") +
  '</div>';
}

function marksHtml(prog, watched){
  if(watched) return '<span class="lib-watched">✓</span>';
  if(prog > 0.01) return '<div class="lib-prog"><i style="width:' + Math.round(prog * 100) + '%"></i></div>';
  return "";
}

function cardSub(card){
  var parts = [];
  if(card.year) parts.push(card.year);
  if(card.kind === "show"){
    var n = card.seasonNums.length;
    parts.push(n > 1 ? n + " temp." : (n === 1 ? "T" + card.seasonNums[0] + " · " + card.episodes.length + " ep." : "serie"));
  } else if(card.quality) parts.push(card.quality);
  return parts.join(" · ");
}

function cardHtml(card){
  var badge = card.kind === "show" ? '<span class="lib-badge">SERIE</span>' :
    (card.quality ? '<span class="lib-badge lib-badge-q">' + esc(card.quality) + '</span>' : "");
  var prog = 0, watched = false, key = "";
  if(card.kind === "show"){ prog = showProgress(card); watched = prog >= 1; }
  else if(card.videos.length){ key = keyOf(card.item._source, card.item.id, card.videos[0].id); prog = H.progress(key); watched = H.watched(key); }
  var m = card.meta;
  return '<div class="lib-card focusable" data-kind="card" data-id="' + esc(card.id) + '"' + (key ? ' data-key="' + esc(key) + '"' : '') + '>' +
    posterHtml(m ? m.title : card.title, m ? m.poster : "",
      badge + '<span class="lib-rating"' + (m && m.rating ? '' : ' hidden') + '>★ ' + (m && m.rating ? m.rating.toFixed(1) : '') + '</span>' +
      '<span class="lib-marks">' + marksHtml(prog, watched) + '</span>') +
    '<div class="lib-card-title">' + esc(m ? m.title : card.title) + '</div>' +
    '<div class="lib-card-sub num">' + esc(cardSub(card)) + '</div>' +
  '</div>';
}

/* Rellenar carátula y nota cuando llega el metadato */
function applyMetaToCard(el, card){
  var m = card.meta; if(!m || !el) return;
  var poster = el.querySelector(".lib-poster");
  if(m.poster && !poster.querySelector(".lib-img")){
    var img = new Image();
    img.className = "lib-img"; img.alt = "";
    img.onload = function(){ poster.classList.add("has-img"); };
    img.onerror = function(){ if(img.parentNode) img.parentNode.removeChild(img); };
    img.src = m.poster;
    poster.insertBefore(img, poster.firstChild.nextSibling);
  }
  var r = el.querySelector(".lib-rating");
  if(r && m.rating){ r.textContent = "★ " + m.rating.toFixed(1); r.removeAttribute("hidden"); }
  var t = el.querySelector(".lib-card-title");
  if(t && m.title) t.textContent = m.title;
  if(!card.year && m.year){
    card.year = m.year;
    var s = el.querySelector(".lib-card-sub"); if(s) s.textContent = cardSub(card);
  }
}

function heroHtml(title, m, fallbackYear, extraLine, actionsHtml){
  var bits = [];
  var year = (m && m.year) || fallbackYear;
  if(year) bits.push('<span class="num">' + year + '</span>');
  if(m && m.rating) bits.push('<span class="lib-star num">★ ' + m.rating.toFixed(1) + '</span>' +
    (m.votes ? ' <span class="muted num">(' + fmtVotes(m.votes) + ')</span>' : ''));
  if(m && m.runtime) bits.push('<span class="num">' + m.runtime + ' min</span>');
  if(extraLine) bits.push(extraLine);
  return '<div class="lib-hero">' +
      '<div class="lib-hero-poster">' + posterHtml(title, m ? (m.posterLarge || m.poster) : "", "") + '</div>' +
      '<div class="lib-hero-info">' +
        '<h1 class="lib-hero-title">' + esc((m && m.title) || title) + '</h1>' +
        '<div class="lib-hero-line">' + bits.join('<span class="lib-dot">·</span>') + '</div>' +
        '<div class="lib-hero-genres">' + esc(m && m.genres ? m.genres.join(" · ") : "") + '</div>' +
        '<p class="lib-hero-overview">' + esc(m && m.overview ? m.overview : (m ? "" : "Sin información adicional.")) + '</p>' +
        '<div class="lib-actions">' + (actionsHtml || "") + '</div>' +
      '</div>' +
    '</div>';
}
function fmtVotes(n){ return n >= 1000 ? (Math.round(n / 100) / 10) + "k votos" : n + " votos"; }

function recsHtml(){ return '<div class="lib-recs-wrap" hidden><div class="section-title">Recomendaciones</div><div class="hscroll lib-recs"></div></div>'; }

function fillRecs(root, m, grid){
  if(!m || !App.meta) return;
  App.meta.recommendations(m.type, m.tmdbId).then(function(list){
    var wrap = root.querySelector(".lib-recs-wrap");
    if(!wrap || !list.length) return;
    wrap.removeAttribute("hidden");
    wrap.querySelector(".lib-recs").innerHTML = list.slice(0, 15).map(function(r){
      return '<div class="lib-card lib-card-sm focusable" data-kind="rec" data-title="' + esc(r.title) + '">' +
        posterHtml(r.title, r.poster, r.rating ? '<span class="lib-rating">★ ' + r.rating.toFixed(1) + '</span>' : '') +
        '<div class="lib-card-title">' + esc(r.title) + '</div>' +
        '<div class="lib-card-sub num">' + esc((r.year || "") + (r.type === "tv" ? " · serie" : "")) + '</div>' +
      '</div>';
    }).join("");
    grid.refresh();
  });
}

function openRec(title){
  if(App.screens.get("search")) App.go("search", { q: title });
  else App.hint("La búsqueda aún no está disponible");
}

function setBackdrop(el, url){
  var b = el.querySelector(".lib-backdrop");
  if(!b || !url) return;
  var img = new Image();
  img.onload = function(){ b.style.backgroundImage = 'url("' + url + '")'; b.classList.add("on"); };
  img.src = url;
}

/* ====================================================================
 * Pantalla: Biblioteca
 * ==================================================================== */
var lib = {
  id: "library", label: "Biblioteca", nav: true, order: 10,
  hint: "OK abrir · ROJO recargar · AMARILLO buscar · AZUL ajustes",
  _gen: 0,

  mount: function(el){
    this.el = el;
    el.classList.add("lib-screen");
    var self = this;
    App.bus.on("history:change", function(){ if(App.current() === "library") self.refreshMarks(); });
    App.bus.on("settings:change", function(d){
      if(d && d.key === "tmdbKey"){ state.model && state.model.cards.forEach(function(c){ c.meta = null; c._metaP = null; }); }
      if(d && (d.key === "torboxToken")){ state.items = []; state.model = null; state.loadedAt = 0; }
    });
  },

  show: function(params){
    if(state.filter === null) state.filter = App.settings.get("defaultSource") || "all";
    var back = params && params._back;
    if(back && state.model){ this.render(true); return; }
    this.load(false);
  },

  load: function(fresh){
    var self = this, gen = ++this._gen;
    if(!state.model || fresh) App.ui.loading(this.el, "Cargando tu biblioteca…");
    if(fresh) App.torbox.invalidate();
    fetchItems(state.filter, fresh).then(function(items){
      if(gen !== self._gen) return;
      // conservar metadatos ya resueltos
      var oldMeta = {};
      if(state.model) state.model.cards.forEach(function(c){ if(c.meta) oldMeta[c.id] = c.meta; });
      state.items = items;
      state.model = buildModel(items);
      state.model.cards.forEach(function(c){ if(oldMeta[c.id]) c.meta = oldMeta[c.id]; });
      state.loadedAt = Date.now();
      self.render(false);
    }).catch(function(e){
      if(gen !== self._gen) return;
      if(e && e.status === 401){
        App.ui.error(self.el, "API key de TorBox no válida", "Revisa tu API key en Ajustes (botón AZUL) o vuelve a introducirla.");
      } else {
        App.ui.error(self.el, "No se pudo cargar la biblioteca", (e && e.message ? e.message : "") + " · Pulsa ROJO para reintentar.");
      }
      self.grid = null;
    });
  },

  render: function(restore){
    var el = this.el, model = state.model, self = this;
    var chips = [["all", "Todo"], ["torrents", "Torrents"], ["usenet", "Usenet"], ["webdl", "Web"]];
    var html = '<div class="scroll lib-scroll">' +
      '<div class="chips lib-chips">' + chips.map(function(c){
        return '<div class="chip focusable' + (state.filter === c[0] ? ' active' : '') + '" data-kind="chip" data-src="' + c[0] + '">' + c[1] + '</div>';
      }).join("") + '</div>';

    var cont = H.list().filter(function(h){ return h && h.meta && h.meta.source; }).slice(0, 10);
    if(cont.length){
      html += '<div class="section-title">Continuar viendo</div><div class="hscroll lib-continue">' +
        cont.map(function(h, i){
          return '<div class="lib-card lib-card-sm focusable" data-kind="cont" data-i="' + i + '" data-key="' + esc(h.key) + '">' +
            posterHtml(h.title, h.poster, '<span class="lib-marks">' + marksHtml(h.dur ? h.pos / h.dur : 0, false) + '</span>') +
            '<div class="lib-card-title">' + esc(h.title) + '</div>' +
            '<div class="lib-card-sub num">' + esc(h.subtitle || (h.dur ? "Quedan " + App.fmtTime(h.dur - h.pos) : "")) + '</div>' +
          '</div>';
        }).join("") + '</div>';
    }
    this._cont = cont;

    if(!model.cards.length){
      html += '<div class="lib-empty"><h2>Nada por aquí todavía</h2><p>No hay descargas terminadas' +
        (state.filter !== "all" ? ' en <b>' + esc(App.torbox.SOURCE_LABEL[state.filter]) + '</b>' : '') +
        '. Añade algo desde la pestaña Buscar o desde torbox.app y pulsa ROJO para recargar.</p></div>';
    } else {
      html += '<div class="section-title">Tu biblioteca <span class="muted num">' + model.cards.length + ' títulos</span></div>' +
        '<div class="lib-grid">' + model.cards.map(cardHtml).join("") + '</div>';
    }
    html += '</div>';

    var prevIndex = this.grid ? this.grid.index : 0;
    el.innerHTML = html;
    this.cardEls = {};
    Array.prototype.forEach.call(el.querySelectorAll('.lib-card[data-kind="card"]'), function(c){ self.cardEls[c.dataset.id] = c; });

    this.grid = new App.ui.FocusGrid(el.querySelector(".lib-scroll"), {
      onSelect: function(i, node){ self.select(node); }
    });
    var start = restore ? prevIndex : this.firstCardIndex();
    this.grid.focus(start, true);

    // metadatos perezosos (en orden de aparición; la cola limita la concurrencia)
    if(App.meta && App.meta.hasKey()){
      var gen = this._gen;
      model.cards.forEach(function(card){
        if(card.meta){ return; }
        lookupMeta(card).then(function(){ if(gen === self._gen) applyMetaToCard(self.cardEls[card.id], card); });
      });
    } else if(!tmdbToastShown && model.cards.length){
      tmdbToastShown = true;
      App.ui.toast("Añade una clave TMDB en Ajustes para ver carátulas", 4500);
    }
  },

  firstCardIndex: function(){
    if(!this.grid) return 0;
    var items = this.grid.items;
    for(var i = 0; i < items.length; i++){
      if(items[i].dataset.kind === "cont" || items[i].dataset.kind === "card") return i;
    }
    return 0;
  },

  refreshMarks: function(){
    if(!state.model || !this.el) return;
    var self = this;
    Array.prototype.forEach.call(this.el.querySelectorAll('.lib-card[data-kind="card"]'), function(node){
      var card = state.model.byId[node.dataset.id]; if(!card) return;
      var prog, watched;
      if(card.kind === "show"){ prog = showProgress(card); watched = prog >= 1; }
      else { var k = node.dataset.key; if(!k) return; prog = H.progress(k); watched = H.watched(k); }
      var mk = node.querySelector(".lib-marks"); if(mk) mk.innerHTML = marksHtml(prog, watched);
    });
    // "Continuar viendo" puede haber cambiado: re-render ligero conservando foco
    var cont = H.list().filter(function(h){ return h && h.meta && h.meta.source; }).slice(0, 10);
    var sig = cont.map(function(h){ return h.key; }).join("|");
    var old = (this._cont || []).map(function(h){ return h.key; }).join("|");
    if(sig !== old) self.render(true);
  },

  select: function(node){
    var kind = node.dataset.kind;
    if(kind === "chip"){
      if(state.filter === node.dataset.src) return;
      state.filter = node.dataset.src;
      state.model = null;
      this.load(false);
      return;
    }
    if(kind === "cont"){
      var h = this._cont[+node.dataset.i];
      if(h) playHistory(h);
      return;
    }
    if(kind === "card"){
      var card = state.model.byId[node.dataset.id];
      if(!card) return;
      if(card.kind === "show") App.go("show", { id: card.id });
      else if(card.videos.length) App.go("movie", { id: card.id });
      else App.go("files", { id: card.id });
    }
  },

  onKey: function(k){
    if(k === K.RED){ this.load(true); App.hint("Recargando biblioteca…"); return true; }
    if(!this.grid) return false;
    if(App.isBack(k)) return false;
    return this.grid.handleKey(k);
  },
  focus: function(){ if(this.grid) this.grid.focus(this.grid.index, true); },
  blur: function(){ if(this.grid) this.grid.blur(); },
  hide: function(){}
};
App.screens.register(lib);

/* ====================================================================
 * Pantalla: detalle de serie
 * ==================================================================== */
var showScreen = {
  id: "show", label: "Serie", nav: false, section: "library",
  hint: "◄► temporada · OK reproducir · VERDE visto/no visto",

  mount: function(el){
    this.el = el; el.classList.add("lib-screen");
    var self = this;
    App.bus.on("history:change", function(){ if(App.current() === "show") self.refreshMarks(); });
  },

  show: function(params){
    var show = state.model && state.model.byId[params.id];
    if(!show){ App.ui.error(this.el, "Serie no encontrada", "Vuelve a la biblioteca."); this.grid = null; return; }
    var back = params._back && this.showObj === show;
    this.showObj = show;
    if(!back) this.season = (nextUp(show) || { ep: { season: show.seasonNums[0] } }).ep.season;
    var prevIndex = back && this.grid ? this.grid.index : -1;
    this.render();
    var self = this;
    lookupMeta(show).then(function(m){
      if(self.showObj !== show || !m) return;
      return App.meta.details("tv", m.tmdbId).then(function(d){
        if(d){ show.meta = Object.assign({}, m, d); }
        if(self.showObj !== show) return;
        var idx = self.grid ? self.grid.index : 0;
        self.render();
        self.grid.focus(idx, true);
      });
    });
    if(prevIndex >= 0) this.grid.focus(prevIndex, true);
  },

  render: function(){
    var show = this.showObj, el = this.el, self = this, m = show.meta;
    var nu = nextUp(show);
    var playLabel = !nu ? "" : (nu.resume ? "Continuar " + epLabel(nu.ep) + " (" + App.fmtTime(nu.resume) + ")" : "Reproducir " + epLabel(nu.ep));
    var nSeasons = show.seasonNums.length;
    var extraLine = (nSeasons ? nSeasons + (nSeasons === 1 ? " temporada" : " temporadas") + " en tu biblioteca" : "") +
      (m && m.seasons && m.seasons > nSeasons ? ' <span class="muted">(de ' + m.seasons + ')</span>' : "");
    var actions = (nu ? '<div class="btn primary focusable" data-kind="play">▶ ' + esc(playLabel) + '</div>' : '') +
      (nu && nu.resume ? '<div class="btn focusable" data-kind="restart">Desde el principio</div>' : '');

    var chips = show.seasonNums.map(function(s){
      return '<div class="chip focusable' + (s === self.season ? ' active' : '') + '" data-kind="season" data-s="' + s + '">Temporada ' + s + '</div>';
    });
    if(show.extras.length) chips.push('<div class="chip focusable' + (self.season === "x" ? ' active' : '') + '" data-kind="season" data-s="x">Otros archivos</div>');

    el.innerHTML =
      '<div class="lib-backdrop"></div><div class="lib-shade"></div>' +
      '<div class="scroll lib-detail-scroll">' +
        heroHtml(show.title, m, show.year, extraLine, actions) +
        '<div class="chips lib-seasons">' + chips.join("") + '</div>' +
        '<div class="lib-eps"></div>' +
        recsHtml() +
      '</div>';
    if(m) setBackdrop(el, m.backdrop);

    this.grid = new App.ui.FocusGrid(el.querySelector(".lib-detail-scroll"), {
      onSelect: function(i, node){ self.select(node); },
      onFocus: function(i, node){
        if(node.dataset.kind === "season"){
          var s = node.dataset.s === "x" ? "x" : +node.dataset.s;
          if(s !== self.season){ self.season = s; self.renderEpisodes(); }
        }
      }
    });
    this.renderEpisodes();
    this.grid.focus(0, true);
    fillRecs(el, m, this.grid);
  },

  renderEpisodes: function(){
    var show = this.showObj, el = this.el, self = this;
    var box = el.querySelector(".lib-eps");
    Array.prototype.forEach.call(el.querySelectorAll(".lib-seasons .chip"), function(c){
      c.classList.toggle("active", (c.dataset.s === "x" ? "x" : +c.dataset.s) === self.season);
    });
    var rows;
    if(this.season === "x"){
      rows = show.extras.map(function(x, i){
        return '<div class="row lib-ep focusable" data-kind="extra" data-i="' + i + '" data-key="' + esc(x.key) + '">' +
          '<div class="title">' + esc(x.fileName) + '</div>' +
          '<span class="lib-ep-marks">' + epMarks(x.key) + '</span>' +
          '<div class="meta num">' + App.fmtSize(x.size) + '</div></div>';
      });
    } else {
      var season = show.seasons[this.season] || {};
      rows = Object.keys(season).map(Number).sort(function(a, b){ return a - b; }).map(function(n){
        var ep = season[n];
        return '<div class="row lib-ep focusable" data-kind="ep" data-s="' + ep.season + '" data-e="' + n + '" data-key="' + esc(ep.key) + '">' +
          '<span class="lib-ep-num num">E' + (n < 10 ? "0" : "") + n + '</span>' +
          '<div class="title"><span class="lib-ep-name">' + esc(ep.fileName) + '</span></div>' +
          '<span class="lib-ep-marks">' + epMarks(ep.key) + '</span>' +
          (ep.quality ? '<span class="badge">' + esc(ep.quality) + '</span>' : '') +
          '<div class="meta num lib-ep-meta">' + App.fmtSize(ep.size) + '</div></div>';
      });
    }
    box.innerHTML = rows.join("") || '<p class="muted">Sin episodios.</p>';
    if(this.grid) this.grid.refresh();

    // nombres de episodio desde TMDB
    if(this.season !== "x" && show.meta && App.meta){
      var sn = this.season;
      App.meta.season(show.meta.tmdbId, sn).then(function(data){
        if(!data || self.showObj !== show || self.season !== sn) return;
        var byNum = {};
        data.episodes.forEach(function(e){ byNum[e.episode] = e; });
        Array.prototype.forEach.call(box.querySelectorAll(".lib-ep"), function(r){
          var e = byNum[+r.dataset.e]; if(!e) return;
          if(e.name) r.querySelector(".lib-ep-name").textContent = e.name;
          var meta = r.querySelector(".lib-ep-meta");
          var ep = show.seasons[sn][+r.dataset.e];
          if(meta) meta.textContent = (e.runtime ? e.runtime + " min · " : "") + App.fmtSize(ep.size);
        });
      });
    }
  },

  refreshMarks: function(){
    if(!this.el) return;
    Array.prototype.forEach.call(this.el.querySelectorAll(".lib-ep"), function(r){
      var mk = r.querySelector(".lib-ep-marks"); if(mk) mk.innerHTML = epMarks(r.dataset.key);
    });
  },

  focusedEp: function(){
    var node = this.grid && this.grid.current();
    if(!node) return null;
    if(node.dataset.kind === "ep") return this.showObj.seasons[+node.dataset.s][+node.dataset.e];
    if(node.dataset.kind === "extra") return this.showObj.extras[+node.dataset.i];
    return null;
  },

  select: function(node){
    var show = this.showObj, kind = node.dataset.kind;
    if(kind === "play" || kind === "restart"){
      var nu = nextUp(show); if(!nu) return;
      playEpisode(show, nu.ep, kind === "restart" ? 0 : (nu.resume || 0));
    } else if(kind === "ep"){
      playEpisode(show, show.seasons[+node.dataset.s][+node.dataset.e], undefined);
    } else if(kind === "extra"){
      var x = show.extras[+node.dataset.i];
      var f = findFile(x.item, x.fileId);
      if(f) playFile({ title: show.title, meta: show.meta, videos: [1, 2] }, x.source, x.item, f, undefined);
    } else if(kind === "rec"){
      openRec(node.dataset.title);
    }
  },

  onKey: function(k){
    if(!this.grid) return false;
    if(k === K.GREEN){
      var ep = this.focusedEp();
      if(ep){
        var show = this.showObj;
        toggleWatched(ep.key, { title: show.meta ? show.meta.title : show.title, subtitle: ep.season ? epLabel(ep) : ep.fileName,
          poster: show.meta ? show.meta.poster : "", meta: { source: ep.source, itemId: ep.itemId, fileId: ep.fileId, showId: show.id,
          season: ep.season, episode: ep.episode, type: "tv" } });
        this.refreshMarks();
      } else App.hint("Enfoca un episodio para marcarlo");
      return true;
    }
    if(App.isBack(k)) return false;
    return this.grid.handleKey(k);
  },
  focus: function(){ if(this.grid) this.grid.focus(this.grid.index, true); },
  blur: function(){ if(this.grid) this.grid.blur(); }
};
App.screens.register(showScreen);

function epMarks(key){
  if(H.watched(key)) return '<span class="lib-ep-watched">✓ Visto</span>';
  var p = H.progress(key);
  if(p > 0.01) return '<span class="progress lib-ep-prog"><i style="width:' + Math.round(p * 100) + '%"></i></span>';
  return "";
}

/* ====================================================================
 * Pantalla: detalle de película / descarga suelta
 * ==================================================================== */
var movieScreen = {
  id: "movie", label: "Película", nav: false, section: "library",
  hint: "OK reproducir · VERDE visto/no visto",

  mount: function(el){
    this.el = el; el.classList.add("lib-screen");
    var self = this;
    App.bus.on("history:change", function(){ if(App.current() === "movie" && self.card) self.render(true); });
  },

  show: function(params){
    var card = state.model && state.model.byId[params.id];
    if(!card){ App.ui.error(this.el, "No encontrado", "Vuelve a la biblioteca."); this.grid = null; return; }
    var back = params._back && this.card === card;
    this.card = card;
    this.render(back);
    var self = this;
    lookupMeta(card).then(function(m){
      if(self.card !== card || !m) return;
      return App.meta.details(m.type, m.tmdbId).then(function(d){
        if(d) card.meta = Object.assign({}, m, d);
        if(self.card === card) self.render(true);
      });
    });
  },

  render: function(keep){
    var card = this.card, el = this.el, self = this, m = card.meta;
    var src = card.item._source;
    var main = card.videos.slice().sort(function(a, b){ return (b.size || 0) - (a.size || 0); })[0];
    var key = main ? keyOf(src, card.item.id, main.id) : "";
    var h = key ? H.get(key) : null;
    var resume = h && !h.watched && h.pos > 30 && (!h.dur || h.pos / h.dur < 0.9) ? h.pos : 0;

    var actions = '';
    if(main){
      actions += '<div class="btn primary focusable" data-kind="play">▶ ' + (resume ? "Reanudar " + App.fmtTime(resume) : "Reproducir") + '</div>';
      if(resume) actions += '<div class="btn focusable" data-kind="restart">Desde el principio</div>';
      actions += '<div class="btn focusable" data-kind="watched">' + (H.watched(key) ? "✓ Visto" : "Marcar visto") + '</div>';
    }
    var extra = (card.quality ? '<span class="badge">' + esc(card.quality) + '</span>' : '') +
      ' <span class="muted num">' + App.fmtSize(itemSize(card.item)) + ' · ' + esc(App.torbox.SOURCE_LABEL[src] || src) + '</span>';

    var files = '';
    if(card.videos.length > 1){
      files = '<div class="section-title">Archivos <span class="muted num">' + card.videos.length + '</span></div>' +
        card.videos.slice().sort(function(a, b){ return fileName(a).localeCompare(fileName(b)); }).map(function(f){
          var k = keyOf(src, card.item.id, f.id);
          return '<div class="row focusable" data-kind="file" data-f="' + esc(f.id) + '" data-key="' + esc(k) + '">' +
            '<div class="title">' + esc(fileName(f)) + '</div>' +
            '<span class="lib-ep-marks">' + epMarks(k) + '</span>' +
            '<div class="meta num">' + App.fmtSize(f.size) + '</div></div>';
        }).join("");
    }

    var prevIndex = keep && this.grid ? this.grid.index : 0;
    el.innerHTML =
      '<div class="lib-backdrop"></div><div class="lib-shade"></div>' +
      '<div class="scroll lib-detail-scroll">' +
        heroHtml(card.title, m, card.year, extra, actions) +
        files + recsHtml() +
      '</div>';
    if(m) setBackdrop(el, m.backdrop);
    this.main = main; this.mainKey = key; this.resume = resume;
    this.grid = new App.ui.FocusGrid(el.querySelector(".lib-detail-scroll"), {
      onSelect: function(i, node){ self.select(node); }
    });
    this.grid.focus(prevIndex, true);
    fillRecs(el, m, this.grid);
  },

  watchedInfo: function(key, fileId){
    var card = this.card, m = card.meta;
    return { title: m ? m.title : card.title, subtitle: card.year ? String(card.year) : "", poster: m ? m.poster : "",
      meta: { source: card.item._source, itemId: card.item.id, fileId: fileId, cardId: card.id, type: "movie" } };
  },

  select: function(node){
    var card = this.card, kind = node.dataset.kind, src = card.item._source;
    if(kind === "play") playFile(card, src, card.item, this.main, this.resume || 0);
    else if(kind === "restart") playFile(card, src, card.item, this.main, 0);
    else if(kind === "watched"){ toggleWatched(this.mainKey, this.watchedInfo(this.mainKey, this.main.id)); this.render(true); }
    else if(kind === "file"){
      var f = findFile(card.item, node.dataset.f);
      if(f) playFile(card, src, card.item, f, undefined);
    } else if(kind === "rec") openRec(node.dataset.title);
  },

  onKey: function(k){
    if(!this.grid) return false;
    if(k === K.GREEN){
      var node = this.grid.current();
      if(node && node.dataset.kind === "file"){
        toggleWatched(node.dataset.key, this.watchedInfo(node.dataset.key, node.dataset.f));
      } else if(this.mainKey){
        toggleWatched(this.mainKey, this.watchedInfo(this.mainKey, this.main.id));
      }
      this.render(true);
      return true;
    }
    if(App.isBack(k)) return false;
    return this.grid.handleKey(k);
  },
  focus: function(){ if(this.grid) this.grid.focus(this.grid.index, true); },
  blur: function(){ if(this.grid) this.grid.blur(); }
};
App.screens.register(movieScreen);

/* ====================================================================
 * Pantalla: lista de archivos genérica
 * ==================================================================== */
var filesScreen = {
  id: "files", label: "Archivos", nav: false, section: "library",
  hint: "OK reproducir · Atrás volver",
  mount: function(el){ this.el = el; el.classList.add("lib-screen"); },

  show: function(params){
    var card = state.model && state.model.byId[params.id];
    var item = card ? card.item : params.item;
    if(!item){ App.ui.error(this.el, "No encontrado", "Vuelve a la biblioteca."); this.grid = null; return; }
    var keep = params._back && this.item === item;
    this.item = item; this.card = card;
    var src = item._source || params.source;
    this.src = src;
    var files = (item.files || []).slice().sort(function(a, b){ return String(a.name || "").localeCompare(String(b.name || "")); });
    this.files = files;
    var html = '<div class="scroll">' +
      '<div class="section-title">' + esc(item.name || "(sin nombre)") + ' <span class="muted num">' + files.length + ' archivos · ' + App.fmtSize(itemSize(item)) + '</span></div>';
    if(!files.length) html += '<p class="muted">Esta descarga no tiene archivos.</p>';
    files.forEach(function(f, i){
      var vid = App.isVideo(f);
      var k = keyOf(src, item.id, f.id);
      html += '<div class="row focusable' + (vid ? '' : ' dim') + '" data-i="' + i + '" data-key="' + esc(k) + '">' +
        '<div class="title">' + esc(f.name || fileName(f)) + '</div>' +
        (vid ? '<span class="lib-ep-marks">' + epMarks(k) + '</span>' : '<span class="meta">no vídeo</span>') +
        '<div class="meta num">' + App.fmtSize(f.size) + '</div></div>';
    });
    html += '</div>';
    var prev = keep && this.grid ? this.grid.index : 0;
    this.el.innerHTML = html;
    var self = this;
    this.grid = new App.ui.FocusGrid(this.el.querySelector(".scroll"), {
      onSelect: function(i, node){
        var f = self.files[+node.dataset.i];
        if(!f) return;
        if(!App.isVideo(f)){ App.hint("Ese archivo no parece vídeo"); return; }
        playFile(self.card || { title: parseName(item.name).title, videos: self.files.filter(App.isVideo) }, self.src, self.item, f, undefined);
      }
    });
    this.grid.focus(prev, true);
  },
  onKey: function(k){
    if(!this.grid) return false;
    if(App.isBack(k)) return false;
    return this.grid.handleKey(k);
  },
  focus: function(){ if(this.grid) this.grid.focus(this.grid.index, true); },
  blur: function(){ if(this.grid) this.grid.blur(); }
};
App.screens.register(filesScreen);

/* Exponer utilidades por si otras pantallas las quieren (p. ej. Continuar) */
/* Siguiente episodio a partir de una clave de historial (lo usa la pantalla Continuar) */
function ensureModel(){
  if(state.model) return Promise.resolve(state.model);
  return fetchItems("all", false).then(function(items){
    if(!state.model){ state.items = items; state.model = buildModel(items); state.loadedAt = Date.now(); }
    return state.model;
  });
}
function nextFor(key, meta){
  meta = meta || {};
  return ensureModel().then(function(model){
    var show = meta.showId ? model.byId[meta.showId] : null;
    if(!show && meta.showTitle){
      var nt = normTitle(meta.showTitle);
      model.cards.forEach(function(c){
        if(!show && c.kind === "show" && (normTitle(c.title) === nt || (c.meta && normTitle(c.meta.title) === nt))) show = c;
      });
    }
    if(!show){
      // buscar la serie que contiene esa clave
      model.cards.forEach(function(c){
        if(!show && c.kind === "show") c.episodes.forEach(function(e){ if(e.key === key) show = c; });
      });
    }
    if(!show) return null;
    var idx = -1;
    show.episodes.forEach(function(e, i){
      if(e.key === key || (idx < 0 && e.season === meta.season && e.episode === meta.episode)) idx = i;
    });
    var nxt = idx >= 0 ? show.episodes[idx + 1] : null;
    if(!nxt) return null;
    return lookupMeta(show).then(function(){ return episodeOpts(show, nxt, 0); });
  }).catch(function(e){ console.warn("[library] nextFor", e); return null; });
}

App.library = {
  nextFor: nextFor,
  playHistory: playHistory,
  model: function(){ return state.model; },
  reload: function(){ lib.load(true); }
};

})();
