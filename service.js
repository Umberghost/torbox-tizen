/*
 * service.js — servicio local de TorBox para TizenBrew (serviceFile).
 *
 * 1) Proxy CORS (solo desde la propia TV): la API de TorBox solo permite CORS desde
 *    https://torbox.app, así que la app llama a http://127.0.0.1:8095/proxy?url=<URL>.
 * 2) Ajustes remotos: desde el móvil/PC se abre http://<IP-TV>:8095/ , se introduce el
 *    PIN que muestra la TV y se pegan API keys y demás ajustes. La app de la TV recoge
 *    los cambios por /tv/pending (solo loopback).
 *
 * Sin dependencias. Compatible con Node antiguo (ES5). En el PC: `node service.js`.
 */
"use strict";

var http = require("http");
var https = require("https");
var urlMod = require("url");
var os = require("os");

var PORT = 8095;
var MAX_REDIRECTS = 5;
var VERSION = "2.1.0";

/* ---------------- Estado de ajustes remotos ---------------- */
var pin = String(Math.floor(1000 + Math.random() * 9000));
var pending = null;          // { settings:{...}, at }
var snapshot = {};           // ajustes no secretos que la TV publica para mostrarlos en la web
var lastPoll = 0;            // última vez que la app de la TV preguntó
var fails = 0, lockUntil = 0;

/* Claves que se pueden cambiar desde la web */
var ALLOWED = {
  torboxToken: "string", tmdbKey: "string", defaultSource: "string", autoplayNext: "boolean",
  subLang: "string", audioLang: "string", subSize: "string", uiLang: "string", liveListUrl: "string"
};

function lanIps(){
  var out = [], ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function(n){
    (ifs[n] || []).forEach(function(a){
      if((a.family === "IPv4" || a.family === 4) && !a.internal) out.push(a.address);
    });
  });
  return out;
}

function isLoopback(req){
  var a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function cors(extra){
  var h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept,Range",
    "Access-Control-Expose-Headers": "Content-Type,Content-Length,Content-Range",
    "Access-Control-Max-Age": "600"
  };
  if(extra) for(var k in extra) h[k] = extra[k];
  return h;
}
function sendJson(res, code, obj){
  res.writeHead(code, cors({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }));
  res.end(JSON.stringify(obj));
}
function readBody(req, cb){
  var chunks = [], size = 0;
  req.on("data", function(c){ size += c.length; if(size < 2e6) chunks.push(c); });
  req.on("end", function(){ cb(Buffer.concat(chunks)); });
}

/* ---------------- Proxy ---------------- */
function forward(target, req, res, body, depth){
  var u;
  try{ u = urlMod.parse(target); }catch(e){ u = null; }
  if(!u || (u.protocol !== "https:" && u.protocol !== "http:")) return sendJson(res, 400, { success: false, detail: "URL no válida" });
  var headers = {};
  ["authorization", "content-type", "accept", "range"].forEach(function(h){
    if(req.headers[h]) headers[h] = req.headers[h];
  });
  headers["user-agent"] = "TorBox-Tizen/" + VERSION;
  if(body && body.length) headers["content-length"] = body.length;

  var lib = u.protocol === "https:" ? https : http;
  var preq = lib.request({
    protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path,
    method: req.method, headers: headers
  }, function(pres){
    var loc = pres.headers.location;
    if(pres.statusCode >= 300 && pres.statusCode < 400 && loc && depth < MAX_REDIRECTS && req.method === "GET"){
      pres.resume();
      return forward(urlMod.resolve(target, loc), req, res, body, depth + 1);
    }
    var out = {};
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach(function(h){
      if(pres.headers[h]) out[h] = pres.headers[h];
    });
    res.writeHead(pres.statusCode, cors(out));
    pres.pipe(res);
  });
  preq.on("error", function(e){
    if(res.headersSent) return res.end();
    sendJson(res, 502, { success: false, detail: "Proxy: " + e.message });
  });
  preq.setTimeout(30000, function(){ preq.abort(); });
  if(body && body.length) preq.write(body);
  preq.end();
}

