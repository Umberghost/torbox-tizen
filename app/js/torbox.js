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
  } else if(opts.body){
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch((opts.base || API) + path, { method: opts.method || "GET", headers: headers, body: body })
    .then(function(r){
      return r.text().then(function(txt){
        var j; try{ j = txt ? JSON.parse(txt) : {}; }catch(e){ j = { detail: txt }; }
        if(!r.ok || j.success === false){
          var err = new Error((j && (j.detail || j.error)) || ("HTTP " + r.status));
          err.status = r.status; err.body = j;
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
  return fetch(API + q).then(function(r){ return r.json(); }).then(function(j){
    if(j.success === false || !j.data) throw new Error(j.detail || "Sin enlace de descarga");
    return j.data;
  });
};

/* Clave estable para historial */
tb.key = function(source, itemId, fileId){ return source + ":" + itemId + ":" + fileId; };

})();
