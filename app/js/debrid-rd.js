/* debrid-rd.js — compatibilidad con Real-Debrid, A LA VEZ que TorBox.
 *
 * Real-Debrid es una fuente más ("rd") junto a torrents/usenet/webdl de TorBox: App.torbox.SOURCES
 * incluye las de cada cuenta configurada (torboxToken y/o rdToken) y list/link/control se enrutan por
 * la fuente de cada item. Los datos de Real-Debrid se devuelven con la MISMA forma que TorBox
 * (files[], download_finished, progress 0–1…), así que las pantallas no cambian.
 * `debridProvider` ("torbox" | "realdebrid") = cuenta a la que se AÑADEN los torrents nuevos.
 *
 * API: https://api.real-debrid.com/rest/1.0 (Bearer token, CORS abierto).
 * Limitaciones de Real-Debrid: sin Usenet, sin pausar/reanudar, y desde nov. 2024 no ofrece
 * consulta de caché (instantAvailability) → checkCached devuelve {}.
 */
(function(){
"use strict";
var App = window.App;
var API = "https://api.real-debrid.com/rest/1.0";
var tb = App.torbox;

App.settings.define("debridProvider", "torbox");
App.settings.define("rdToken", "");

function isRD(){ return App.settings.get("debridProvider") === "realdebrid"; }
function rdToken(){ return App.settings.get("rdToken") || ""; }

function hasTB(){ return !!(App.settings.get("torboxToken") || ""); }
function hasRDt(){ return !!rdToken(); }
/* Cuenta destino para añadir: la elegida si está configurada; si no, la que haya */
function addToRD(){ return (isRD() && hasRDt()) || (!hasTB() && hasRDt()); }

App.debrid = {
  provider: function(){ return addToRD() ? "realdebrid" : "torbox"; },
  name: function(){ return addToRD() ? "Real-Debrid" : "TorBox"; },
  isRD: isRD,
  hasTorbox: hasTB,
  hasRD: hasRDt,
  rdAccount: function(){ return RD.account().then(function(j){ return j.data; }); }
};

/* ---------- Llamadas ---------- */
function rd(path, opts){
  opts = opts || {};
  var headers = { "Authorization": "Bearer " + rdToken() };
  var body;
  if(opts.form){
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = Object.keys(opts.form).map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(opts.form[k]); }).join("&");
  }
  return App.net.fetch(API + path, { method: opts.method || "GET", headers: headers, body: body }).then(function(r){
    if(r.status === 204) return {};
    return r.text().then(function(txt){
      var j; try{ j = txt ? JSON.parse(txt) : {}; }catch(e){ j = { error: txt }; }
      if(!r.ok){
        var err = new Error((j && (j.error || j.message)) || ("HTTP " + r.status));
        err.status = r.status; err.body = j;
        console.warn("[Real-Debrid] " + (opts.method || "GET") + " " + path.split("?")[0] + " → " + r.status + " " + err.message);
        throw err;
      }
      return j;
    });
  });
}

/* ---------- Conversión al formato de TorBox ---------- */
var STATE = {
  downloaded: "completed", downloading: "downloading", queued: "queued", uploading: "uploading",
  compressing: "downloading", magnet_conversion: "metaDL", waiting_files_selection: "metaDL",
  magnet_error: "error", error: "error", virus: "error", dead: "stalled (no seeds)"
};
var infoCache = {};   // id → info (los torrents terminados no cambian)