/* ---------------- Página de ajustes (móvil/PC) ---------------- */
var PAGE = [
'<!doctype html><html lang="es"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>TorBox TV · Ajustes</title><style>',
':root{--bg:#0b0f14;--s:#141b22;--s2:#1b242d;--t:#e8eef3;--m:#8b9aa8;--a:#17c964;--d:#ff6b6b}',
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}',
'main{max-width:560px;margin:0 auto}h1{font-size:24px;margin:8px 0 4px}h1 b{color:var(--a)}p{color:var(--m);margin:0 0 16px}',
'.card{background:var(--s);border-radius:14px;padding:18px;margin:14px 0}label{display:block;font-weight:600;margin:14px 0 6px}',
'small{display:block;color:var(--m);font-weight:400;margin-top:4px}',
'input,select{width:100%;padding:12px 14px;font-size:16px;background:var(--bg);color:var(--t);border:1px solid var(--s2);border-radius:10px}',
'input:focus,select:focus{outline:none;border-color:var(--a)}',
'button{width:100%;margin-top:18px;padding:14px;font-size:17px;font-weight:700;border:0;border-radius:10px;background:var(--a);color:#06130c}',
'button:disabled{opacity:.5}.msg{margin-top:14px;padding:12px;border-radius:10px;display:none}.ok{display:block;background:rgba(23,201,100,.15);color:var(--a)}',
'.err{display:block;background:rgba(255,107,107,.15);color:var(--d)}.row{display:flex;gap:10px;align-items:center}.row input[type=checkbox]{width:22px;height:22px}',
'.pin{font-size:28px;letter-spacing:10px;text-align:center}',
'</style></head><body><main>',
'<h1>Tor<b>Box</b> TV · Ajustes</h1><p>Los cambios se aplican en la TV al instante. Deja vacío lo que no quieras cambiar.</p>',
'<div class="card"><label for="pin">PIN de la TV<small>Aparece en la TV: pantalla de inicio de TorBox o Ajustes.</small></label>',
'<input id="pin" class="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="····"></div>',
'<form id="f" class="card">',
'<label for="torboxToken">API key de TorBox<small>torbox.app → Settings → API. <span id="h_torboxToken"></span></small></label>',
'<input id="torboxToken" autocomplete="off" spellcheck="false" placeholder="Pega aquí tu API key">',
'<label for="tmdbKey">Clave TMDB (carátulas)<small>themoviedb.org → Ajustes → API: "API Key" v3 o "token de lectura" v4. <span id="h_tmdbKey"></span></small></label>',
'<input id="tmdbKey" autocomplete="off" spellcheck="false" placeholder="Opcional">',
'<label for="defaultSource">Fuente por defecto</label><select id="defaultSource"><option value="">— sin cambios —</option>',
'<option value="all">Todo</option><option value="torrents">Torrents</option><option value="usenet">Usenet</option><option value="webdl">Web</option></select>',
'<label for="audioLang">Idioma de audio preferido</label><select id="audioLang"><option value="__">— sin cambios —</option>',
'<option value="spa">Español</option><option value="eng">Inglés</option><option value="">Original</option></select>',
'<label for="subLang">Idioma de subtítulos preferido</label><select id="subLang"><option value="__">— sin cambios —</option>',
'<option value="spa">Español</option><option value="eng">Inglés</option><option value="">Ninguno</option></select>',
'<label for="subSize">Tamaño de subtítulos</label><select id="subSize"><option value="">— sin cambios —</option>',
'<option value="s">Pequeño</option><option value="m">Mediano</option><option value="l">Grande</option></select>',
'<label for="autoplayNext">Siguiente episodio automático</label><select id="autoplayNext"><option value="">— sin cambios —</option>',
'<option value="1">Sí</option><option value="0">No</option></select>',
'<label for="liveListUrl">Lista de TV en directo (URL)<small id="h_liveListUrl"></small></label>',
'<input id="liveListUrl" autocomplete="off" spellcheck="false" placeholder="Por defecto: TDTChannels">',
'<button id="b" type="submit">Enviar a la TV</button><div id="m" class="msg"></div></form>',
'</main><script>',
'var $=function(i){return document.getElementById(i)};',
'try{$("pin").value=localStorage.getItem("tbpin")||""}catch(e){}',
'function msg(t,ok){var m=$("m");m.textContent=t;m.className="msg "+(ok?"ok":"err")}',
'function load(){fetch("/api/state").then(function(r){return r.json()}).then(function(j){var s=j.snapshot||{};',
' $("h_torboxToken").textContent=s.torboxToken?"Actual: "+s.torboxToken:"Sin configurar";',
' $("h_tmdbKey").textContent=s.tmdbKey?"Actual: "+s.tmdbKey:"Sin configurar";',
' if(s.liveListUrl)$("h_liveListUrl").textContent="Actual: "+s.liveListUrl;',
' if(!j.tvOnline)msg("La TV no tiene TorBox abierto: los cambios se aplicarán al abrirlo.",false);}).catch(function(){})}',
'load();',
'$("f").addEventListener("submit",function(e){e.preventDefault();var pin=$("pin").value.trim();',
' if(!/^\\d{4}$/.test(pin)){msg("Introduce el PIN de 4 cifras que muestra la TV.",false);return}',
' var s={};["torboxToken","tmdbKey","liveListUrl"].forEach(function(k){var v=$(k).value.trim();if(v)s[k]=v});',
' if($("defaultSource").value)s.defaultSource=$("defaultSource").value;',
' ["audioLang","subLang"].forEach(function(k){if($(k).value!=="__")s[k]=$(k).value});',
' if($("subSize").value)s.subSize=$("subSize").value;',
' if($("autoplayNext").value)s.autoplayNext=$("autoplayNext").value==="1";',
' if(!Object.keys(s).length){msg("No has cambiado nada.",false);return}',
' $("b").disabled=true;',
' fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:pin,settings:s})})',
' .then(function(r){return r.json()}).then(function(j){$("b").disabled=false;',
'  if(j.ok){try{localStorage.setItem("tbpin",pin)}catch(e){}["torboxToken","tmdbKey"].forEach(function(k){$(k).value=""});',
'   msg(j.tvOnline?"Enviado. La TV aplicará los cambios en unos segundos.":"Guardado. Se aplicará cuando abras TorBox en la TV.",true);setTimeout(load,3000)}',
'  else msg(j.detail||"Error",false)}).catch(function(){$("b").disabled=false;msg("No se pudo conectar con la TV.",false)})});',
'</script></body></html>'
].join("\n");

