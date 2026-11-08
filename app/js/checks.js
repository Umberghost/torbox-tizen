/* checks.js — comprobación de claves y direcciones al guardarlas en Ajustes (App.checks)
 * y prueba de velocidad (Ajustes → Sistema → Prueba de velocidad).
 *
 * App.checks.has(id) → bool
 * App.checks.run(id, value) → Promise<{ok, msg}>  (también muestra el aviso ✓ / ✗)
 */
(function(){
"use strict";

var App = window.App;
var t = function(k, p){ return App.t(k, p); };
var TIMEOUT = 15000;

function withTimeout(p, ms){
  return new Promise(function(resolve, reject){
    var done = false;
    var tm = setTimeout(function(){ if(!done){ done = true; var e = new Error(t("check.timeout")); e.timeout = true; reject(e); } }, ms || TIMEOUT);
    p.then(function(v){ if(!done){ done = true; clearTimeout(tm); resolve(v); } },
           function(e){ if(!done){ done = true; clearTimeout(tm); reject(e); } });
  });
}
function get(url, init){
  return withTimeout(App.net.fetch(url, init || {})).catch(function(e){
    if(e && e.timeout) throw e;
    var err = new Error(t("check.network")); err.network = true; throw err;
  });
}
function jsonOf(r){ return r.text().then(function(txt){ try{ return txt ? JSON.parse(txt) : {}; }catch(e){ return { _raw: txt }; } }); }
function badKey(){ var e = new Error(t("check.invalidKey")); e.key = true; return e; }
function addonBase(v){
  return String(v || "").trim().replace(/^stremio:\/\//i, "https://").replace(/\/manifest\.json.*$/i, "").replace(/\/+$/, "");
}

/* Validadores: devuelven Promise<string extra> si va bien o lanzan Error con el motivo */
var V = {
  torboxToken: { name: "TorBox", run: function(){
    return App.torbox.api("/user/me?settings=false").then(function(j){
      if(!j || j.success === false || !j.data) throw badKey();
      return j.data.email || "";
    }, function(e){
      if(e && (e.status === 401 || e.status === 403 || /auth|token|key/i.test(e.message || ""))) throw badKey();
      throw e;
    });
  } },
  rdToken: { name: "Real-Debrid", run: function(){
    if(!App.torbox.rdUser) return Promise.resolve("");
    return App.torbox.rdUser().then(function(u){
      return (u.username || "") + (u.type ? " · " + u.type : "");
    }, function(e){
      if(e && (e.status === 401 || e.status === 403)) throw badKey();
      throw e;
    });
  } },
  tmdbKey: { name: "TMDB", run: function(v){
    var bearer = v.length > 40;   // token de lectura (v4) frente a la clave API (v3)
    var url = "https://api.themoviedb.org/3/configuration" + (bearer ? "" : "?api_key=" + encodeURIComponent(v));
    return get(url, bearer ? { headers: { "Authorization": "Bearer " + v } } : {}).then(function(r){
      if(r.status === 401 || r.status === 403) throw badKey();
      if(!r.ok) throw new Error("HTTP " + r.status);
      return "";
    });
  } },
  omdbKey: { name: "OMDb", run: function(v){
    return get("https://www.omdbapi.com/?apikey=" + encodeURIComponent(v) + "&i=tt0111161").then(jsonOf).then(function(j){
      if(j.Response === "True") return "";
      if(/key/i.test(j.Error || "")) throw badKey();
      throw new Error(j.Error || t("check.unknown"));
    });
  } },
  traktClientId: { name: "Trakt", run: function(v){
    return get("https://api.trakt.tv/movies/trending?limit=1", { headers: {
      "Content-Type": "application/json", "trakt-api-key": v, "trakt-api-version": "2"
    } }).then(function(r){
      if(r.status === 401 || r.status === 403) throw badKey();
      if(!r.ok) throw new Error("HTTP " + r.status);
      return "";
    });
  } },
  stremioAddon: { name: "Add-on", run: function(v){
    var base = addonBase(v);
    if(!/^https?:\/\/[^\s\/]+\.[^\s]+/i.test(base)) return Promise.reject(new Error(t("check.badUrl")));
    return get(base + "/manifest.json").then(function(r){
      if(!r.ok) throw new Error(t("check.notAddon") + " (HTTP " + r.status + ")");
      return jsonOf(r);
    }).then(function(m){
      if(!m || !m.id || !m.resources) throw new Error(t("check.notAddon"));
      var res = (m.resources || []).map(function(x){ return typeof x === "string" ? x : x && x.name; });
      if(res.indexOf("stream") < 0) throw new Error(t("check.noStreams"));
      return m.name || "";
    });
  } },
  liveListUrl: { name: "M3U", run: function(v){
    if(!/^https?:\/\//i.test(v)) return Promise.reject(new Error(t("check.badUrl")));
    return get(v).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function(txt){
      // Formato M3U/M3U8 o JSON de TDTChannels (countries → ambits → channels), como en live.js
      var n = (txt.match(/#EXTINF/g) || []).length;
      if(/#EXTM3U/.test(txt.slice(0, 2000)) || n) return t("check.channels", { n: n });
      var j = null; try{ j = JSON.parse(txt); }catch(e){}
      if(j && Array.isArray(j.countries)){
        n = 0;
        j.countries.forEach(function(c){ (c.ambits || []).forEach(function(a){ n += (a.channels || []).length; }); });
        if(n) return t("check.channels", { n: n });
      }
      throw new Error(t("check.notM3u"));
    });
  } },
  accountServer: { name: "Faro", run: function(v){
    var base = String(v || "").trim().replace(/\/+$/, "");
    if(!/^https?:\/\//i.test(base)) return Promise.reject(new Error(t("check.badUrl")));
    return get(base + "/ping").then(function(r){ return r.ok ? jsonOf(r) : {}; }).then(function(j){
      if(!j || !j.accounts) throw new Error(t("check.notServer"));
      return j.version ? "v" + j.version : "";
    });
  } }
};

App.checks = {
  has: function(id){ return !!V[id]; },
  run: function(id, value){
    var c = V[id];
    value = String(value || "").trim();
    if(!c || !value) return Promise.resolve(null);
    App.ui.toast(t("check.checking", { what: c.name }), 15000);
    return c.run(value).then(function(extra){
      var msg = t("check.ok", { what: c.name }) + (extra ? " · " + extra : "");
      App.ui.toast(msg, 5000);
      console.info("[check] " + id + ": OK");
      return { ok: true, msg: msg };
    }, function(e){
      var msg = t("check.bad", { what: c.name, msg: (e && e.message) || t("check.unknown") });
      App.ui.toast(msg, 10000);
      console.warn("[check] " + id + ": " + (e && e.message));
      return { ok: false, msg: msg };
    });
  }
};

/* ======================= Prueba de velocidad ======================= */
var CF = "https://speed.cloudflare.com";
var DL_SECONDS = 8, DEBRID_SECONDS = 8, STREAMS = 4;

function mbps(bytes, ms){ return ms > 0 ? (bytes * 8 / 1000) / ms : 0; }   // bytes y ms → Mbit/s
function fmt(v){ return v >= 100 ? Math.round(v) : (Math.round(v * 10) / 10); }

/* Descarga en paralelo durante `secs` y devuelve Mbit/s. onTick(mbpsHastaAhora) */
function measure(urls, secs, onTick, headers, st){
  var total = 0, t0 = Date.now(), stopAt = t0 + secs * 1000;
  function one(url){
    return App.net.fetch(url, { cache: "no-store", headers: headers || {} }).then(function(r){
      if(!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
      if(!r.body || !r.body.getReader){
        return r.arrayBuffer().then(function(b){ total += b.byteLength; });
      }
      var rd = r.body.getReader();
      return (function pump(){
        if(st.cancel || Date.now() >= stopAt){ try{ rd.cancel(); }catch(e){} return null; }
        return rd.read().then(function(x){
          if(x.done) return null;
          total += x.value.byteLength;
          return pump();
        });
      })();
    });
  }
  var timer = setInterval(function(){ if(onTick) onTick(mbps(total, Date.now() - t0)); }, 400);
  return Promise.all(urls.map(function(u){ return one(u).catch(function(e){ return e; }); })).then(function(res){
    clearInterval(timer);
    var errs = res.filter(function(x){ return x instanceof Error; });
    if(errs.length === urls.length && !total) throw errs[0];
    return { mbps: mbps(total, Math.min(Date.now(), stopAt) - t0), bytes: total };
  });
}

function latency(st){
  var times = [];
  return (function next(i){
    if(i >= 6 || st.cancel){
      times.sort(function(a, b){ return a - b; });
      return times.length ? times[Math.floor(times.length / 2)] : null;
    }
    var t0 = Date.now();
    return fetch(CF + "/__down?bytes=0&r=" + Math.random(), { cache: "no-store" }).then(function(r){ return r.arrayBuffer(); }).then(function(){
      if(i > 0) times.push(Date.now() - t0);   // la 1ª incluye abrir la conexión
      return next(i + 1);
    }, function(){ return next(i + 1); });
  })(0);
}

/* Primer archivo de vídeo grande de la biblioteca (TorBox o Real-Debrid) → enlace directo */
function debridSample(){
  if(!App.torbox || !App.torbox.hasToken || !App.torbox.hasToken()) return Promise.resolve(null);
  return App.torbox.allLibrary().then(function(items){
    var pick = null;
    (items || []).some(function(it){
      var f = (it.files || []).filter(function(f){ return (f.size || 0) > 150e6 && /\.(mkv|mp4|avi|m4v|ts|webm)$/i.test(f.name || f.short_name || ""); })
        .sort(function(a, b){ return (b.size || 0) - (a.size || 0); })[0];
      if(f){ pick = { item: it, file: f }; return true; }
      return false;
    });
    if(!pick) return null;
    var src = pick.item._source || "torrents";
    return App.torbox.link(src, pick.item.id, pick.file.id).then(function(url){
      return { url: url, name: pick.file.short_name || pick.file.name || pick.item.name, source: src };
    });
  });
}

function verdict(v){
  if(v >= 100) return t("speed.v.remux");
  if(v >= 40) return t("speed.v.4k");
  if(v >= 15) return t("speed.v.1080");
  if(v >= 6) return t("speed.v.720");
  return t("speed.v.low");
}

function speedTest(){
  var st = { cancel: false };
  var res = { lat: null, net: null, deb: null, debName: "", debErr: "", netErr: "" };
  var phase = "lat", live = 0;
  var m = App.ui.modal({
    title: t("speed.title"), wide: true,
    html: '<div class="set-diag" id="spdBox"></div>',
    buttons: [{ label: t("ui.close"), value: true }],
    onClose: function(){ st.cancel = true; }
  });
  function row(label, val, cls){ return '<div class="set-diag-row"><b>' + App.esc(label) + '</b><span' + (cls ? ' class="' + cls + '"' : '') + '>' + App.esc(val) + '</span></div>'; }
  function paint(){
    var box = m.el.querySelector("#spdBox"); if(!box) return;
    var run = t("speed.running");
    var h = row(t("speed.latency"), res.lat !== null ? res.lat + " ms" : (phase === "lat" ? run : "—"));
    h += row(t("speed.internet"), res.net !== null ? fmt(res.net) + " Mbit/s" : res.netErr ? res.netErr : (phase === "net" ? run + " " + fmt(live) + " Mbit/s" : "—"));
    h += row(t("speed.debrid") + (res.debName ? " (" + res.debName.slice(0, 40) + ")" : ""),
             res.deb !== null ? fmt(res.deb) + " Mbit/s" : res.debErr ? res.debErr : (phase === "deb" ? run + " " + fmt(live) + " Mbit/s" : "—"));
    if(phase === "done"){
      var best = res.deb !== null ? res.deb : res.net;
      if(best !== null) h += '<div class="set-diag-sub">' + App.esc(t("speed.verdict")) + '</div><p>' + App.esc(verdict(best)) + '</p>';
      if(res.deb !== null && res.net !== null && res.deb < res.net * 0.5)
        h += '<p class="muted">' + App.esc(t("speed.debridSlower")) + '</p>';
      h += '<p class="muted">' + App.esc(t("speed.note")) + '</p>';
    }
    box.innerHTML = h;
  }
  paint();
  latency(st).then(function(ms){
    res.lat = ms; phase = "net"; live = 0; paint();
    if(st.cancel) return;
    var urls = [];
    for(var i = 0; i < STREAMS; i++) urls.push(CF + "/__down?bytes=200000000&r=" + Math.random());
    return measure(urls, DL_SECONDS, function(v){ live = v; paint(); }, null, st)
      .then(function(r){ res.net = r.mbps; }, function(e){ res.netErr = t("speed.failed", { msg: e.message }); });
  }).then(function(){
    if(st.cancel) return;
    phase = "deb"; live = 0; paint();
    return debridSample().then(function(s){
      if(!s){ res.debErr = t("speed.noFile"); return; }
      res.debName = s.name; paint();
      return measure([s.url], DEBRID_SECONDS, function(v){ live = v; paint(); }, { "Range": "bytes=0-" }, st)
        .then(function(r){ res.deb = r.mbps; });
    }).catch(function(e){ res.debErr = t("speed.failed", { msg: e.message }); });
  }).then(function(){
    phase = "done"; paint();
    console.info("[speed] latencia " + res.lat + " ms · internet " + (res.net !== null ? fmt(res.net) : "?") + " Mbit/s · debrid " + (res.deb !== null ? fmt(res.deb) : "?") + " Mbit/s");
  });
}

App.speedTest = speedTest;
App.settingsUI.add("settings.group.system", {
  id: "speedTest", type: "action",
  label: function(){ return t("speed.title"); },
  desc: function(){ return t("speed.desc"); },
  run: speedTest
});

})();