function toItem(t, info){
  var done = t.status === "downloaded";
  var files = [];
  if(info && info.files){
    info.files.filter(function(f){ return f.selected; }).forEach(function(f){
      var name = String(f.path || "").replace(/^\//, "");
      files.push({ id: f.id, name: name, short_name: name.split("/").pop(), size: f.bytes });
    });
  }
  var added = t.added ? new Date(t.added).toISOString() : "";
  return {
    id: t.id, hash: String(t.hash || "").toLowerCase(), name: t.filename || t.original_filename || t.id,
    size: t.bytes || 0, files: files,
    download_finished: done, download_state: STATE[t.status] || t.status,
    progress: (Number(t.progress) || 0) / 100, download_speed: t.speed || 0,
    eta: (t.speed && t.bytes && t.progress < 100) ? Math.round(t.bytes * (1 - t.progress / 100) / t.speed) : 0,
    seeds: t.seeders || 0, created_at: added, updated_at: t.ended || added,
    _source: "rd", _rd: true
  };
}

function info(id){
  if(infoCache[id]) return Promise.resolve(infoCache[id]);
  return rd("/torrents/info/" + encodeURIComponent(id)).then(function(j){
    if(j && j.status === "downloaded") infoCache[id] = j;
    return j;
  });
}

/* Cola simple para no lanzar decenas de peticiones a la vez */
function mapLimit(arr, n, fn){
  var out = new Array(arr.length), i = 0;
  function worker(){
    if(i >= arr.length) return Promise.resolve();
    var k = i++;
    return Promise.resolve(fn(arr[k], k)).then(function(v){ out[k] = v; }, function(){ out[k] = null; }).then(worker);
  }
  var ws = []; for(var w = 0; w < Math.min(n, arr.length); w++) ws.push(worker());
  return Promise.all(ws).then(function(){ return out; });
}

var listCache = null;
var RD = {
  hasToken: function(){ return !!rdToken(); },
  invalidate: function(){ listCache = null; },
  list: function(source, opts){
    opts = opts || {};
    if(source !== "rd" || !hasRDt()) return Promise.resolve([]);
    if(listCache && Date.now() - listCache.t < 60000 && !opts.fresh){
      return Promise.resolve(opts.all ? listCache.all : listCache.all.filter(function(d){ return d.download_finished && d.files.length; }));
    }
    return rd("/torrents?limit=200").then(function(arr){
      arr = Array.isArray(arr) ? arr : [];
      return mapLimit(arr, 4, function(t){
        return t.status === "downloaded" ? info(t.id).then(function(inf){ return toItem(t, inf); }) : toItem(t, null);
      });
    }).then(function(items){
      items = items.filter(Boolean);
      listCache = { t: Date.now(), all: items };
      return opts.all ? items : items.filter(function(d){ return d.download_finished && d.files.length; });
    });
  },
  /* Enlace de reproducción: el link "restringido" del archivo → /unrestrict/link */
  link: function(source, itemId, fileId){
    return info(itemId).then(function(inf){
      var sel = (inf.files || []).filter(function(f){ return f.selected; });
      var idx = -1;
      sel.forEach(function(f, i){ if(String(f.id) === String(fileId)) idx = i; });
      var links = inf.links || [];
      // Si Real-Debrid empaquetó en un único enlace (RAR), solo hay uno
      var restricted = links[idx] || (links.length === 1 ? links[0] : null);
      if(!restricted) throw new Error(App.t("rd.noLink"));
      return rd("/unrestrict/link", { method: "POST", form: { link: restricted } });
    }).then(function(u){
      if(!u || !u.download) throw new Error(App.t("rd.noLink"));
      return u.download;
    });
  },
  checkCached: function(){ return Promise.resolve({}); },
  addMagnet: function(magnet){
    return rd("/torrents/addMagnet", { method: "POST", form: { magnet: magnet } }).then(function(j){
      if(!j || !j.id) throw new Error(App.t("rd.addFailed"));
      // Real-Debrid exige elegir archivos: se eligen todos
      return rd("/torrents/selectFiles/" + encodeURIComponent(j.id), { method: "POST", form: { files: "all" } })
        .catch(function(e){ console.warn("[Real-Debrid] selectFiles:", e.message); })
        .then(function(){ RD.invalidate(); return { id: j.id, hash: "" }; });
    });
  },
  addLink: function(link, name){
    link = String(link || "").trim();
    var kind = tb.linkKind(link);
    if(kind === "torrents"){
      if(/^[a-f0-9]{40}$/i.test(link)) link = "magnet:?xt=urn:btih:" + link;
      return RD.addMagnet(link, name).then(function(d){ return { kind: kind, data: d }; });
    }
    return Promise.reject(new Error(App.t("rd.onlyTorrents")));
  },
  control: function(source, id, operation){
    if(operation === "delete"){
      delete infoCache[id];
      return rd("/torrents/delete/" + encodeURIComponent(id), { method: "DELETE" }).then(function(j){ RD.invalidate(); return j; });
    }
    return Promise.reject(new Error(App.t("rd.notSupported")));
  },
  /* Cuenta: se traduce al formato de /user/me de TorBox que usa Ajustes */
  account: function(){
    return rd("/user").then(function(u){
      return { data: {
        plan: u.type === "premium" ? "rd_premium" : "rd_free",
        premium_expires_at: u.expiration || null,
        email: u.email || "", username: u.username || "", points: u.points
      } };
    });
  }
};

/* ---------- Enrutado: Real-Debrid es la fuente "rd"; lo demás sigue en TorBox ---------- */
tb.SOURCE_LABEL.rd = "Real-Debrid";
var TB_SOURCES = tb.SOURCES.slice();
Object.defineProperty(tb, "SOURCES", {
  configurable: true,
  get: function(){
    var out = hasTB() ? TB_SOURCES.slice() : [];
    if(hasRDt()) out.push("rd");
    return out.length ? out : TB_SOURCES.slice();
  }
});
var O = {};
["hasToken", "invalidate", "list", "link", "checkCached", "addMagnet", "addLink", "control", "addUsenet", "addWeb", "api"]
  .forEach(function(m){ O[m] = tb[m]; });
tb.hasToken = function(){ return hasTB() || hasRDt(); };
tb.invalidate = function(){ RD.invalidate(); return O.invalidate.apply(tb, arguments); };
tb.list = function(source){ return source === "rd" ? RD.list.apply(RD, arguments) : O.list.apply(tb, arguments); };
tb.link = function(source){ return source === "rd" ? RD.link.apply(RD, arguments) : O.link.apply(tb, arguments); };
tb.control = function(source){ return source === "rd" ? RD.control.apply(RD, arguments) : O.control.apply(tb, arguments); };
tb.checkCached = function(){ return hasTB() ? O.checkCached.apply(tb, arguments) : Promise.resolve({}); };
tb.addMagnet = function(){ return addToRD() ? RD.addMagnet.apply(RD, arguments) : O.addMagnet.apply(tb, arguments); };
tb.addLink = function(link){
  // Usenet y descargas web solo existen en TorBox; los magnets van a la cuenta destino
  if(addToRD() && tb.linkKind(link) === "torrents") return RD.addLink.apply(RD, arguments);
  if(!hasTB()) return RD.addLink.apply(RD, arguments);
  return O.addLink.apply(tb, arguments);
};
tb.addUsenet = function(){ return hasTB() ? O.addUsenet.apply(tb, arguments) : Promise.reject(new Error(App.t("rd.onlyTorrents"))); };
tb.addWeb = function(){ return hasTB() ? O.addWeb.apply(tb, arguments) : Promise.reject(new Error(App.t("rd.onlyTorrents"))); };
tb.api = function(path){
  if(!hasTB() && /^\/user\/me/.test(String(path))) return RD.account();
  if(!hasTB()) return Promise.reject(new Error(App.t("rd.notSupported")));
  return O.api.apply(tb, arguments);
};

App.bus.on("settings:change", function(c){
  if(c && (c.key === "debridProvider" || c.key === "rdToken")){ RD.invalidate(); tb.invalidate(); infoCache = {}; }
});

/* ---------- Ajustes ---------- */
if(App.settingsUI){
  App.settingsUI.add("settings.group.account", {
    id: "debridProvider", type: "menu",
    label: function(){ return App.t("rd.provider"); },
    desc: function(){ return App.t("rd.provider.desc"); },
    options: function(){ return [{ label: "TorBox", value: "torbox" }, { label: "Real-Debrid", value: "realdebrid" }]; },
    value: function(){ return App.debrid.name(); },
    after: function(){ tb.invalidate(); }
  });
  App.settingsUI.add("settings.group.account", {
    id: "rdToken", type: "secret",
    label: function(){ return App.t("rd.token"); },
    desc: function(){ return App.t("rd.token.desc"); },
    value: function(){ var v = rdToken(); return v ? v.slice(0, 4) + "••••" + v.slice(-4) : App.t("rd.notSet"); },
    after: function(){ tb.invalidate(); }
  });
}
})();
