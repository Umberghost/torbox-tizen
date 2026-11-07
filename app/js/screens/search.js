/* screens/search.js — buscar en TorBox (Search API) y añadir a la cuenta.
 * También extiende App.torbox con search/addMagnet/addUsenet/control/checkCached. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var tb = App.torbox;
var SEARCH_BASE = "https://search-api.torbox.app";

/* =================== Extensiones de App.torbox =================== */

function pick(o, keys){
  for(var i = 0; i < keys.length; i++){
    var v = o[keys[i]];
    if(v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function guessQuality(title){
  var t = String(title || "");
  var m = t.match(/\b(2160p|4k|uhd|1080p|720p|576p|480p)\b/i);
  var q = m ? m[1].toUpperCase().replace("UHD", "4K").replace("2160P", "4K") : "";
  if(/\b(hevc|x265|h\.?265)\b/i.test(t)) q += (q ? " · " : "") + "HEVC";
  if(/\bhdr|dolby.?vision|\bdv\b/i.test(t)) q += (q ? " · " : "") + "HDR";
  return q;
}

function normTorrent(r){
  var title = pick(r, ["raw_title", "title", "name"]) || "(sin título)";
  var hash = String(pick(r, ["hash", "info_hash", "infohash"]) || "").toLowerCase();
  var magnet = pick(r, ["magnet", "magnet_link"]);
  if(!magnet && hash) magnet = "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(title);
  var parsed = r.title_parsed_data || {};
  var q = parsed.resolution ? String(parsed.resolution) : "";
  if(parsed.quality) q += (q ? " · " : "") + parsed.quality;
  return {
    kind: "torrents", title: title, hash: hash, magnet: magnet,
    size: Number(pick(r, ["size", "bytes"]) || 0),
    seeders: pick(r, ["last_known_seeders", "seeders", "seeds"]),
    peers: pick(r, ["last_known_peers", "peers", "leechers"]),
    cached: r.cached === true || r.cached === "true",
    owned: r.owned === true || r.owned === "true",
    quality: q || guessQuality(title),
    tracker: r.tracker || "", age: r.age || ""
  };
}
function normUsenet(r){
  var title = pick(r, ["raw_title", "title", "name"]) || "(sin título)";
  var parsed = r.title_parsed_data || {};
  return {
    kind: "usenet", title: title, hash: String(r.hash || "").toLowerCase(),
    link: pick(r, ["nzb", "link", "url", "nzb_link"]),
    size: Number(pick(r, ["size", "bytes"]) || 0),
    cached: r.cached === true || r.cached === "true",
    owned: r.owned === true || r.owned === "true",
    quality: parsed.resolution ? String(parsed.resolution) : guessQuality(title),
    tracker: r.tracker || r.indexer || "", age: r.age || ""
  };
}

/* search(query, {type}) → Promise<{results, metadata}> */
tb.search = function(query, opts){
  opts = opts || {};
  var type = opts.type === "usenet" ? "usenet" : "torrents";
  var path = "/" + type + "/search/" + encodeURIComponent(query) +
             "?metadata=true&check_cache=true&check_owned=true";
  return tb.api(path, { base: SEARCH_BASE }).then(function(j){
    var d = j.data || {};
    var list = Array.isArray(d) ? d : (d[type] || d.torrents || d.nzbs || d.results || []);
    var results = list.map(type === "usenet" ? normUsenet : normTorrent)
      .filter(function(r){ return type === "usenet" ? !!r.link : !!r.magnet; });
    var meta = Array.isArray(d) ? null : (d.metadata || null);
    // Si la API no informa de caché, preguntar a /checkcached
    var anyCacheInfo = list.some(function(r){ return r.cached !== undefined; });
    if(type === "torrents" && !anyCacheInfo && results.length){
      return tb.checkCached(results.map(function(r){ return r.hash; }).filter(Boolean))
        .then(function(set){
          results.forEach(function(r){ r.cached = !!set[r.hash]; });
          return { results: results, metadata: meta };
        })
        .catch(function(){ return { results: results, metadata: meta }; });
    }
    return { results: results, metadata: meta };
  });
};

/* checkCached(hashes) → Promise<{hash: true}> */
tb.checkCached = function(hashes){
  hashes = (hashes || []).slice(0, 100);
  if(!hashes.length) return Promise.resolve({});
  return tb.api("/torrents/checkcached?hash=" + encodeURIComponent(hashes.join(",")) +
                "&format=object&list_files=false").then(function(j){
    var out = {}, d = j.data;
    if(Array.isArray(d)) d.forEach(function(x){ if(x && x.hash) out[String(x.hash).toLowerCase()] = true; });
    else if(d && typeof d === "object") Object.keys(d).forEach(function(h){ if(d[h]) out[h.toLowerCase()] = true; });
    return out;
  });
};

tb.addMagnet = function(magnet, name){
  return tb.api("/torrents/createtorrent", { method: "POST", form: { magnet: magnet, name: name || undefined } })
    .then(function(j){ tb.invalidate(); return j.data || {}; });
};
tb.addUsenet = function(link, name){
  return tb.api("/usenet/createusenetdownload", { method: "POST", form: { link: link, name: name || undefined } })
    .then(function(j){ tb.invalidate(); return j.data || {}; });
};

/* control(source, id, operation): operation ∈ delete | pause | resume | reannounce */
var CONTROL = {
  torrents: { path: "/torrents/controltorrent", field: "torrent_id" },
  usenet:   { path: "/usenet/controlusenetdownload", field: "usenet_id" },
  webdl:    { path: "/webdl/controlwebdownload", field: "webdl_id" }
};
tb.control = function(source, id, operation){
  var c = CONTROL[source];
  if(!c) return Promise.reject(new Error("Fuente desconocida"));
  var body = { operation: operation };
  body[c.field] = id;
  return tb.api(c.path, { method: "POST", body: body }).then(function(j){ tb.invalidate(); return j; });
};

/* =================== Pantalla Buscar =================== */

var RECENT_KEY = "recentSearches";
var s = { el: null, grid: null, q: "", type: "torrents", results: null, meta: null, loading: false, error: "", reqId: 0 };

function recent(){ return App.store.get(RECENT_KEY, []); }
function pushRecent(q){
  var l = recent().filter(function(x){ return x.toLowerCase() !== q.toLowerCase(); });
  l.unshift(q);
  App.store.set(RECENT_KEY, l.slice(0, 10));
}

function metaHtml(m){
  if(!m || typeof m !== "object") return "";
  var title = pick(m, ["title", "name"]);
  if(!title) return "";
  var img = pick(m, ["poster", "image", "cover", "backdrop"]);
  var years = m.releaseYears || m.release_years || m.year || "";
  if(Array.isArray(years)) years = years.join("–");
  var desc = pick(m, ["description", "overview", "plot"]) || "";
  var rating = pick(m, ["rating", "imdb_rating", "vote_average"]);
  var genres = Array.isArray(m.genres) ? m.genres.join(", ") : "";
  return '<div class="srch-meta">' +
    (img ? '<img class="srch-poster" src="' + App.esc(img) + '" alt="">' : '') +
    '<div class="srch-meta-text"><h3>' + App.esc(title) +
      (years ? ' <span class="muted">(' + App.esc(years) + ')</span>' : '') + '</h3>' +
      '<div class="muted">' + [rating ? "★ " + App.esc(rating) : "", App.esc(genres)].filter(Boolean).join(" · ") + '</div>' +
      (desc ? '<p>' + App.esc(String(desc).slice(0, 360)) + '</p>' : '') +
    '</div></div>';
}

function render(keepIndex){
  var html = '<div class="scroll srch">';
  html += '<div class="srch-top">' +
    '<div class="srch-box focusable" data-act="kb">' +
      '<span class="srch-icon">⌕</span>' +
      (s.q ? App.esc(s.q) : '<span class="muted">Buscar películas, series…</span>') +
    '</div>' +
    '<div class="chips">' +
      ['torrents', 'usenet'].map(function(t){
        return '<div class="chip focusable' + (s.type === t ? ' active' : '') + '" data-act="type" data-t="' + t + '">' +
          (t === "torrents" ? "Torrents" : "Usenet") + '</div>';
      }).join("") +
    '</div></div>';

  if(s.loading){
    html += '<div class="srch-state"><div class="spinner"></div><p>Buscando “' + App.esc(s.q) + '”…</p></div>';
  } else if(s.error){
    html += '<div class="srch-state err"><h2>No se pudo buscar</h2><p>' + App.esc(s.error) + '</p>' +
            '<div class="btn focusable" data-act="retry">Reintentar</div></div>';
  } else if(s.results){
    html += metaHtml(s.meta);
    var cachedN = s.results.filter(function(r){ return r.cached; }).length;
    html += '<div class="section-title">' + s.results.length + ' resultados' +
            '<span class="muted">' + (cachedN ? cachedN + ' en caché · reproducción inmediata' : 'ninguno en caché') + '</span></div>';
    if(!s.results.length){
      html += '<p class="muted srch-none">Sin resultados. Prueba con otro título o cambia a ' +
              (s.type === "torrents" ? "Usenet" : "Torrents") + '.</p>';
    }
    s.results.forEach(function(r, i){
      var stats = [];
      if(r.seeders !== undefined) stats.push('<span class="srch-seed">▲ ' + App.esc(r.seeders) + '</span>');
      if(r.peers !== undefined) stats.push('<span>▼ ' + App.esc(r.peers) + '</span>');
      html += '<div class="row srch-row focusable" data-act="res" data-i="' + i + '">' +
        (r.cached ? '<span class="srch-cached">EN CACHÉ</span>' : '') +
        (r.owned ? '<span class="badge">YA LO TIENES</span>' : '') +
        '<div class="title">' + App.esc(r.title) + '</div>' +
        (r.quality ? '<span class="badge srch-q">' + App.esc(r.quality) + '</span>' : '') +
        '<div class="meta num">' + stats.join(" ") + '</div>' +
        '<div class="meta num srch-size">' + App.fmtSize(r.size) + '</div>' +
      '</div>';
    });
  } else {
    var rec = recent();
    if(rec.length){
      html += '<div class="section-title">Búsquedas recientes</div>';
      rec.forEach(function(q){
        html += '<div class="row focusable" data-act="recent" data-q="' + App.esc(q) + '">' +
                '<span class="muted">↺</span><div class="title">' + App.esc(q) + '</div></div>';
      });
      html += '<div class="btn focusable srch-clear" data-act="clearrecent">Borrar historial de búsqueda</div>';
    } else {
      html += '<div class="srch-state"><h2>Busca y añade desde la tele</h2>' +
              '<p>Pulsa OK sobre la caja de búsqueda. Los resultados <b class="srch-cached-text">EN CACHÉ</b> ' +
              'ya están en TorBox y se pueden ver al instante.</p></div>';
    }
  }
  html += '</div>';
  var idx = s.grid ? s.grid.index : 0;
  s.el.innerHTML = html;
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect });
  if(keepIndex) s.grid.focus(idx, true);
  else s.grid.focus(0, true);
  if(document.body.classList.contains("zone-header")) s.grid.blur();
}

function openKeyboard(){
  App.ui.keyboard.open({
    title: "Buscar en " + (s.type === "torrents" ? "torrents" : "usenet"),
    value: s.q, placeholder: "Título, temporada…",
    onDone: function(v){ v = String(v || "").trim(); if(v) run(v); }
  });
}

function run(q){
  s.q = q; s.loading = true; s.error = ""; s.results = null; s.meta = null;
  pushRecent(q);
  render();
  var id = ++s.reqId;
  tb.search(q, { type: s.type }).then(function(res){
    if(id !== s.reqId) return;
    res.results.sort(function(a, b){
      if(a.cached !== b.cached) return a.cached ? -1 : 1;
      return (Number(b.seeders) || 0) - (Number(a.seeders) || 0);
    });
    s.loading = false; s.results = res.results; s.meta = res.metadata;
    render();
    // foco al primer resultado
    var first = s.el.querySelector('[data-act="res"]');
    if(first && !document.body.classList.contains("zone-header")) s.grid.focus(s.grid.items.indexOf(first), true);
  }).catch(function(e){
    if(id !== s.reqId) return;
    s.loading = false;
    s.error = e.status === 401 || e.status === 403 ? "La API key no tiene acceso a la búsqueda (revisa tu plan o la key en Ajustes)." : e.message;
    render();
  });
}

function addResult(r){
  var add = function(){
    App.ui.toast("Añadiendo a TorBox…");
    return (r.kind === "usenet" ? tb.addUsenet(r.link, r.title) : tb.addMagnet(r.magnet, r.title));
  };
  var fail = function(e){ App.ui.toast("Error al añadir: " + e.message, 5000); };
  if(r.cached){
    App.ui.menu(r.title, [
      { label: "Añadir y ver en Descargas", value: "go" },
      { label: "Solo añadir", value: "add" },
      { label: "Cancelar", value: null }
    ]).then(function(v){
      if(!v) return;
      add().then(function(){
        App.ui.toast("Añadido. Está en caché: listo para ver.");
        r.owned = true; render(true);
        if(v === "go" && App.screens.get("downloads")) App.section("downloads");
      }).catch(fail);
    });
  } else {
    App.ui.confirm("¿Añadir a TorBox?", r.title + " · " + App.fmtSize(r.size) +
      "\nNo está en caché: TorBox tendrá que descargarlo primero.", "Añadir", "Cancelar")
      .then(function(yes){
        if(!yes) return;
        add().then(function(){
          App.ui.toast("Añadido. Sigue el progreso en Descargas.");
          r.owned = true; render(true);
        }).catch(fail);
      });
  }
}

function onSelect(i, el){
  var act = el.getAttribute("data-act");
  if(act === "kb") openKeyboard();
  else if(act === "type"){
    var t = el.getAttribute("data-t");
    if(t !== s.type){ s.type = t; if(s.q && (s.results || s.error)) run(s.q); else render(true); }
  }
  else if(act === "recent") run(el.getAttribute("data-q"));
  else if(act === "clearrecent"){ App.store.remove(RECENT_KEY); render(); }
  else if(act === "retry") run(s.q);
  else if(act === "res"){
    var r = s.results[Number(el.getAttribute("data-i"))];
    if(r) addResult(r);
  }
}

App.screens.register({
  id: "search", label: "Buscar", nav: true, order: 40,
  hint: "OK buscar/añadir · ◄► filtros · AMARILLO teclado · Atrás volver",
  mount: function(el){ s.el = el; },
  show: function(params){
    params = params || {};
    if(params.type === "usenet" || params.type === "torrents") s.type = params.type;
    if(params.q && !params._back){ run(String(params.q)); return; }
    render(true);
    // Si se llega directo al contenido (atajo AMARILLO) sin búsqueda, abrir el teclado
    if(!s.q && !params._back){
      setTimeout(function(){
        if(App.current() === "search" && !document.body.classList.contains("zone-header") &&
           !App.ui.keyboard.isOpen() && !App.ui.isModalOpen()) openKeyboard();
      }, 0);
    }
  },
  hide: function(){ s.reqId++; if(s.loading){ s.loading = false; } },
  focus: function(){ if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  onKey: function(k){
    if(k === K.YELLOW){ openKeyboard(); return true; }
    if(App.isBack(k) && (s.results || s.error)){
      s.results = null; s.error = ""; s.meta = null; render(); return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