function tvOnline(){ return Date.now() - lastPoll < 15000; }

/* ---------------- Servidor ---------------- */
var server = http.createServer(function(req, res){
  if(req.method === "OPTIONS"){ res.writeHead(204, cors()); return res.end(); }
  var parsed = urlMod.parse(req.url, true);
  var p = parsed.pathname;
  var local = isLoopback(req);

  if(p === "/ping") return sendJson(res, 200, { ok: true, service: "torbox-tizen", version: VERSION });

  /* --- Solo desde la TV --- */
  if(p === "/proxy"){
    if(!local) return sendJson(res, 403, { success: false, detail: "Solo disponible desde la TV" });
    if(!parsed.query.url) return sendJson(res, 400, { success: false, detail: "Falta url" });
    return readBody(req, function(body){ forward(String(parsed.query.url), req, res, body, 0); });
  }
  if(p === "/tv/state"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    lastPoll = Date.now();
    return sendJson(res, 200, { pin: pin, ips: lanIps(), port: PORT, hasPending: !!pending });
  }
  if(p === "/tv/pending"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    lastPoll = Date.now();
    var out = pending; pending = null;
    return sendJson(res, 200, { pending: out });
  }
  if(p === "/tv/snapshot" && req.method === "POST"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    return readBody(req, function(b){
      try{ snapshot = JSON.parse(b.toString("utf8")) || {}; }catch(e){}
      sendJson(res, 200, { ok: true });
    });
  }

  /* --- Web de ajustes (red local) --- */
  if(p === "/" || p === "/index.html"){
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(PAGE);
  }
  if(p === "/api/state") return sendJson(res, 200, { snapshot: snapshot, tvOnline: tvOnline() });
  if(p === "/api/settings" && req.method === "POST"){
    return readBody(req, function(b){
      if(Date.now() < lockUntil) return sendJson(res, 429, { ok: false, detail: "Demasiados intentos. Espera 5 minutos." });
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!j || String(j.pin) !== pin){
        fails++;
        if(fails >= 5){ fails = 0; lockUntil = Date.now() + 5 * 60000; }
        return sendJson(res, 401, { ok: false, detail: "PIN incorrecto. Míralo en la TV." });
      }
      fails = 0;
      var clean = {}, n = 0, s = j.settings || {};
      Object.keys(s).forEach(function(k){
        if(ALLOWED[k] && typeof s[k] === ALLOWED[k] && String(s[k]).length < 2000){ clean[k] = s[k]; n++; }
      });
      if(!n) return sendJson(res, 400, { ok: false, detail: "Nada que cambiar" });
      var merged = pending ? pending.settings : {};
      Object.keys(clean).forEach(function(k){ merged[k] = clean[k]; });
      pending = { settings: merged, at: Date.now() };
      sendJson(res, 200, { ok: true, tvOnline: tvOnline() });
    });
  }
  sendJson(res, 404, { success: false, detail: "Ruta no encontrada" });
});

server.on("error", function(e){
  // Puerto ocupado: probablemente ya hay otra instancia corriendo.
  console.log("[torbox-tizen service] " + e.message);
});
server.listen(PORT, "0.0.0.0", function(){
  console.log("[torbox-tizen service] v" + VERSION + " en :" + PORT + " · PIN " + pin + " · " + lanIps().join(", "));
});
