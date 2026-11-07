/* screens/live.js — TV en directo (TDTChannels / M3U) y accesos directos a apps oficiales. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

var CACHE_KEY = "live_cache";
var FAVS_KEY = "live_favs";
var CACHE_TTL = 12 * 3600 * 1000;

/* Flags de TDTChannels que indican que el flujo no se puede reproducir desde un
 * navegador/AVPlay sin cabeceras especiales (Referer, User-Agent) o no navegable. */
var BAD_FLAGS = /^(NONAV|NOEM|REF|REFI\d*|REFC\d*|UAG|UAGB)$/;

/* Orden de ámbitos: primero los nacionales clave y Andalucía. */
var AMBIT_ORDER = ["Generalistas", "Informativos", "Infantiles", "Deportivos", "Andalucía"];

/* Dentro de Andalucía, estos primero (en este orden). */
var ANDALUCIA_FIRST = [/^canal sur andaluc/i, /^canal sur 2/i, /^canal sur/i, /^7tv sevilla/i, /^7tv andaluc/i];

/* ================= Accesos directos ================= */
var APPS = [
  {
    key: "atresplayer", name: "Atresplayer", re: /atres\s*player/i,
    desc: "Antena 3, laSexta, Neox, Nova… en directo gratis"
  },
  {
    key: "mitele", name: "Mediaset Infinity", re: /mitele|mediaset|infinity/i,
    desc: "Telecinco, Cuatro, FDF, Energy… en directo gratis"
  },
  {
    key: "tivify", name: "Tivify", re: /tivify/i,
    desc: "Toda la TDT en una app · Antena 3 y Telecinco solo en Plus (de pago)"
  }
];

/* ================= Estado ================= */
var S = {
  el: null,
  grid: null,
  channels: [],      // lista plana ordenada; num = índice + 1
  byId: {},
  favs: App.store.get(FAVS_KEY, []),
  loading: false,
  playingId: null,
  digitBuf: "",
  digitTimer: null,
  fromCache: false,
  stale: false
};

