/* trakt.js — App.trakt: vinculación (device flow), scrobble automático y lista de seguimiento.
 * Ajustes: traktClientId, traktClientSecret (app propia del usuario en trakt.tv/oauth/applications),
 * traktAuth {access_token, refresh_token, expires_at}.
 * Scrobble a partir de los eventos del reproductor (player:start/progress/close/ended).
 */
(function(){
"use strict";

var App = window.App;
var API = "https://api.trakt.tv";
/* El inicio de sesión es por código de dispositivo (no usa redirección). Solo la renovación del token
 * envía redirect_uri: las apps "Development" de Trakt solo admiten localhost, las antiguas el URN oob. */
var REDIRECTS = ["http://localhost", "urn:ietf:wg:oauth:2.0:oob"];
var SCROBBLE_EVERY = 5 * 60 * 1000;   // como mucho cada 5 min durante la reproducción

function S(k){ return App.settings.get(k); }
function clientId(){ return String(S("traktClientId") || "").trim(); }
function clientSecret(){ return String(S("traktClientSecret") || "").trim(); }
function auth(){ var a = S("traktAuth"); return a && a.access_token ? a : null; }

/* Desde oct. 2026 Trakt ya no emite Client Secret en las apps nuevas (PKCE): basta el Client ID y el
 * secreto solo se envía si el usuario tiene uno (apps antiguas). */
function isConfigured(){ return !!clientId(); }
function withSecret(body){ var sec = clientSecret(); if(sec) body.client_secret = sec; return body; }
function isLinked(){ return !!(isConfigured() && auth()); }

/* ---------------- HTTP ---------------- */
function rawCall(path, opts){
  opts = opts || {};
  var headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId()
  };
  if(opts.auth){ var a = auth(); if(a) headers["Authorization"] = "Bearer " + a.access_token; }
  return App.net.fetch(API + path, {
    method: opts.method || "GET", headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function(r){
    return r.text().then(function(txt){
      var j = null; try{ j = txt ? JSON.parse(txt) : null; }catch(e){ j = null; }
      if(!r.ok){
        var err = new Error((j && (j.error_description || j.error)) || ("HTTP " + r.status));
        err.status = r.status; err.body = j;
        throw err;
      }
      return j;
    });
  });
}

var refreshing = null;
function saveToken(j){
  var created = j.created_at ? j.created_at * 1000 : Date.now();
  App.settings.set("traktAuth", {
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: created + (j.expires_in || 7776000) * 1000
  });
}
function ensureToken(){
  var a = auth();
  if(!a) return Promise.reject(new Error("not linked"));
  if(a.expires_at && a.expires_at - Date.now() > 24 * 3600 * 1000) return Promise.resolve(a);
  if(refreshing) return refreshing;
  var tryRefresh = function(i){
    return rawCall("/oauth/token", { method: "POST", body: withSecret({
      refresh_token: a.refresh_token, client_id: clientId(),
      redirect_uri: REDIRECTS[i], grant_type: "refresh_token"
    })}).catch(function(e){
      if(i + 1 < REDIRECTS.length && (e.status === 400 || e.status === 401)) return tryRefresh(i + 1);
      throw e;
    });
  };
  refreshing = tryRefresh(0).then(function(j){
    saveToken(j); refreshing = null;
    console.info("[trakt] token renovado");
    return auth();
  }).catch(function(e){
    refreshing = null;
    console.warn("[trakt] no se pudo renovar el token:", e.message);
    if(e.status === 401 || e.status === 400) App.settings.set("traktAuth", null);
    throw e;
  });
  return refreshing;
}
function call(path, opts){
  opts = opts || {};
  if(!opts.auth) return rawCall(path, opts);
  return ensureToken().then(function(){ return rawCall(path, opts); });
}

/* ---------------- Vinculación (device flow) ---------------- */
function showNotConfigured(){
  var url = App.remote && App.remote.url ? App.remote.url() : "";
  App.ui.modal({
    title: App.t("trakt.notConfiguredTitle"),
    html: "<p>" + App.t("trakt.notConfiguredText", {
      url: url ? "<b>" + App.esc(url) + "</b>" : App.esc(App.t("trakt.notConfiguredNoUrl"))
    }) + "</p>",
    buttons: [{ label: App.t("ui.close"), value: true }]
  });
}

function link(){
  if(!isConfigured()){ showNotConfigured(); return Promise.resolve(false); }
  return rawCall("/oauth/device/code", { method: "POST", body: { client_id: clientId() } }).then(function(dc){
    return new Promise(function(resolve){
      var done = false, timer = null;
      var interval = Math.max(1, dc.interval || 5) * 1000;
      var deadline = Date.now() + (dc.expires_in || 600) * 1000;
      var url = String(dc.verification_url || "https://trakt.tv/activate").replace(/^https?:\/\//, "");
      var m = App.ui.modal({
        title: App.t("trakt.linkTitle"),
        html: "<p>" + App.t("trakt.linkText", { url: App.esc(url) }) + "</p>" +
              '<div class="trakt-code">' + App.esc(dc.user_code) + "</div>" +
              '<p class="trakt-wait" id="traktWait">' + App.esc(App.t("trakt.linkWaiting", { min: Math.round((dc.expires_in || 600) / 60) })) + "</p>",
        buttons: [{ label: App.t("ui.cancel"), value: false }],
        cancelValue: false,
        onClose: function(){ if(!done){ done = true; clearTimeout(timer); resolve(false); } }
      });
      function finish(ok, msg){
        if(done) return;
        done = true; clearTimeout(timer);
        m.close(ok);
        if(msg) App.ui.toast(msg, 4500);
        resolve(ok);
      }
      function poll(){
        if(done) return;
        if(Date.now() > deadline){ finish(false, App.t("trakt.linkExpired")); return; }
        rawCall("/oauth/device/token", { method: "POST", body: withSecret({
          code: dc.device_code, client_id: clientId()
        })}).then(function(j){
          if(done) return;
          saveToken(j);
          console.info("[trakt] vinculado");
          App.bus.emit("trakt:change", { linked: true });
          finish(true, App.t("trakt.linked"));
        }).catch(function(e){
          if(done) return;
          if(e.status === 400){ timer = setTimeout(poll, interval); return; }      // pendiente
          if(e.status === 429){ interval += 1000; timer = setTimeout(poll, interval); return; }
          if(e.status === 410){ finish(false, App.t("trakt.linkExpired")); return; }
          if(e.status === 418){ finish(false, App.t("trakt.linkDenied")); return; }
          finish(false, App.t("trakt.linkError", { msg: e.message }));
        });
      }
      timer = setTimeout(poll, interval);
    });
  }).catch(function(e){
    console.warn("[trakt] device code:", e.message);
    App.ui.toast(App.t("trakt.linkError", { msg: e.message }), 4500);
    return false;
  });
}

function unlink(){
  var a = auth();
  var p = a ? rawCall("/oauth/revoke", { method: "POST", body: withSecret({
    token: a.access_token, client_id: clientId()
  })}).catch(function(){}) : Promise.resolve();
  return p.then(function(){
    App.settings.set("traktAuth", null);
    wlCache = null;
    App.bus.emit("trakt:change", { linked: false });
    App.ui.toast(App.t("trakt.unlinked"));
    return true;
  });
}

function status(){
  var a = auth();
  return {
    configured: isConfigured(),
    linked: isLinked(),
    expiresAt: a ? a.expires_at : 0,
    label: !isConfigured() ? App.t("trakt.statusNotConfigured") :
           (isLinked() ? App.t("trakt.statusLinked") : App.t("trakt.statusNotLinked"))
  };
}

/* ---------------- Lista de seguimiento / historial ---------------- */
function posterOf(imdb){ return imdb ? "https://images.metahub.space/poster/medium/" + imdb + "/img" : ""; }
function bgOf(imdb){ return imdb ? "https://images.metahub.space/background/medium/" + imdb + "/img" : ""; }

function mapItem(x){
  var isShow = !!x.show;
  var o = isShow ? x.show : x.movie;
  if(!o) return null;
  var ids = o.ids || {};
  if(!ids.imdb) return null;
  return {
    type: isShow ? "series" : "movie", id: ids.imdb, name: o.title, year: o.year,
    poster: posterOf(ids.imdb), background: bgOf(ids.imdb)
  };
}

var wlCache = null;   // {t, v}
function watchlist(opts){
  opts = opts || {};
  if(!isLinked()) return Promise.resolve([]);
  if(wlCache && !opts.fresh && Date.now() - wlCache.t < 10 * 60 * 1000) return Promise.resolve(wlCache.v);
  return Promise.all([
    call("/sync/watchlist/shows?sort=added,desc", { auth: true }).catch(function(){ return []; }),
    call("/sync/watchlist/movies?sort=added,desc", { auth: true }).catch(function(){ return []; })
  ]).then(function(r){
    var all = (r[0] || []).concat(r[1] || []);
    all.sort(function(a, b){ return String(b.listed_at || "").localeCompare(String(a.listed_at || "")); });
    var out = all.map(mapItem).filter(Boolean);
    wlCache = { t: Date.now(), v: out };
    return out;
  });
}

function history(limit){
  if(!isLinked()) return Promise.resolve([]);
  return call("/sync/history?limit=" + (limit || 20), { auth: true }).then(function(list){
    var seen = {}, out = [];
    (list || []).forEach(function(x){
      var it = mapItem(x);
      if(it && !seen[it.id]){ seen[it.id] = true; out.push(it); }
    });
    return out;
  });
}

/* Calendario de estrenos de las series del usuario: [{imdbId, name, poster, season, episode, title, released}] */
function ymd(d){
  function z(n){ return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
}
function calendar(days){
  if(!isLinked()) return Promise.resolve([]);
  return call("/calendars/my/shows/" + ymd(new Date()) + "/" + (days || 14), { auth: true }).then(function(list){
    return (list || []).map(function(x){
      var sh = x.show || {}, ep = x.episode || {}, ids = sh.ids || {};
      if(!ids.imdb || !x.first_aired) return null;
      return { imdbId: ids.imdb, name: sh.title || "", poster: posterOf(ids.imdb),
               season: ep.season, episode: ep.number, title: ep.title || "", released: x.first_aired };
    }).filter(Boolean);
  });
}

/* Películas vistas en Trakt: { "tt123": true } (caché 30 min) */
var wdCache = null;
function watchedIds(){
  if(!isLinked()) return Promise.resolve({});
  if(wdCache && Date.now() - wdCache.t < 30 * 60 * 1000) return Promise.resolve(wdCache.v);
  return call("/sync/watched/movies", { auth: true }).then(function(list){
    var o = {};
    (list || []).forEach(function(x){ if(x.movie && x.movie.ids && x.movie.ids.imdb) o[x.movie.ids.imdb] = true; });
    wdCache = { t: Date.now(), v: o };
    return o;
  }).catch(function(){ return {}; });
}

/* ---------------- Scrobble ---------------- */
var cur = null;   // {key, body, lastSent, pct}

function scrobbleBody(meta){
  if(!meta) return null;
  var isEp = meta.type === "series" || meta.type === "tv" || (meta.season !== undefined && meta.season !== null && meta.episode !== undefined && meta.episode !== null);
  var ids = {};
  if(meta.imdbId) ids.imdb = meta.imdbId;
  else if(meta.tmdbId) ids.tmdb = Number(meta.tmdbId);
  else return null;
  if(isEp){
    if(meta.season === undefined || meta.episode === undefined || meta.season === null || meta.episode === null) return null;
    return { show: { ids: ids }, episode: { season: Number(meta.season), number: Number(meta.episode) } };
  }
  return { movie: { ids: ids } };
}

function send(action, pct){
  if(!cur || !isLinked()) return;
  var body = {}, b = cur.body;
  for(var k in b) body[k] = b[k];
  body.progress = Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
  cur.lastSent = Date.now();
  call("/scrobble/" + action, { method: "POST", body: body, auth: true }).then(function(){
    console.info("[trakt] scrobble " + action + " " + body.progress + "%");
  }).catch(function(e){
    if(e.status === 409) return;   // ya marcado hace poco
    console.warn("[trakt] scrobble " + action + ":", e.message);
  });
}

function pctOf(pos, dur){ return dur > 0 ? (pos / dur) * 100 : 0; }

App.bus.on("player:start", function(ev){
  cur = null;
  if(!ev || ev.live || !isLinked()) return;
  var body = scrobbleBody(ev.meta);
  if(!body) return;
  var p = 0;
  try{ if(App.history && ev.key) p = (App.history.progress(ev.key) || 0) * 100; }catch(e){}
  cur = { key: ev.key, body: body, lastSent: 0, pct: p };
  send("start", p);
});
App.bus.on("player:progress", function(ev){
  if(!cur || !ev || ev.key !== cur.key) return;
  cur.pct = pctOf(ev.pos, ev.dur);
  if(Date.now() - cur.lastSent >= SCROBBLE_EVERY) send("start", cur.pct);
});
App.bus.on("player:ended", function(ev){
  if(!cur || !ev || ev.key !== cur.key) return;
  send("stop", 100);
  cur = null;
});
App.bus.on("player:close", function(ev){
  if(!cur || !ev || ev.key !== cur.key) return;
  var p = (ev.dur > 0) ? pctOf(ev.pos, ev.dur) : cur.pct;
  // Trakt marca como visto en "stop" a partir del 80 %; por debajo, "pause" guarda el progreso
  send(p >= 80 ? "stop" : "pause", p);
  cur = null;
});

App.trakt = {
  isConfigured: isConfigured,
  isLinked: isLinked,
  link: link,
  unlink: unlink,
  status: status,
  watchlist: watchlist,
  history: history,
  calendar: calendar,
  watchedIds: watchedIds,
  call: call
};

})();
