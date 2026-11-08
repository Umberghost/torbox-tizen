/* account.js — "Cuenta Faro": sincronización entre dispositivos con cifrado de extremo a extremo.
 *
 * El servidor (Worker) solo ve blobs cifrados. Todo se deriva de una masterKey de 16 bytes:
 *   accountId  = hex(SHA-256("faro-id"    || masterKey))[0..32)
 *   proofSecret= hex(SHA-256("faro-proof" || masterKey))            (cabecera X-Faro-Proof)
 *   proofHash  = hex(SHA-256(utf8(proofSecret)))                    (se envía en el primer PUT)
 *   encKey     = HKDF-SHA256(masterKey, salt "faro-enc") → AES-GCM 256 ; blob = base64(iv12 || ct)
 * Frase de recuperación: 12 palabras BIP39 (128 bits + checksum de 4 bits).
 * Código de vinculación: 8 caracteres (alfabeto sin ambigüedades), pairId = hex(SHA-256("faro-pair" || código))[0..32),
 * clave del pair = PBKDF2(código, "faro-pair-salt", 150000, SHA-256) → AES-GCM; el blob del pair cifra la masterKey.
 *
 * API: App.account.{create, addDevice, link(code), recover(words), unlink, deleteAccount, sync, words,
 *   isLinked, status}. Estado: App.store global "acct_key" (hex), "acct_meta" ({claveRaw: ms}), "acct_state".
 * ES2017 sin ?. ni ??.
 */