/* ================= Utilidades ================= */
function slug(s){
  return String(s || "").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function isHttpUrl(u){ return /^https?:\/\//i.test(String(u || "")); }
function isHlsUrl(u){ return /\.m3u8(\?|$)/i.test(String(u || "")); }
/* URLs con plantillas tipo [IP] o [DEVICE_ID] (redes de anuncios) no funcionan tal cual */
function hasPlaceholders(u){ return /\[[A-Z_]+\]/.test(String(u || "")); }

/* ================= Parsers ================= */
function parseTDT(json){
  var out = [];
  (json.countries || []).forEach(function(country){
    (country.ambits || []).forEach(function(ambit){
      (ambit.channels || []).forEach(function(ch){
        var flags = ch.extra_info || [];
        for(var f = 0; f < flags.length; f++){ if(BAD_FLAGS.test(flags[f])) return; }
        var urls = (ch.options || []).filter(function(o){
          if(!o || !isHttpUrl(o.url) || hasPlaceholders(o.url)) return false;
          if(o.format === "m3u8") return true;
          if(o.format === "stream") return isHlsUrl(o.url);
          return false;
        }).map(function(o){ return o.url; });
        if(!urls.length) return;
        out.push({
          name: ch.name || "Canal",
          logo: ch.logo || "",
          url: urls[0],
          urls: urls,
          ambit: ambit.name || "Otros",
          country: country.name || "",
          geo: flags.indexOf("GEO") >= 0,
          epg: ch.epg_id || ""
        });
      });
    });
  });
  return out;
}

function attr(line, name){
  var m = line.match(new RegExp(name + '="([^"]*)"', "i"));
  return m ? m[1] : "";
}
function parseM3U(text){
  var out = [];
  var lines = String(text).split(/\r?\n/);
  var cur = null;
  for(var i = 0; i < lines.length; i++){
    var line = lines[i].trim();
    if(!line) continue;
    if(/^#EXTINF/i.test(line)){
      var comma = line.lastIndexOf(",");
      cur = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : "Canal",
        logo: attr(line, "tvg-logo"),
        ambit: attr(line, "group-title") || "Otros",
        epg: attr(line, "tvg-id")
      };
    } else if(line.charAt(0) === "#"){
      continue;
    } else if(cur){
      if(isHttpUrl(line) && !hasPlaceholders(line)){
        out.push({ name: cur.name, logo: cur.logo, url: line, urls: [line],
                   ambit: cur.ambit, country: "", geo: false, epg: cur.epg });
      }
      cur = null;
    }
  }
  return out;
}

/* ================= Orden ================= */
function ambitRank(a){
  var i = AMBIT_ORDER.indexOf(a.name);
  if(i >= 0) return i;
  // España antes que internacional, respetando el orden de la fuente
  return (a.country && a.country !== "Spain" ? 1000 : 100) + a.first;
}
function andaluciaRank(name){
  for(var i = 0; i < ANDALUCIA_FIRST.length; i++){ if(ANDALUCIA_FIRST[i].test(name)) return i; }
  return 99;
}

function organize(list){
  // Agrupar por ámbito conservando el orden de aparición
  var ambits = [], byName = {};
  list.forEach(function(ch, idx){
    var k = ch.country + "|" + ch.ambit;
    var a = byName[k];
    if(!a){ a = byName[k] = { name: ch.ambit, country: ch.country, first: ambits.length, items: [] }; ambits.push(a); }
    ch._src = idx;
    a.items.push(ch);
  });
  ambits.sort(function(x, y){ return ambitRank(x) - ambitRank(y); });
  ambits.forEach(function(a){
    if(a.name === "Andalucía"){
      a.items.sort(function(x, y){ return (andaluciaRank(x.name) - andaluciaRank(y.name)) || (x._src - y._src); });
    }
  });
  // Lista plana numerada + ids únicos
  var flat = [], seen = {};
  ambits.forEach(function(a){
    a.items.forEach(function(ch){
      var id = slug(ch.epg || ch.name) || "canal";
      if(seen[id]){ var n = 2; while(seen[id + "-" + n]) n++; id = id + "-" + n; }
      seen[id] = true;
      ch.id = id;
      ch.num = flat.length + 1;
      delete ch._src;
      flat.push(ch);
    });
  });
  return flat;
}

/* ================= Carga ================= */
function fetchList(url){
  return fetch(url).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function(text){
    var t = text.replace(/^﻿/, "").trim();
    var list;
    if(/\.m3u8?(\?|$)/i.test(url) || /^#EXTM3U/i.test(t)) list = parseM3U(t);
    else list = parseTDT(JSON.parse(t));
    if(!list.length) throw new Error("La lista no tiene canales reproducibles");
    return organize(list);
  });
}

function load(force){
  var url = App.settings.get("liveListUrl") || "https://www.tdtchannels.com/lists/tv.json";
  var cache = App.store.get(CACHE_KEY, null);
  var cacheOk = cache && cache.url === url && cache.channels && cache.channels.length;
  if(!force && cacheOk && Date.now() - cache.t < CACHE_TTL){
    setChannels(cache.channels, true, false);
    return Promise.resolve();
  }
  S.loading = true;
  if(!S.channels.length) App.ui.loading(S.el, "Cargando canales…");
  return fetchList(url).then(function(channels){
    S.loading = false;
    App.store.set(CACHE_KEY, { t: Date.now(), url: url, channels: channels });
    setChannels(channels, false, false);
    if(force) App.ui.toast("Lista actualizada · " + channels.length + " canales");
  }).catch(function(e){
    S.loading = false;
    console.warn("[live]", e);
    if(cacheOk){
      setChannels(cache.channels, true, true);
      App.ui.toast("Sin conexión con la lista: uso la copia guardada");
    } else if(!S.channels.length){
      renderError(e.message);
    } else {
      App.ui.toast("No se pudo recargar la lista: " + e.message);
    }
  });
}

function setChannels(list, fromCache, stale){
  S.channels = list;
  S.byId = {};
  list.forEach(function(ch){ S.byId[ch.id] = ch; });
  S.fromCache = fromCache; S.stale = stale;
  render();
}

/* ================= Render ================= */
function appCard(a){
  return '<div class="live-card live-app focusable" data-kind="app" data-key="' + a.key + '">' +
           '<div class="live-app-name">' + App.esc(a.name) + '</div>' +
           '<div class="live-app-desc">' + App.esc(a.desc) + '</div>' +
         '</div>';
}

function chCard(ch){
  var fav = S.favs.indexOf(ch.id) >= 0;
  var logo = ch.logo
    ? '<img class="live-logo" src="' + App.esc(ch.logo) + '" alt="" loading="lazy">'
    : '<span class="live-initials" style="' + App.ui.placeholderStyle(ch.name) + '">' + App.esc(App.ui.initials(ch.name)) + '</span>';
  return '<div class="live-card live-ch focusable' + (ch.id === S.playingId ? ' playing' : '') +
           '" data-kind="ch" data-id="' + App.esc(ch.id) + '">' +
           '<div class="live-thumb">' + logo +
             '<span class="live-num num">' + ch.num + '</span>' +
             (fav ? '<span class="live-fav">★</span>' : '') +
           '</div>' +
           '<div class="live-name">' + App.esc(ch.name) + '</div>' +
         '</div>';
}

function render(){
  var prevKey = currentKey();
  var html = '<div class="scroll live-scroll">';

  html += '<div class="section-title">Apps oficiales <span class="muted">Antena 3, Telecinco y demás canales con DRM</span></div>';
  html += '<div class="live-row">' + APPS.map(appCard).join("") + '</div>';

  var favs = S.favs.map(function(id){ return S.byId[id]; }).filter(Boolean);
  if(favs.length){
    html += '<div class="section-title">Favoritos</div>';
    html += '<div class="live-grid">' + favs.map(chCard).join("") + '</div>';
  }

  var lastAmbit = null, open = false;
  S.channels.forEach(function(ch){
    var k = ch.country + "|" + ch.ambit;
    if(k !== lastAmbit){
      if(open) html += '</div>';
      var count = 0;
      for(var i = 0; i < S.channels.length; i++){ if(S.channels[i].country + "|" + S.channels[i].ambit === k) count++; }
      html += '<div class="section-title">' + App.esc(ch.ambit) + ' <span class="muted num">' + count + '</span></div>';
      html += '<div class="live-grid">';
      open = true; lastAmbit = k;
    }
    html += chCard(ch);
  });
  if(open) html += '</div>';

  if(S.stale) html += '<p class="live-note muted">Mostrando la copia guardada de la lista (sin conexión). ROJO para reintentar.</p>';
  html += '<p class="live-note muted">Canales de TDTChannels. Algunos solo funcionan desde España (marca GEO) y otros pueden caerse sin aviso.</p>';
  html += '</div>';

  S.el.innerHTML = html;
  S.grid = new App.ui.FocusGrid(S.el.querySelector(".live-scroll"), { onSelect: onSelect });
  restoreFocus(prevKey);
}

function renderError(msg){
  S.el.innerHTML =
    '<div class="scroll live-scroll">' +
      '<div class="section-title">Apps oficiales</div>' +
      '<div class="live-row">' + APPS.map(appCard).join("") + '</div>' +
      '<div class="live-error"><h2>No se pudo cargar la lista de canales</h2>' +
      '<p class="muted">' + App.esc(msg || "") + '</p><p class="muted">Pulsa ROJO para reintentar o cambia la URL de la lista en Ajustes.</p></div>' +
    '</div>';
  S.grid = new App.ui.FocusGrid(S.el.querySelector(".live-scroll"), { onSelect: onSelect });
  S.grid.focus(0, true);
}

function currentKey(){
  var el = S.grid && S.grid.current();
  if(!el) return null;
  return el.dataset.kind === "app" ? "app:" + el.dataset.key : "ch:" + el.dataset.id;
}
function findIndex(key){
  if(!S.grid || !key) return -1;
  for(var i = 0; i < S.grid.items.length; i++){
    var el = S.grid.items[i];
    var k = el.dataset.kind === "app" ? "app:" + el.dataset.key : "ch:" + el.dataset.id;
    if(k === key) return i;
  }
  return -1;
}
function restoreFocus(key){
  if(!S.grid) return;
  var i = findIndex(key);
  if(i < 0 && S.playingId) i = findIndex("ch:" + S.playingId);
  if(i < 0){
    // por defecto: primer canal (salta la fila de apps)
    i = 0;
    for(var j = 0; j < S.grid.items.length; j++){ if(S.grid.items[j].dataset.kind === "ch"){ i = j; break; } }
  }
  if(document.body.classList.contains("zone-header")){ S.grid.index = i; S.grid.blur(); }
  else S.grid.focus(i, true);
}

/* Logos rotos → iniciales */
function onImgError(ev){
  var img = ev.target;
  if(!img || img.tagName !== "IMG" || !img.classList.contains("live-logo")) return;
  var card = img.closest ? img.closest(".live-card") : null;
  var name = card ? (card.querySelector(".live-name") || {}).textContent : "";
  var span = document.createElement("span");
  span.className = "live-initials";
  span.setAttribute("style", App.ui.placeholderStyle(name));
  span.textContent = App.ui.initials(name);
  img.parentNode.replaceChild(span, img);
}

/* ================= Acciones ================= */
function onSelect(i, el){
  if(el.dataset.kind === "app") launchApp(el.dataset.key);
  else playChannel(S.byId[el.dataset.id]);
}

function playChannel(ch){
  if(!ch) return;
  if(!App.player || !App.player.play){ App.hint("El reproductor no está disponible"); return; }
  S.playingId = ch.id;
  markPlaying();
  App.player.play({
    title: ch.num + " · " + ch.name,
    subtitle: ch.ambit + (ch.geo ? " · solo España" : ""),
    url: ch.url,
    urls: ch.urls,
    key: "live:" + ch.id,
    live: true,
    poster: ch.logo,
    onChannel: function(dir){ zap(dir); },
    onDigit: function(n){ pushDigit(n); }
  });
}

function markPlaying(){
  if(!S.el) return;
  var cards = S.el.querySelectorAll(".live-ch");
  for(var i = 0; i < cards.length; i++) cards[i].classList.toggle("playing", cards[i].dataset.id === S.playingId);
  // dejar el foco en el canal en reproducción para cuando se cierre el reproductor
  var idx = findIndex("ch:" + S.playingId);
  if(idx >= 0 && S.grid){ S.grid.index = idx; S.grid.paint(); }
}

function zap(dir){
  if(!S.channels.length) return;
  var cur = S.byId[S.playingId];
  var i = cur ? cur.num - 1 : -1;
  var n = S.channels.length;
  var next = S.channels[((i + dir) % n + n) % n];
  playChannel(next);
}

function pushDigit(n){
  if(n < 0 || n > 9) return;
  S.digitBuf = (S.digitBuf + n).slice(-4);
  App.ui.toast("Canal " + S.digitBuf + "…", 1600);
  clearTimeout(S.digitTimer);
  S.digitTimer = setTimeout(function(){
    var num = parseInt(S.digitBuf, 10);
    S.digitBuf = "";
    var ch = S.channels[num - 1];
    if(ch) playChannel(ch);
    else App.ui.toast("No existe el canal " + num);
  }, 1500);
}

function toggleFav(){
  var el = S.grid && S.grid.current();
  if(!el || el.dataset.kind !== "ch"){ App.hint("Elige un canal para marcarlo como favorito"); return; }
  var id = el.dataset.id;
  var i = S.favs.indexOf(id);
  if(i >= 0){ S.favs.splice(i, 1); App.ui.toast("Quitado de favoritos"); }
  else { S.favs.push(id); App.ui.toast("Añadido a favoritos ★"); }
  App.store.set(FAVS_KEY, S.favs);
  render();
}

/* ----- Lanzar apps oficiales ----- */
function appDef(key){
  for(var i = 0; i < APPS.length; i++) if(APPS[i].key === key) return APPS[i];
  return null;
}
function saveAppId(key, id){
  var ids = Object.assign({}, App.settings.get("appIds") || {});
  if(id) ids[key] = id; else delete ids[key];
  App.settings.set("appIds", ids);
}
function findInstalled(def){
  return new Promise(function(resolve){
    try{
      tizen.application.getAppsInfo(function(list){
        var hit = null;
        for(var i = 0; i < list.length; i++){
          var a = list[i];
          if(def.re.test(a.name || "") || def.re.test(a.id || "")){ hit = a.id; break; }
        }
        resolve(hit);
      }, function(){ resolve(null); });
    }catch(e){ resolve(null); }
  });
}
function launchId(id){
  return new Promise(function(resolve, reject){
    try{ tizen.application.launch(id, resolve, reject); }catch(e){ reject(e); }
  });
}
function notFound(def){
  var extra = def.key === "tivify"
    ? "<p>Tivify reúne la TDT en una sola app, pero Antena 3, Telecinco y el resto de Atresmedia/Mediaset solo están en Tivify Plus (de pago). Para verlos gratis usa Atresplayer y Mediaset Infinity.</p>"
    : "";
  App.ui.modal({
    title: "No encuentro " + def.name,
    html: "<p>No encuentro " + App.esc(def.name) + " instalada. Instálala desde la tienda de Samsung o indica su ID en Ajustes.</p>" + extra,
    buttons: [{ label: "Entendido", value: true }]
  });
}

function launchApp(key){
  var def = appDef(key);
  if(!def) return;
  if(!(window.tizen && tizen.application && tizen.application.launch)){
    App.hint("Los accesos directos solo funcionan en la TV (Tizen): abren " + def.name, 4500);
    return;
  }
  var saved = (App.settings.get("appIds") || {})[key];
  var tried = {};

  function attempt(id){
    if(!id || tried[id]) return Promise.reject(new Error("sin id"));
    tried[id] = true;
    return launchId(id);
  }

  App.ui.toast("Abriendo " + def.name + "…");
  attempt(saved)
    .catch(function(){
      if(saved) saveAppId(key, null);          // id guardado ya no vale
      return findInstalled(def).then(function(id){
        if(!id) throw new Error("no instalada");
        saveAppId(key, id);
        return attempt(id);
      });
    })
    .catch(function(e){
      console.warn("[live] launch " + key, e);
      notFound(def);
    });
}

/* ================= Pantalla ================= */
App.screens.register({
  id: "live", label: "TV", nav: true, order: 30,
  hint: "OK ver · VERDE favorito · ROJO recargar · CH+/CH- en reproducción",
  mount: function(el){
    S.el = el;
    el.addEventListener("error", onImgError, true);
  },
  show: function(params){
    if(params && params._back && S.grid){ restoreFocus(currentKey()); return; }
    if(!S.channels.length && !S.loading) load(false);
    else if(S.grid) restoreFocus(currentKey());
  },
  hide: function(){
    clearTimeout(S.digitTimer); S.digitBuf = "";
  },
  focus: function(){
    if(!S.grid) return;
    S.grid.refresh(false);
    S.grid.focus(S.grid.index, true);
  },
  blur: function(){ if(S.grid) S.grid.blur(); },
  onKey: function(k){
    if(k === K.RED){ load(true); return true; }
    if(k === K.GREEN){ toggleFav(); return true; }
    var d = App.digit(k);
    if(d >= 0 && S.channels.length){ pushDigit(d); return true; }
    if(S.grid) return S.grid.handleKey(k);
    return false;
  }
});

/* Exponer para pruebas / otros módulos */
App.live = {
  parseTDT: parseTDT,
  parseM3U: parseM3U,
  organize: organize,
  reload: function(){ return load(true); },
  channels: function(){ return S.channels.slice(); }
};

})();
