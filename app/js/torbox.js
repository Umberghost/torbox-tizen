/* torbox.js — cliente de la API de TorBox. search.js añade search/addMagnet/etc. */
(function(){
"use strict";

var App = window.App;
var API = "https://api.torbox.app/v1/api";

var tb = App.torbox = App.torbox || {};
tb.API = API;
tb.SOURCES = ["torrents", "usenet", "webdl"];
tb.SOURCE_LABEL = { torrents: "Torrents", usenet: "Usenet", webdl: "Web" };
tb.ID_FIELD = { torrents: "torrent_id", usenet: "usenet_id", webdl: "web_id" };

function token(){ return App.settings.get("torboxToken") || ""; }
tb.token = token;
tb.hasToken = function(){ return !!token(); };

/* opts: {method, body (objeto → JSON), form (objeto → FormData), headers, base} */
tb.api = function(path, opts){
  opts = opts || {};
  var headers = opts.headers || {};
  headers["Authorization"] = "Bearer " + token();
  var body;
  if(opts.form){
    body = new FormData();
    Object.keys(opts.form).forEach(function(k){
      if(opts.form[k] !== undefined && opts.form[k] !== null) body.append(k, opts.form[k]);
    });
  } else if(opts.urlencoded){
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = Object.keys(opts.urlencoded).filter(function(k){
      return opts.urlencoded[k] !== undefined && opts.urlencoded[k] !== null;
    }).map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(opts.urlencoded[k]); }).join("&");
  } else if(opts.body){
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return App.net.fetch((opts.base || API) + path, { method: opts.method || "GET", headers: headers, body: body })
    .then(function(r){
      return r.text().then(function(txt){
        var j; try{ j = txt ? JSON.parse(txt) : {}; }catch(e){ j = { detail: txt }; }
        if(!r.ok || j.success === false){
          var err = new Error((j && (j.detail || j.error)) || ("HTTP " + r.status));
          err.status = r.status; err.body = j;
          console.warn("[TorBox API] " + (opts.method || "GET") + " " + path.split("?")[0] + " → " + r.status + " " + err.message);
          throw err;
        }
        return j;
      });
    });
};

function isFinished(d){
  if(!d) return false;
  if(d.download_finished === true) return true;
  if(d.download_finished === false) return false;
  return d.download_state === "completed" || d.download_state === "cached" || d.progress === 1;
}
tb.isFinished = isFinished;

/* Cache en memoria de 60 s para no repetir peticiones al cambiar de pantalla */
var cache = {};
tb.invalidate = function(){ cache = {}; };

tb.list = function(source, opts){
  opts = opts || {};
  var ck = source + (opts.all ? ":all" : "");
  var c = cache[ck];
  if(c && Date.now() - c.t < 60000 && !opts.fresh) return Promise.resolve(c.v);
  return tb.api("/" + source + "/mylist?bypass_cache=" + (opts.fresh ? "true" : "false"))
    .then(function(j){
      var data = j.data || [];
      if(!Array.isArray(data)) data = [data];
      data.forEach(function(d){ if(d) d._source = source; });
      if(!opts.all){
        data = data.filter(function(d){ return d && d.files && d.files.length && isFinished(d); });
      }
      cache[ck] = { t: Date.now(), v: data };
      return data;
    });
};

/* Las 3 fuentes juntas; una fuente que falle no tumba las demás. */
tb.allLibrary = function(opts){
  return Promise.all(tb.SOURCES.map(function(s){
    return tb.list(s, opts).catch(function(e){ console.warn("[torbox] " + s, e); return []; });
  })).then(function(lists){
    var out = [];
    lists.forEach(function(l){ out = out.concat(l); });
    out.sort(function(a, b){
      return String(b.created_at || b.updated_at || "").localeCompare(String(a.created_at || a.updated_at || ""));
    });
    return out;
  });
};

tb.link = function(source, itemId, fileId){
  var q = "/" + source + "/requestdl?token=" + encodeURIComponent(token()) +
          "&" + tb.ID_FIELD[source] + "=" + encodeURIComponent(itemId) +
          "&file_id=" + encodeURIComponent(fileId) + "&redirect=false";
  return App.net.fetch(API + q).then(function(r){ return r.json(); }).then(function(j){
    if(j.success === false || !j.data) throw new Error(j.detail || App.t("torbox.noLink"));
    return j.data;
  });
};

/* ---------------- Añadir / controlar (campos según api.torbox.app/openapi.json) ---------------- */

/* checkCached(hashes) → Promise<{hash: true}> */
tb.checkCached = function(hashes){
  hashes = (hashes || []).filter(Boolean).slice(0, 100);
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
tb.addWeb = function(link, name){
  return tb.api("/webdl/createwebdownload", { method: "POST", urlencoded: { link: link, name: name || undefined } })
    .then(function(j){ tb.invalidate(); return j.data || {}; });
};
/* Detecta el tipo de enlace: magnet / hash → torrent, .nzb → usenet, resto → descarga web */
tb.linkKind = function(link){
  link = String(link || "").trim();
  if(/^magnet:\?/i.test(link) || /^[a-f0-9]{40}$/i.test(link)) return "torrents";
  if(/\.nzb(\?|$)/i.test(link) || /nzb/i.test(link.split("?")[0].split("/").pop() || "")) return "usenet";
  if(/^https?:\/\//i.test(link)) return "webdl";
  return null;
};
tb.addLink = function(link, name){
  link = String(link || "").trim();
  var kind = tb.linkKind(link);
  if(kind === "torrents"){
    if(/^[a-f0-9]{40}$/i.test(link)) link = "magnet:?xt=urn:btih:" + link;
    return tb.addMagnet(link, name).then(function(d){ return { kind: kind, data: d }; });
  }
  if(kind === "usenet") return tb.addUsenet(link, name).then(function(d){ return { kind: kind, data: d }; });
  if(kind === "webdl") return tb.addWeb(link, name).then(function(d){ return { kind: kind, data: d }; });
  return Promise.reject(new Error(App.t("torbox.badLink")));
};

/* control(source, id, operation): operation ∈ delete | pause | resume | reannounce */
var CONTROL = {
  torrents: { path: "/torrents/controltorrent", field: "torrent_id" },
  usenet:   { path: "/usenet/controlusenetdownload", field: "usenet_id" },
  webdl:    { path: "/webdl/controlwebdownload", field: "webdl_id" }
};
tb.control = function(source, id, operation){
  var c = CONTROL[source];
  if(!c) return Promise.reject(new Error(App.t("torbox.badSource")));
  var body = { operation: operation };
  body[c.field] = id;
  return tb.api(c.path, { method: "POST", body: body }).then(function(j){ tb.invalidate(); return j; });
};

/* Clave estable para historial */
tb.key = function(source, itemId, fileId){ return source + ":" + itemId + ":" + fileId; };

})();