(function(){
"use strict";

var App = window.App;
var ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var PAIR_ITER = 150000;
var SYNC_EVERY = 120000, SYNC_AFTER_CHANGE = 10000, SYNC_FIRST = 3000, MAX_TRIES = 3, HIST_MAX = 300;
var DEFAULT_SERVER = "https://faro.manuelvm691997.workers.dev";

App.settings.define("accountServer", DEFAULT_SERVER);

/* Claves de App.store (sin prefijo "tb_") que se sincronizan. Con prefijo de perfil "p_<id>_" solo las de PROFILE_BASES. */
var PROFILE_BASES = ["settings", "history", "follow", "followDone", "live_favs", "live_hidden", "live_order",
  "live_reminders", "recentSearches"];
var GLOBAL_BASES = ["profiles"];
/* Ajustes por dispositivo: nunca viajan */
var DEVICE_SETTINGS = ["theme", "uiScale", "screensaver", "navSounds", "localStats", "accountServer", "appIds", "syncUrl", "uiLang"];
/* Regla de core.js: claves globales (sin prefijo de perfil) */
var GLOBAL_KEY = /^(profiles|profile_cur|errlog|visits|seenVer|metacache|homecache|live_cache|badFormats|boot_|g_)/;
var RELOAD_BASES = ["live_favs", "live_order"];     // cargadas en memoria por la pantalla en directo

/* ================= Utilidades puras ================= */
function cryptoObj(){ return window.crypto || null; }
function subtle(){ var c = cryptoObj(); return c && c.subtle ? c.subtle : null; }
function mkErr(code, msg){ var e = new Error(msg || code); e.code = code; return e; }
function utf8(s){ return new TextEncoder().encode(s); }
function concat(a, b){ var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
function hex(u8){ var s = ""; for(var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16); return s; }
function unhex(h){
  if(!/^([0-9a-f]{2})+$/i.test(h || "")) throw mkErr("badKey");
  var u = new Uint8Array(h.length / 2);
  for(var i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
}
function b64(u8){
  var s = "";
  for(var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(str){
  var s = atob(str), u = new Uint8Array(s.length);
  for(var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function sha256(u8){ return subtle().digest("SHA-256", u8).then(function(b){ return new Uint8Array(b); }); }
function randBytes(n){ var u = new Uint8Array(n); cryptoObj().getRandomValues(u); return u; }
function stable(v){
  if(v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if(Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map(function(k){ return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}";
}
function bits8(n){ var s = n.toString(2); while(s.length < 8) s = "0" + s; return s; }

/* ---- BIP39 (128 bits ↔ 12 palabras) ---- */
function mkToWords(mk){
  var W = window.BIP39_WORDS;
  if(!W || W.length !== 2048) return Promise.reject(mkErr("noWords"));
  return sha256(mk).then(function(h){
    var bits = "", i;
    for(i = 0; i < mk.length; i++) bits += bits8(mk[i]);
    bits += bits8(h[0]).slice(0, mk.length / 4);
    var out = [];
    for(i = 0; i < bits.length / 11; i++) out.push(W[parseInt(bits.substr(i * 11, 11), 2)]);
    return out;
  });
}
function wordsToMk(words){
  var W = window.BIP39_WORDS;
  if(!W || W.length !== 2048) return Promise.reject(mkErr("noWords"));
  var list = Array.isArray(words) ? words : String(words || "").trim().toLowerCase().split(/\s+/);
  list = list.map(function(w){ return String(w).trim().toLowerCase(); }).filter(Boolean);
  if(list.length !== 12) return Promise.reject(mkErr("badWords"));
  var bits = "";
  for(var i = 0; i < 12; i++){
    var ix = W.indexOf(list[i]);
    if(ix < 0) return Promise.reject(mkErr("badWords"));
    var s = ix.toString(2); while(s.length < 11) s = "0" + s;
    bits += s;
  }
  var mk = new Uint8Array(16);
  for(var j = 0; j < 16; j++) mk[j] = parseInt(bits.substr(j * 8, 8), 2);
  return sha256(mk).then(function(h){
    if(bits8(h[0]).slice(0, 4) !== bits.slice(128)) throw mkErr("badChecksum");
    return mk;
  });
}

/* ---- Derivaciones ---- */
function deriveIds(mk){
  return Promise.all([sha256(concat(utf8("faro-id"), mk)), sha256(concat(utf8("faro-proof"), mk))]).then(function(r){
    var proof = hex(r[1]);
    return sha256(utf8(proof)).then(function(ph){
      return { id: hex(r[0]).slice(0, 32), proof: proof, proofHash: hex(ph) };
    });
  });
}
function deriveEncKey(mk){
  var S = subtle();
  return S.importKey("raw", mk, "HKDF", false, ["deriveKey"]).then(function(k){
    return S.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8("faro-enc"), info: new Uint8Array(0) },
      k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  });
}
function encryptBytes(key, u8){
  var iv = randBytes(12);
  return subtle().encrypt({ name: "AES-GCM", iv: iv }, key, u8).then(function(ct){
    return b64(concat(iv, new Uint8Array(ct)));
  });
}
function decryptBytes(key, blob){
  var all;
  try{ all = unb64(blob); }catch(e){ return Promise.reject(mkErr("badBlob")); }
  if(all.length < 29) return Promise.reject(mkErr("badBlob"));
  return subtle().decrypt({ name: "AES-GCM", iv: all.subarray(0, 12) }, key, all.subarray(12))
    .then(function(pt){ return new Uint8Array(pt); }, function(){ throw mkErr("badBlob"); });
}
function newCode(){
  var u = randBytes(8), s = "";
  for(var i = 0; i < 8; i++) s += ALPHA.charAt(u[i] % 32);       // 32 divide 256: sin sesgo
  return s;
}
function normCode(c){
  var s = String(c || "").toUpperCase(), o = "";
  for(var i = 0; i < s.length; i++) if(ALPHA.indexOf(s.charAt(i)) >= 0) o += s.charAt(i);
  return o;
}
function fmtCode(c){ return c.slice(0, 4) + "-" + c.slice(4); }
function pairId(code){ return sha256(utf8("faro-pair" + code)).then(function(h){ return hex(h).slice(0, 32); }); }
function pairKey(code){
  var S = subtle();
  return S.importKey("raw", utf8(code), "PBKDF2", false, ["deriveKey"]).then(function(k){
    return S.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: utf8("faro-pair-salt"), iterations: PAIR_ITER },
      k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  });
}

/* ---- Claves de almacenamiento ---- */
function parseRaw(raw){
  var m = /^p_([^_]+)_(.+)$/.exec(raw);
  return m ? { prof: m[1], base: m[2] } : { prof: "p0", base: raw };
}
function whitelisted(raw){
  var p = parseRaw(raw);
  if(PROFILE_BASES.indexOf(p.base) >= 0) return true;
  return p.prof === "p0" && raw === p.base && GLOBAL_BASES.indexOf(p.base) >= 0;
}
function filterSettings(o){
  var out = {};
  if(!o || typeof o !== "object") return out;
  Object.keys(o).forEach(function(k){ if(DEVICE_SETTINGS.indexOf(k) < 0) out[k] = o[k]; });
  return out;
}

/* ---- Fusión (pura) ----
 * local/remote: { raw: {t, d} }. Devuelve { result, apply:{raw:item}, push:boolean }.
 * Gana la más reciente por clave; "history" se fusiona por entrada (campo updated). remoteWins: primer enlace. */
function mergeHistory(a, b){
  var out = {}, k;
  for(k in b) out[k] = b[k];
  for(k in a) if(!out[k] || (a[k].updated || 0) > (out[k].updated || 0)) out[k] = a[k];
  var keys = Object.keys(out);
  if(keys.length > HIST_MAX){
    keys.sort(function(x, y){ return (out[x].updated || 0) - (out[y].updated || 0); });
    keys.slice(0, keys.length - HIST_MAX).forEach(function(x){ delete out[x]; });
  }
  return out;
}
function mergeItems(local, remote, remoteWins){
  var result = {}, apply = {}, push = false, seen = {}, keys = [];
  Object.keys(local).concat(Object.keys(remote)).forEach(function(k){ if(!seen[k]){ seen[k] = 1; keys.push(k); } });
  keys.forEach(function(k){
    var L = local[k], R = remote[k];
    if(!R){ result[k] = L; push = true; return; }
    if(!L){ result[k] = R; if(R.d !== null) apply[k] = R; return; }
    var isObj = function(x){ return x && x.d && typeof x.d === "object" && !Array.isArray(x.d); };
    if(parseRaw(k).base === "history" && isObj(L) && isObj(R)){
      var m = mergeHistory(L.d, R.d), ms = stable(m);
      var t = Math.max(L.t || 0, R.t || 0);
      result[k] = { t: t, d: m };
      if(ms !== stable(R.d)) push = true;
      if(ms !== stable(L.d)) apply[k] = result[k];
      return;
    }
    var same = stable(L.d) === stable(R.d);
    if(same){ result[k] = (L.t || 0) >= (R.t || 0) ? L : R; return; }
    if(!remoteWins && (L.t || 0) > (R.t || 0)){ result[k] = L; push = true; }
    else{ result[k] = R; apply[k] = R; }
  });
  return { result: result, apply: apply, push: push };
}

/* ================= Estado local ================= */
var state = App.store.getGlobal("acct_state", null) || { v: 0, lastSync: 0, error: "" };
var meta = App.store.getGlobal("acct_meta", null) || {};
var applying = false, suppressHistUntil = 0;   // applying: escritura propia del sync; la persistencia del historial es diferida
var session = null;               // { mk, id, proof, proofHash, enc } (derivado de acct_key)
var origSetGlobal = App.store.setGlobal;
function saveState(){ origSetGlobal.call(App.store, "acct_state", state); }
var saveMetaSoon = App.debounce(function(){ origSetGlobal.call(App.store, "acct_meta", meta); }, 300);
function isLinked(){ return !!App.store.getGlobal("acct_key", ""); }
function curProfile(){ try{ return App.profile.current(); }catch(e){ return "p0"; } }

/* Registro de "modificado en": envuelve App.store.set/remove/setGlobal */
var syncSoon = App.debounce(function(){ if(isLinked()) A.sync().catch(function(){}); }, SYNC_AFTER_CHANGE);
function note(raw){
  if(applying || !whitelisted(raw)) return;
  if(Date.now() < suppressHistUntil && parseRaw(raw).base === "history") return;
  meta[raw] = Date.now();
  saveMetaSoon();
  if(isLinked()) syncSoon();
}
(function wrap(){
  var st = App.store, oSet = st.set, oRem = st.remove, oSG = st.setGlobal;
  function rawFor(k){ return ((curProfile() !== "p0" && !GLOBAL_KEY.test(k)) ? "p_" + curProfile() + "_" : "") + k; }
  st.set = function(k, v){ var r = oSet.apply(st, arguments); note(rawFor(k)); return r; };
  st.remove = function(k){ var r = oRem.apply(st, arguments); note(rawFor(k)); return r; };
  st.setGlobal = function(k, v){ var r = oSG.apply(st, arguments); note(k); return r; };
})();

function localItems(){
  var items = {}, i, k, raw;
  try{
    for(i = 0; i < localStorage.length; i++){
      k = localStorage.key(i);
      if(!k || k.indexOf("tb_") !== 0) continue;
      raw = k.slice(3);
      if(!whitelisted(raw)) continue;
      var val;
      try{ val = JSON.parse(localStorage.getItem(k)); }catch(e){ continue; }
      if(parseRaw(raw).base === "settings") val = filterSettings(val);
      items[raw] = { t: meta[raw] || 0, d: val };
    }
  }catch(e){}
  Object.keys(meta).forEach(function(r){ if(!(r in items) && whitelisted(r)) items[r] = { t: meta[r], d: null }; });
  return items;
}

/* ================= Aplicar cambios remotos ================= */
var pendingReload = false;
function rawWrite(raw, d){
  try{
    if(d === null || d === undefined) localStorage.removeItem("tb_" + raw);
    else localStorage.setItem("tb_" + raw, JSON.stringify(d));
  }catch(e){ console.warn("[account] no se pudo guardar " + raw + ": " + e.message); }
}
function readRaw(raw){ try{ var s = localStorage.getItem("tb_" + raw); return s === null ? null : JSON.parse(s); }catch(e){ return null; } }

function applyItems(apply){
  var changed = [], touchedKeys = false;
  applying = true;
  var cur = curProfile();
  Object.keys(apply).forEach(function(raw){
    var it = apply[raw], p = parseRaw(raw);
    meta[raw] = it.t || 0;
    if(p.base === "settings"){
      var live = (cur === "p0" && raw === "settings") || (cur !== "p0" && raw === "p_" + cur + "_settings");
      var remote = filterSettings(it.d);
      if(live){
        Object.keys(remote).forEach(function(k){
          if(stable(App.settings.get(k)) === stable(remote[k])) return;
          if(k === "torboxToken" || k === "rdToken" || k === "tmdbKey") touchedKeys = true;
          App.settings.set(k, remote[k]);
        });
      }else{
        var merged = readRaw(raw) || {};
        Object.keys(remote).forEach(function(k){ merged[k] = remote[k]; });
        rawWrite(raw, merged);
        if(cur !== "p0" && raw === "settings") pendingReload = true;   // los globales viven en memoria
      }
    }else if(p.base === "history" && p.prof === cur && App.history && App.history.save){
      var d = it.d || {};
      Object.keys(d).forEach(function(key){
        var r = d[key], c = App.history.get(key);
        if(!r || (c && (c.updated || 0) >= (r.updated || 0))) return;
        var e = App.history.save({ key: key, pos: r.pos || 0, dur: r.dur || 0, title: r.title, subtitle: r.subtitle,
          poster: r.poster, watched: !!r.watched, meta: r.meta });
        if(e) e.updated = r.updated || e.updated;
      });
    }else{
      rawWrite(raw, it.d);
      if(p.prof === cur && RELOAD_BASES.indexOf(p.base) >= 0) pendingReload = true;
      if(p.base === "follow" && App.bus) App.bus.emit("follow:change", { list: it.d || [] });
    }
    changed.push(raw);
  });
  if(changed.length){
    origSetGlobal.call(App.store, "acct_meta", meta);
    /* Si el perfil activo ya no existe tras el primer enlace, volver al principal */
    try{
      var ids = App.profile.list().map(function(x){ return x.id; });
      if(ids.indexOf(cur) < 0){ origSetGlobal.call(App.store, "profile_cur", "p0"); pendingReload = true; }
    }catch(e){}
    if(touchedKeys){
      try{ if(App.torbox && App.torbox.invalidate) App.torbox.invalidate(); }catch(e){}
      App.bus.emit("meta:keychange");
    }
    App.bus.emit("history:change");
    suppressHistUntil = Date.now() + 1500;
  }
  applying = false;
  return changed;
}

/* Recarga suave cuando la app está inactiva (sin reproducir ni modales, sin teclas desde hace 15 s) */
var lastKey = Date.now();
document.addEventListener("keydown", function(){ lastKey = Date.now(); }, true);
function reloadGuard(){
  try{
    var n = Number(sessionStorage.getItem("tb_acct_reloads") || 0);
    if(n >= 3) return false;
    sessionStorage.setItem("tb_acct_reloads", String(n + 1));
    setTimeout(function(){ try{ sessionStorage.removeItem("tb_acct_reloads"); }catch(e){} }, 120000);
  }catch(e){}
  return true;
}
function idle(){
  if(Date.now() - lastKey < 15000) return false;
  try{ if(App.player && App.player.status && App.player.status().active) return false; }catch(e){}
  try{ if(App.ui.isModalOpen && App.ui.isModalOpen()) return false; }catch(e){}
  try{ if(App.ui.keyboard && App.ui.keyboard.isOpen()) return false; }catch(e){}
  return true;
}
setInterval(function(){
  if(pendingReload && idle() && reloadGuard()) location.reload();
}, 4000);

/* ================= Red ================= */
function baseUrl(){
  return App.net.checkProxy().then(function(){
    if(App.net.service === "torbox-worker") return location.origin;
    return String(App.settings.get("accountServer") || DEFAULT_SERVER).trim().replace(/\/+$/, "");
  });
}
function req(method, path, body, proof){
  return baseUrl().then(function(b){
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var to = setTimeout(function(){ if(ctl) ctl.abort(); }, 20000);
    var h = {};
    if(body) h["Content-Type"] = "application/json";
    if(proof) h["X-Faro-Proof"] = proof;
    return fetch(b + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined })
      .then(function(r){
        clearTimeout(to);
        return r.text().then(function(t){
          var j = null; try{ j = t ? JSON.parse(t) : null; }catch(e){}
          return { status: r.status, json: j };
        });
      }, function(e){ clearTimeout(to); throw mkErr("network", e && e.message); });
  });
}
function t(k, v){ return App.t(k, v); }
function errText(e){
  var c = e && e.code;
  if(c && App.i18n.has("account.err." + c)) return t("account.err." + c);
  return (e && e.message) || t("account.err.server");
}

/* ================= Sesión (claves derivadas) ================= */
function loadSession(mkHex){
  var mk = unhex(mkHex || App.store.getGlobal("acct_key", ""));
  if(mk.length !== 16) return Promise.reject(mkErr("badKey"));
  return Promise.all([deriveIds(mk), deriveEncKey(mk)]).then(function(r){
    session = { mk: mk, id: r[0].id, proof: r[0].proof, proofHash: r[0].proofHash, enc: r[1] };
    return session;
  });
}
function ensureSession(){
  if(!subtle()) return Promise.reject(mkErr("nocrypto"));
  if(session) return Promise.resolve(session);
  return loadSession();
}
function encodePayload(items){ return encryptBytes(session.enc, utf8(JSON.stringify({ v: 1, items: items }))); }
function decodePayload(blob){
  return decryptBytes(session.enc, blob).then(function(u){
    var o; try{ o = JSON.parse(new TextDecoder().decode(u)); }catch(e){ throw mkErr("badBlob"); }
    return (o && o.items && typeof o.items === "object") ? o : { v: 1, items: {} };
  });
}

/* ================= Sincronización ================= */
var syncing = null;
function syncRound(remoteWins){
  return req("GET", "/acct/" + session.id).then(function(r){
    if(r.status === 404) throw mkErr("gone");
    if(r.status === 429) throw mkErr("rate");
    if(r.status !== 200 || !r.json || !r.json.ok) throw mkErr("server", "HTTP " + r.status);
    return decodePayload(r.json.blob).then(function(p){
      var m = mergeItems(localItems(), p.items, remoteWins);
      var changed = Object.keys(m.apply).length ? applyItems(m.apply) : [];
      if(!m.push){ state.v = r.json.v; return { changed: changed, pushed: false }; }
      return encodePayload(m.result).then(function(blob){
        return req("PUT", "/acct/" + session.id, { v: r.json.v, blob: blob }, session.proof);
      }).then(function(pr){
        if(pr.status === 409){ return { conflict: true, changed: changed }; }
        if(pr.status === 403) throw mkErr("forbidden");
        if(pr.status === 429) throw mkErr("rate");
        if(pr.status !== 200 || !pr.json || !pr.json.ok) throw mkErr("server", "HTTP " + pr.status);
        state.v = pr.json.v;
        return { changed: changed, pushed: true };
      });
    });
  });
}
/* sync({remoteWins}) → Promise<{changed:[raw], pushed}> */
function sync(opts){
  if(syncing) return syncing;
  if(!isLinked()) return Promise.reject(mkErr("notLinked"));
  var remoteWins = !!(opts && opts.remoteWins);
  var all = [];
  syncing = ensureSession().then(function(){
    return (function attempt(n){
      return syncRound(remoteWins && n === 0).then(function(res){
        all = all.concat(res.changed || []);
        if(res.conflict){
          if(n + 1 >= MAX_TRIES) throw mkErr("conflict");
          return attempt(n + 1);
        }
        return { changed: all, pushed: res.pushed };
      });
    })(0);
  }).then(function(res){
    state.lastSync = Date.now(); state.error = ""; saveState();
    if(res.changed.length){
      App.bus.emit("account:synced", { changed: res.changed });
      if(App.ui && App.ui.toast && !(opts && opts.silent)) App.ui.toast(t("account.synced"));
    }
    syncing = null;
    return res;
  }, function(e){
    state.error = errText(e); saveState();
    console.warn("[account] sync: " + (e && e.message));
    syncing = null;
    throw e;
  });
  return syncing;
}

/* ================= Crear / enlazar / recuperar ================= */
function storeKey(mk){
  origSetGlobal.call(App.store, "acct_key", hex(mk));
  state = { v: 0, lastSync: 0, error: "" }; saveState();
  session = null;
}
function forgetLocal(){
  App.store.setGlobal("acct_key", null);
  App.store.setGlobal("acct_state", null);
  App.store.setGlobal("acct_meta", null);
  state = { v: 0, lastSync: 0, error: "" }; meta = {}; session = null;
}
function reloadSoon(){
  try{ history.replaceState(null, "", location.pathname + location.search); }catch(e){}
  setTimeout(function(){ location.reload(); }, 500);
}

function showWords(words, first){
  return new Promise(function(resolve){
    var cells = words.map(function(w, i){
      return '<span style="white-space:nowrap"><span style="opacity:.55">' + (i + 1) + '.</span> <b>' + App.esc(w) + '</b></span>';
    }).join("");
    App.ui.modal({
      title: t(first ? "account.created.title" : "account.words.title"),
      html: '<p>' + App.esc(t("account.created.text")) + '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px 24px;font-size:1.15em;margin:16px 0">' + cells + '</div>',
      buttons: [{ label: t(first ? "account.created.done" : "ui.close"), value: true }],
      wide: true, onClose: function(){ resolve(words); }
    });
  });
}

var A = App.account = {
  isLinked: isLinked,
  status: function(){
    return { linked: isLinked(), accountId: session ? session.id.slice(0, 8) : (isLinked() ? "…" : ""), lastSync: state.lastSync || 0, error: state.error || "" };
  },
  sync: sync,
  /* Crea la cuenta con el estado actual de este dispositivo y muestra las 12 palabras */
  create: function(){
    if(!subtle()) { App.ui.toast(t("account.err.nocrypto")); return Promise.reject(mkErr("nocrypto")); }
    if(isLinked()) return Promise.reject(mkErr("alreadyLinked"));
    App.ui.toast(t("account.creating"), 4000);
    var mk = randBytes(16), now = Date.now();
    var prevMeta = meta;
    return loadSession(hex(mk)).then(function(){
      var items = localItems();
      Object.keys(items).forEach(function(k){ if(!items[k].t){ items[k].t = now; meta[k] = now; } });
      return encodePayload(items);
    }).then(function(blob){
      return req("PUT", "/acct/" + session.id, { v: 0, blob: blob, proofHash: session.proofHash });
    }).then(function(r){
      if(r.status !== 200 || !r.json || !r.json.ok) throw mkErr(r.status === 429 ? "rate" : "server", "HTTP " + r.status);
      var s = session;
      storeKey(mk); session = s;
      state.v = r.json.v; state.lastSync = Date.now(); saveState();
      origSetGlobal.call(App.store, "acct_meta", meta);
      return mkToWords(mk);
    }).then(function(words){
      return showWords(words, true);
    }).catch(function(e){
      meta = prevMeta; session = null;
      console.warn("[account] create: " + (e && e.message));
      App.ui.toast(errText(e), 5000);
      throw e;
    });
  },
  /* Palabras de recuperación (para "Ver palabras") */
  words: function(){
    return ensureSession().then(function(s){ return mkToWords(s.mk); });
  },
  showWords: function(){
    return A.words().then(function(w){ return showWords(w, false); });
  },
  /* Genera un código de vinculación (10 min) y lo muestra con QR y cuenta atrás */
  addDevice: function(){
    if(!isLinked()) return Promise.reject(mkErr("notLinked"));
    var code = newCode(), expires = Date.now() + 10 * 60 * 1000;
    return ensureSession().then(function(s){
      return Promise.all([pairId(code), pairKey(code)]).then(function(r){
        return encryptBytes(r[1], s.mk).then(function(blob){ return req("PUT", "/pair/" + r[0], { blob: blob }); });
      });
    }).then(function(r){
      if(r.status !== 200 && r.status !== 201 && !(r.json && r.json.ok)) throw mkErr(r.status === 429 ? "rate" : "server", "HTTP " + r.status);
      return baseUrl();
    }).then(function(base){
      return new Promise(function(resolve){
        var m = App.ui.modal({
          title: t("account.add.title"),
          html: '<p>' + App.esc(t("account.add.text")) + '</p>' +
            '<div style="display:flex;gap:28px;align-items:center;justify-content:center;margin:14px 0;flex-wrap:wrap">' +
            '<canvas class="acct-qr" style="width:170px;height:170px;border-radius:8px;image-rendering:pixelated"></canvas>' +
            '<div style="text-align:center"><div style="font-size:2.6em;font-weight:700;letter-spacing:.12em">' + App.esc(fmtCode(code)) + '</div>' +
            '<div class="acct-left" style="opacity:.7;margin-top:8px"></div></div></div>',
          buttons: [{ label: t("ui.close"), value: true }],
          wide: true, onClose: function(){ clearInterval(iv); resolve(); }
        });
        var cv = m.el.querySelector(".acct-qr"), left = m.el.querySelector(".acct-left");
        if(!(window.qrcode && drawQr(cv, base + "/app/#link=" + code))) cv.style.display = "none";
        function tick(){
          var s = Math.max(0, Math.round((expires - Date.now()) / 1000));
          left.textContent = t("account.add.expires", { time: Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60) });
          if(s <= 0) m.close(true);
        }
        var iv = setInterval(tick, 1000); tick();
      });
    }).catch(function(e){
      console.warn("[account] addDevice: " + (e && e.message));
      App.ui.toast(errText(e), 5000);
      throw e;
    });
  },
  /* Enlaza este dispositivo con un código (8 caracteres) y recarga la app */
  link: function(codeRaw){
    var code = normCode(codeRaw);
    if(!subtle()) { App.ui.toast(t("account.err.nocrypto")); return Promise.reject(mkErr("nocrypto")); }
    if(code.length !== 8){ App.ui.toast(t("account.err.badCode")); return Promise.reject(mkErr("badCode")); }
    App.ui.toast(t("account.linking"), 6000);
    return Promise.all([pairId(code), pairKey(code)]).then(function(r){
      return req("GET", "/pair/" + r[0]).then(function(res){
        if(res.status === 404) throw mkErr("badCode");
        if(res.status === 429) throw mkErr("rate");
        if(res.status !== 200 || !res.json || !res.json.blob) throw mkErr("server", "HTTP " + res.status);
        return decryptBytes(r[1], res.json.blob).catch(function(){ throw mkErr("badCode"); });
      });
    }).then(function(mk){
      if(mk.length !== 16) throw mkErr("isShareCode");   // es un código de "Compartir configuración"
      return enroll(mk);
    })
      .catch(function(e){
        console.warn("[account] link: " + (e && e.message));
        App.ui.toast(errText(e), 5000);
        throw e;
      });
  },
  /* Reconstruye la masterKey desde las 12 palabras y enlaza */
  recover: function(words){
    if(!subtle()) { App.ui.toast(t("account.err.nocrypto")); return Promise.reject(mkErr("nocrypto")); }
    App.ui.toast(t("account.linking"), 6000);
    return wordsToMk(words).then(function(mk){ return enroll(mk); }).catch(function(e){
      console.warn("[account] recover: " + (e && e.message));
      App.ui.toast(errText(e), 5000);
      throw e;
    });
  },
  unlink: function(){
    forgetLocal();
    App.bus.emit("account:change");
    App.ui.toast(t("account.unlinked"));
    return Promise.resolve();
  },
  deleteAccount: function(){
    return ensureSession().then(function(s){
      return req("DELETE", "/acct/" + s.id, null, s.proof);
    }).then(function(r){
      if(r.status === 403) throw mkErr("forbidden");
      if(r.status !== 200 && r.status !== 404 && !(r.json && r.json.ok)) throw mkErr("server", "HTTP " + r.status);
      forgetLocal();
      App.bus.emit("account:change");
      App.ui.toast(t("account.deleted"));
    }).catch(function(e){
      console.warn("[account] delete: " + (e && e.message));
      App.ui.toast(errText(e), 5000);
      throw e;
    });
  }
};

/* Guarda la masterKey, hace el sync inicial (lo remoto gana) y recarga */
function enroll(mk){
  var oldKey = App.store.getGlobal("acct_key", ""), prev = { state: state, meta: meta };
  return loadSession(hex(mk)).then(function(){
    return req("GET", "/acct/" + session.id);
  }).then(function(r){
    if(r.status === 404) throw mkErr("notFound");
    if(r.status !== 200) throw mkErr("server", "HTTP " + r.status);
    var s = session;
    storeKey(mk); session = s;
    meta = {}; origSetGlobal.call(App.store, "acct_meta", meta);
    return sync({ remoteWins: true, silent: true });
  }).then(function(){
    App.ui.toast(t("account.linked"), 3000);
    pendingReload = false;
    reloadSoon();
  }).catch(function(e){
    if(!oldKey && isLinked()){ forgetLocal(); }
    state = prev.state; meta = prev.meta;
    throw e;
  });
}

/* ---- QR ---- */
function drawQr(canvas, text){
  try{
    var qr = window.qrcode(0, "M");
    qr.addData(text); qr.make();
    var n = qr.getModuleCount(), px = 5, quiet = 2, size = (n + quiet * 2) * px;
    canvas.width = size; canvas.height = size;
    var c = canvas.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, size, size);
    c.fillStyle = "#000";
    for(var r = 0; r < n; r++) for(var q = 0; q < n; q++){
      if(qr.isDark(r, q)) c.fillRect((q + quiet) * px, (r + quiet) * px, px, px);
    }
    return true;
  }catch(e){ console.warn("[account] qr: " + e.message); return false; }
}

/* Funciones puras expuestas para pruebas */
A._t = { mkToWords: mkToWords, wordsToMk: wordsToMk, deriveIds: deriveIds, deriveEncKey: deriveEncKey, encryptBytes: encryptBytes,
  decryptBytes: decryptBytes, newCode: newCode, normCode: normCode, pairId: pairId, pairKey: pairKey, mergeItems: mergeItems,
  hex: hex, unhex: unhex, whitelisted: whitelisted, filterSettings: filterSettings, parseRaw: parseRaw };

/* ================= Interfaz (Ajustes) ================= */
function askCode(){
  return new Promise(function(resolve){
    App.ui.keyboard.open({ title: t("account.link.title"), placeholder: t("account.link.placeholder"), max: 8,
      onDone: function(v){ resolve(normCode(v)); }, onCancel: function(){ resolve(""); } });
  });
}
function askWords(){
  return new Promise(function(resolve){
    App.ui.keyboard.open({ title: t("account.recover.title"), placeholder: t("account.recover.placeholder"),
      onDone: function(v){ resolve(String(v || "").trim()); }, onCancel: function(){ resolve(""); } });
  });
}
function rerender(){ App.bus.emit("account:change"); }
function doLinkFlow(){
  return askCode().then(function(code){ if(code) return A.link(code).catch(function(){}); });
}
function doRecoverFlow(){
  return askWords().then(function(w){ if(w) return A.recover(w).catch(function(){}); });
}
function showMenu(){
  var items;
  if(!isLinked()){
    items = [
      { label: t("account.menu.create"), value: "create" },
      { label: t("account.menu.link"), value: "link" },
      { label: t("account.menu.recover"), value: "recover" }
    ];
  }else{
    items = [
      { label: t("account.menu.addDevice"), value: "add" },
      { label: t("account.menu.syncNow"), value: "sync" },
      { label: t("account.menu.showWords"), value: "words" },
      { label: t("account.menu.unlink"), value: "unlink" },
      { label: t("account.menu.delete"), value: "delete" }
    ];
  }
  return App.ui.menu(t("account.title"), items).then(function(v){
    if(!v) return;
    if(v === "create") return A.create().then(rerender, function(){});
    if(v === "link") return doLinkFlow();
    if(v === "recover") return doRecoverFlow();
    if(v === "add") return A.addDevice().catch(function(){});
    if(v === "sync") return sync({ silent: true }).then(function(r){
      App.ui.toast(t(r.changed.length ? "account.synced" : "account.upToDate")); rerender();
    }, function(e){ App.ui.toast(errText(e), 5000); });
    if(v === "words") return App.ui.confirm(t("account.words.confirm.title"), t("account.words.confirm.text"), t("account.words.confirm.yes"), t("ui.cancel"))
      .then(function(y){ if(y) return A.showWords().catch(function(e){ App.ui.toast(errText(e), 5000); }); });
    if(v === "unlink") return App.ui.confirm(t("account.unlink.title"), t("account.unlink.text"), t("account.unlink.yes"), t("ui.cancel"))
      .then(function(y){ if(y){ A.unlink(); rerender(); } });
    if(v === "delete") return App.ui.confirm(t("account.delete.title"), t("account.delete.text"), t("account.delete.yes"), t("ui.cancel"))
      .then(function(y){
        if(!y) return;
        return App.ui.confirm(t("account.delete.title2"), t("account.delete.text2"), t("account.delete.yes2"), t("ui.cancel")).then(function(y2){
          if(y2) return A.deleteAccount().then(rerender, function(){});
        });
      });
  });
}
function fmtAgo(ms){
  if(!ms) return t("account.never");
  try{ return new Date(ms).toLocaleString(); }catch(e){ return String(ms); }
}
/* ================= Compartir configuración con un amigo =================
 * Solo claves de servicios y preferencias (lista blanca). NO viaja: historial, favoritos, series seguidas,
 * perfiles, vínculo de Trakt (traktAuth), avisos ntfy, cuenta Faro ni ajustes propios del dispositivo.
 * Usa el mismo buzón de un solo uso que la vinculación (/pair, 10 min, cifrado con el código). */
var SHARE_KEYS = ["torboxToken", "rdToken", "debridProvider", "tmdbKey", "omdbKey", "stremioAddon", "stremioAddons",
  "traktClientId", "traktClientSecret", "liveListUrl", "liveExtraLists", "defaultSource", "autoplayNext", "subLang",
  "audioLang", "subSize", "openSubs", "playerSpeed", "resumeRewind", "skipIntroAuto", "autoPlayBest", "prefQuality",
  "maxSizeGB", "prefAudio", "hideUnsupported", "contentLanguage", "uiLanguage", "followAuto", "notifyReady", "hideWatchedHome"];
var SHARE_LABELS = { torboxToken: "TorBox", rdToken: "Real-Debrid", tmdbKey: "TMDB", omdbKey: "OMDb",
  traktClientId: "Trakt", stremioAddons: "add-ons", stremioAddon: "add-ons", liveListUrl: "TV" };
function shareSummary(st){
  var names = [];
  Object.keys(st).forEach(function(k){ var n = SHARE_LABELS[k]; if(n && st[k] && (!Array.isArray(st[k]) || st[k].length) && names.indexOf(n) < 0) names.push(n); });
  return names.join(", ");
}
function shareSettings(){
  if(!subtle()){ App.ui.toast(t("account.err.nocrypto")); return Promise.resolve(); }
  var all = App.settings.all(), st = {};
  SHARE_KEYS.forEach(function(k){ var v = all[k]; if(v !== undefined && v !== null && v !== "") st[k] = v; });
  if(!Object.keys(st).length){ App.ui.toast(t("account.share.empty"), 5000); return Promise.resolve(); }
  var code = newCode(), expires = Date.now() + 10 * 60 * 1000;
  var payload = utf8(JSON.stringify({ faroShare: 1, from: App.version, at: Date.now(), settings: st }));
  return Promise.all([pairId(code), pairKey(code)]).then(function(r){
    return encryptBytes(r[1], payload).then(function(blob){ return req("PUT", "/pair/" + r[0], { blob: blob }); });
  }).then(function(r){
    if(r.status !== 200 && r.status !== 201 && !(r.json && r.json.ok)) throw mkErr(r.status === 429 ? "rate" : "server", "HTTP " + r.status);
    return new Promise(function(resolve){
      var iv = null;
      var m = App.ui.modal({
        title: t("account.share.title"), wide: true,
        html: '<p>' + App.esc(t("account.share.text", { what: shareSummary(st) })) + '</p>' +
          '<div style="text-align:center;margin:16px 0"><div style="font-size:2.6em;font-weight:700;letter-spacing:.12em">' + App.esc(fmtCode(code)) + '</div>' +
          '<div class="acct-left" style="opacity:.7;margin-top:8px"></div></div>' +
          '<p class="muted">' + App.esc(t("account.share.how")) + '</p>' +
          '<p class="muted">' + App.esc(t("account.share.warn")) + '</p>',
        buttons: [{ label: t("ui.close"), value: true }],
        onClose: function(){ clearInterval(iv); resolve(); }
      });
      var left = m.el.querySelector(".acct-left");
      function tick(){
        var s2 = Math.max(0, Math.round((expires - Date.now()) / 1000));
        left.textContent = t("account.add.expires", { time: Math.floor(s2 / 60) + ":" + (s2 % 60 < 10 ? "0" : "") + (s2 % 60) });
        if(s2 <= 0) m.close(true);
      }
      iv = setInterval(tick, 1000); tick();
    });
  }).catch(function(e){
    console.warn("[account] share: " + (e && e.message));
    App.ui.toast(errText(e), 5000);
  });
}
function importShared(codeRaw){
  var code = normCode(codeRaw);
  if(!subtle()){ App.ui.toast(t("account.err.nocrypto")); return Promise.resolve(); }
  if(code.length !== 8){ App.ui.toast(t("account.err.badCode")); return Promise.resolve(); }
  App.ui.toast(t("account.share.loading"), 6000);
  return Promise.all([pairId(code), pairKey(code)]).then(function(r){
    return req("GET", "/pair/" + r[0]).then(function(res){
      if(res.status === 404) throw mkErr("badCode");
      if(res.status === 429) throw mkErr("rate");
      if(res.status !== 200 || !res.json || !res.json.blob) throw mkErr("server", "HTTP " + res.status);
      return decryptBytes(r[1], res.json.blob).catch(function(){ throw mkErr("badCode"); });
    });
  }).then(function(bytes){
    if(bytes.length === 16) throw mkErr("isLinkCode");   // es un código de "Añadir dispositivo"
    var d = null;
    try{ d = JSON.parse(new TextDecoder().decode(bytes)); }catch(e){}
    if(!d || !d.faroShare || !d.settings) throw mkErr("badCode");
    var st = {};
    SHARE_KEYS.forEach(function(k){ if(k in d.settings) st[k] = d.settings[k]; });
    var n = Object.keys(st).length;
    return App.ui.confirm(t("account.share.confirmTitle"), t("account.share.confirmText", { n: n, what: shareSummary(st) || "—" }),
      t("account.share.apply"), t("ui.cancel")).then(function(ok){
      if(!ok) return;
      Object.keys(st).forEach(function(k){ App.settings.set(k, st[k]); });
      App.torbox.invalidate();
      App.bus.emit("meta:keychange");
      console.info("[account] configuración importada: " + Object.keys(st).join(", "));
      App.ui.toast(t("account.share.done", { n: n }), 4000);
      setTimeout(function(){ location.reload(); }, 2500);
    });
  }).catch(function(e){
    console.warn("[account] importShared: " + (e && e.message));
    App.ui.toast(errText(e), 6000);
  });
}
function shareMenu(){
  return App.ui.menu(t("account.share.row"), [
    { label: t("account.share.menu.share"), value: "share" },
    { label: t("account.share.menu.import"), value: "import" }
  ]).then(function(v){
    if(v === "share") return shareSettings();
    if(v === "import") return new Promise(function(resolve){
      App.ui.keyboard.open({ title: t("account.share.codeTitle"), placeholder: "XXXX-XXXX", max: 9,
        onDone: function(c){ resolve(importShared(c)); }, onCancel: function(){ resolve(); } });
    });
  });
}
A.shareSettings = shareSettings;
A.importShared = importShared;

App.settingsUI.add("settings.group.account", {
  id: "shareSettings", type: "action",
  label: function(){ return t("account.share.row"); },
  desc: function(){ return t("account.share.desc"); },
  run: shareMenu
});

App.settingsUI.add("settings.group.account", {
  id: "faroAccount", type: "action",
  label: function(){ return t("account.title"); },
  desc: function(){
    var s = A.status();
    return s.linked ? t("account.desc.on", { time: fmtAgo(s.lastSync) }) + (s.error ? " · " + s.error : "") : t("account.desc.off");
  },
  value: function(){ var s = A.status(); return s.linked ? t("account.status.on", { id: s.accountId }) : t("account.status.off"); },
  run: showMenu
});
App.settingsUI.add("settings.group.account", {
  id: "accountServer", type: "text",
  label: function(){ return t("account.server"); },
  desc: function(){ return t("account.server.desc"); },
  value: function(){ return String(App.settings.get("accountServer") || ""); }
});

/* ================= Arranque ================= */
function start(){
  /* Enlace automático desde el QR: <servidor>/app/#link=CODIGO */
  var m = /[#&]link=([A-Za-z0-9-]+)/.exec(location.hash || "");
  if(m){
    if(isLinked()){ try{ history.replaceState(null, "", location.pathname + location.search); }catch(e){} }
    else setTimeout(function(){ A.link(m[1]).catch(function(){}); }, 800);
    return;
  }
  if(!isLinked()) return;
  setTimeout(function(){ sync({ silent: false }).catch(function(){}); }, SYNC_FIRST);
  setInterval(function(){ if(isLinked() && document.visibilityState !== "hidden") sync().catch(function(){}); }, SYNC_EVERY);
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible" && isLinked()) sync().catch(function(){});
  });
}
App.bus.on("app:ready", start);

})();
