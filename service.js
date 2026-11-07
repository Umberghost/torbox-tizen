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
var VERSION = "2.2.0";

/* ---------------- Estado de ajustes remotos ---------------- */
var pin = String(Math.floor(1000 + Math.random() * 9000));
var pending = null;          // { settings:{...}, at }
var snapshot = {};           // ajustes no secretos que la TV publica para mostrarlos en la web
var lastPoll = 0;            // última vez que la app de la TV preguntó
var fails = 0, lockUntil = 0;
var actions = [];            // acciones pendientes para la TV: [{id, type:'add', link, name}]
var actionResults = [];      // resultados que devuelve la TV: [{id, ok, message, at}]
var actionSeq = 0;
var logs = [];               // registro que publica la app de la TV
var LOG_MAX = 600;

/* Claves que se pueden cambiar desde la web */
var ALLOWED = {
  torboxToken: "string", tmdbKey: "string", defaultSource: "string", autoplayNext: "boolean",
  subLang: "string", audioLang: "string", subSize: "string", uiLang: "string", liveListUrl: "string",
  stremioAddon: "string"
};

function checkPin(req, given, res){
  if(Date.now() < lockUntil){ sendJson(res, 429, { ok: false, detail: "Demasiados intentos. Espera 5 minutos." }); return false; }
  if(String(given || "") !== pin){
    fails++;
    if(fails >= 5){ fails = 0; lockUntil = Date.now() + 5 * 60000; }
    sendJson(res, 401, { ok: false, detail: "PIN incorrecto. Míralo en la TV." });
    return false;
  }
  fails = 0;
  return true;
}

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
var PAGE = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>TorBox TV</title><style>\n:root{--bg:#0b0f14;--s:#141b22;--s2:#1b242d;--t:#e8eef3;--m:#8b9aa8;--a:#17c964;--d:#ff6b6b;--w:#f5c451}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}\nmain{max-width:640px;margin:0 auto}h1{font-size:24px;margin:8px 0 4px}h1 b{color:var(--a)}h2{font-size:19px;margin:0 0 4px}p{color:var(--m);margin:0 0 12px}\n.card{background:var(--s);border-radius:14px;padding:18px;margin:14px 0}label{display:block;font-weight:600;margin:14px 0 6px}\nsmall{display:block;color:var(--m);font-weight:400;margin-top:4px;word-break:break-all}\ninput,select,textarea{width:100%;padding:12px 14px;font-size:16px;background:var(--bg);color:var(--t);border:1px solid var(--s2);border-radius:10px;font-family:inherit}\ntextarea{min-height:84px;resize:vertical}input:focus,select:focus,textarea:focus{outline:none;border-color:var(--a)}\nbutton{width:100%;margin-top:16px;padding:14px;font-size:17px;font-weight:700;border:0;border-radius:10px;background:var(--a);color:#06130c}\nbutton.sec{background:var(--s2);color:var(--t)}button:disabled{opacity:.5}\n.msg{margin-top:12px;padding:12px;border-radius:10px;display:none}.ok{display:block;background:rgba(23,201,100,.15);color:var(--a)}\n.err{display:block;background:rgba(255,107,107,.15);color:var(--d)}.pin{font-size:28px;letter-spacing:10px;text-align:center}\n.tabs{display:flex;gap:8px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}.tabs a{flex:1;text-align:center;padding:10px;border-radius:10px;background:var(--s);color:var(--m);text-decoration:none;font-weight:600}\n.tabs a.on{background:var(--a);color:#06130c}section{display:none}section.on{display:block}\n#log{background:#05080b;border-radius:10px;padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word}\n#log .e{color:var(--d)}#log .w{color:var(--w)}#log .i{color:#b8c4ce}#log time{color:#56636e;margin-right:6px}\n.row{display:flex;gap:8px}.row button{margin-top:10px}\n</style></head><body><main>\n<h1>Tor<b>Box</b> TV</h1><p>Control remoto de la app de la TV.</p>\n<div class=\"card\"><label for=\"pin\" style=\"margin-top:0\">PIN de la TV<small>Aparece en la TV: pantalla de inicio de TorBox o Ajustes.</small></label>\n<input id=\"pin\" class=\"pin\" inputmode=\"numeric\" maxlength=\"4\" autocomplete=\"off\" placeholder=\"····\"></div>\n<nav class=\"tabs\"><a href=\"#\" data-t=\"cfg\" class=\"on\">Ajustes</a><a href=\"#\" data-t=\"add\">Añadir</a><a href=\"#\" data-t=\"log\">Registro</a></nav>\n\n<section id=\"t-cfg\" class=\"on\"><form id=\"f\" class=\"card\">\n<p>Los cambios se aplican en la TV al instante. Deja vacío lo que no quieras cambiar.</p>\n<label for=\"torboxToken\">API key de TorBox<small>torbox.app → Settings → API. <span id=\"h_torboxToken\"></span></small></label>\n<input id=\"torboxToken\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"Pega aquí tu API key\">\n<label for=\"stremioAddon\">Add-on de Stremio (para Buscar)<small>URL del manifest de tu add-on configurado con TorBox (Torrentio, Comet, AIOStreams…), la misma que usas en Stremio. <span id=\"h_stremioAddon\"></span></small></label>\n<input id=\"stremioAddon\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"https://…/manifest.json\">\n<label for=\"tmdbKey\">Clave TMDB (carátulas)<small>themoviedb.org → Ajustes → API: \"API Key\" v3 o \"token de lectura\" v4. <span id=\"h_tmdbKey\"></span></small></label>\n<input id=\"tmdbKey\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"Opcional\">\n<label for=\"defaultSource\">Fuente por defecto</label><select id=\"defaultSource\"><option value=\"\">— sin cambios —</option>\n<option value=\"all\">Todo</option><option value=\"torrents\">Torrents</option><option value=\"usenet\">Usenet</option><option value=\"webdl\">Web</option></select>\n<label for=\"audioLang\">Idioma de audio preferido</label><select id=\"audioLang\"><option value=\"__\">— sin cambios —</option>\n<option value=\"spa\">Español</option><option value=\"eng\">Inglés</option><option value=\"\">Original</option></select>\n<label for=\"subLang\">Idioma de subtítulos preferido</label><select id=\"subLang\"><option value=\"__\">— sin cambios —</option>\n<option value=\"spa\">Español</option><option value=\"eng\">Inglés</option><option value=\"\">Ninguno</option></select>\n<label for=\"subSize\">Tamaño de subtítulos</label><select id=\"subSize\"><option value=\"\">— sin cambios —</option>\n<option value=\"s\">Pequeño</option><option value=\"m\">Mediano</option><option value=\"l\">Grande</option></select>\n<label for=\"autoplayNext\">Siguiente episodio automático</label><select id=\"autoplayNext\"><option value=\"\">— sin cambios —</option>\n<option value=\"1\">Sí</option><option value=\"0\">No</option></select>\n<label for=\"liveListUrl\">Lista de TV en directo (URL)<small id=\"h_liveListUrl\"></small></label>\n<input id=\"liveListUrl\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"Por defecto: TDTChannels\">\n<button id=\"b\" type=\"submit\">Enviar a la TV</button><div id=\"m\" class=\"msg\"></div></form></section>\n\n<section id=\"t-add\"><form id=\"fa\" class=\"card\"><h2>Añadir a TorBox</h2>\n<p>Pega un magnet, un hash, un enlace NZB o una URL (descarga web). La TV lo añade a tu cuenta.</p>\n<textarea id=\"link\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"magnet:?xt=urn:btih:…  ·  https://…/archivo.nzb  ·  https://…\"></textarea>\n<label for=\"lname\">Nombre (opcional)</label><input id=\"lname\" autocomplete=\"off\">\n<button id=\"ba\" type=\"submit\">Añadir</button><div id=\"ma\" class=\"msg\"></div></form></section>\n\n<section id=\"t-log\"><div class=\"card\"><h2>Registro de la app</h2><p>Mensajes y errores de la app en la TV (últimos 600). Se actualiza solo.</p>\n<div class=\"row\"><button id=\"bl\" class=\"sec\" type=\"button\">Actualizar</button><button id=\"bc\" class=\"sec\" type=\"button\">Copiar</button></div>\n<div id=\"ml\" class=\"msg\"></div><div id=\"log\" style=\"margin-top:12px\">Introduce el PIN para ver el registro.</div></div></section>\n</main><script>\nvar $=function(i){return document.getElementById(i)};\ntry{$(\"pin\").value=localStorage.getItem(\"tbpin\")||\"\"}catch(e){}\nfunction msg(id,t,ok){var m=$(id);m.textContent=t;m.className=\"msg \"+(ok?\"ok\":\"err\")}\nfunction pinOk(){var p=$(\"pin\").value.trim();if(!/^\\d{4}$/.test(p)){return null}try{localStorage.setItem(\"tbpin\",p)}catch(e){}return p}\nfunction post(u,o){return fetch(u,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(o)}).then(function(r){return r.json()})}\nvar tabs=document.querySelectorAll(\".tabs a\");\nfor(var i=0;i<tabs.length;i++)tabs[i].addEventListener(\"click\",function(e){e.preventDefault();var t=this.getAttribute(\"data-t\");\n for(var j=0;j<tabs.length;j++){tabs[j].classList.toggle(\"on\",tabs[j]===this);$(\"t-\"+tabs[j].getAttribute(\"data-t\")).classList.toggle(\"on\",tabs[j]===this)}\n if(t===\"log\")loadLogs(true)});\nfunction load(){fetch(\"/api/state\").then(function(r){return r.json()}).then(function(j){var s=j.snapshot||{};\n $(\"h_torboxToken\").textContent=s.torboxToken?\"Actual: \"+s.torboxToken:\"Sin configurar\";\n $(\"h_tmdbKey\").textContent=s.tmdbKey?\"Actual: \"+s.tmdbKey:\"Sin configurar\";\n $(\"h_stremioAddon\").textContent=s.stremioAddon?\"Actual: \"+s.stremioAddon:\"Sin configurar\";\n if(s.liveListUrl)$(\"h_liveListUrl\").textContent=\"Actual: \"+s.liveListUrl;\n if(!j.tvOnline)msg(\"m\",\"La TV no tiene TorBox abierto: los cambios se aplicarán al abrirlo.\",false)}).catch(function(){})}\nload();\n$(\"f\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();\n if(!pin){msg(\"m\",\"Introduce el PIN de 4 cifras que muestra la TV.\",false);return}\n var s={};[\"torboxToken\",\"tmdbKey\",\"liveListUrl\",\"stremioAddon\"].forEach(function(k){var v=$(k).value.trim();if(v)s[k]=v});\n if($(\"defaultSource\").value)s.defaultSource=$(\"defaultSource\").value;\n [\"audioLang\",\"subLang\"].forEach(function(k){if($(k).value!==\"__\")s[k]=$(k).value});\n if($(\"subSize\").value)s.subSize=$(\"subSize\").value;\n if($(\"autoplayNext\").value)s.autoplayNext=$(\"autoplayNext\").value===\"1\";\n if(!Object.keys(s).length){msg(\"m\",\"No has cambiado nada.\",false);return}\n $(\"b\").disabled=true;post(\"/api/settings\",{pin:pin,settings:s}).then(function(j){$(\"b\").disabled=false;\n  if(j.ok){[\"torboxToken\",\"tmdbKey\",\"stremioAddon\"].forEach(function(k){$(k).value=\"\"});\n   msg(\"m\",j.tvOnline?\"Enviado. La TV aplicará los cambios en unos segundos.\":\"Guardado. Se aplicará cuando abras TorBox en la TV.\",true);setTimeout(load,3500)}\n  else msg(\"m\",j.detail||\"Error\",false)}).catch(function(){$(\"b\").disabled=false;msg(\"m\",\"No se pudo conectar con la TV.\",false)})});\n$(\"fa\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();\n if(!pin){msg(\"ma\",\"Introduce el PIN de 4 cifras que muestra la TV.\",false);return}\n var link=$(\"link\").value.trim();if(!link){msg(\"ma\",\"Pega un enlace.\",false);return}\n $(\"ba\").disabled=true;post(\"/api/add\",{pin:pin,link:link,name:$(\"lname\").value.trim()}).then(function(j){$(\"ba\").disabled=false;\n  if(!j.ok){msg(\"ma\",j.detail||\"Error\",false);return}\n  msg(\"ma\",j.tvOnline?\"Enviado a la TV, añadiendo…\":\"Guardado. Se añadirá cuando abras TorBox en la TV.\",true);$(\"link\").value=\"\";$(\"lname\").value=\"\";\n  var tries=0,id=j.id;(function poll(){fetch(\"/api/actionresult?id=\"+id).then(function(r){return r.json()}).then(function(r){\n   if(r.result){msg(\"ma\",r.result.message,r.result.ok);return}if(++tries<20)setTimeout(poll,1500)}).catch(function(){})})()\n }).catch(function(){$(\"ba\").disabled=false;msg(\"ma\",\"No se pudo conectar con la TV.\",false)})});\nvar lastN=0,logTimer=null,lines=[];\nfunction esc(s){return String(s).replace(/[&<>]/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\"}[c]})}\nfunction loadLogs(reset){var pin=pinOk();if(!pin){msg(\"ml\",\"Introduce el PIN para ver el registro.\",false);return}\n if(reset){lastN=0;lines=[]}\n fetch(\"/api/logs?pin=\"+pin+\"&since=\"+lastN).then(function(r){return r.json()}).then(function(j){\n  if(!j.ok){msg(\"ml\",j.detail||\"Error\",false);return}$(\"ml\").className=\"msg\";\n  (j.logs||[]).forEach(function(e){lastN=Math.max(lastN,e.n);lines.push(e)});if(lines.length>600)lines=lines.slice(-600);\n  var box=$(\"log\"),atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-20;\n  box.innerHTML=lines.length?lines.map(function(e){var d=new Date(e.t);return '<div class=\"'+(e.l===\"error\"?\"e\":e.l===\"warn\"?\"w\":\"i\")+'\"><time>'+d.toLocaleTimeString()+'</time>'+esc(e.m)+'</div>'}).join(\"\"):(j.tvOnline?\"Sin mensajes todavía.\":\"La TV no tiene TorBox abierto.\");\n  if(atEnd||reset)box.scrollTop=box.scrollHeight}).catch(function(){msg(\"ml\",\"No se pudo conectar con la TV.\",false)});\n clearTimeout(logTimer);if($(\"t-log\").classList.contains(\"on\"))logTimer=setTimeout(function(){loadLogs(false)},3000)}\n$(\"bl\").addEventListener(\"click\",function(){loadLogs(true)});\n$(\"bc\").addEventListener(\"click\",function(){var t=lines.map(function(e){return new Date(e.t).toLocaleTimeString()+\" [\"+e.l+\"] \"+e.m}).join(\"\\n\");\n if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){msg(\"ml\",\"Copiado.\",true)},function(){msg(\"ml\",\"No se pudo copiar.\",false)});\n else{var ta=document.createElement(\"textarea\");ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand(\"copy\");msg(\"ml\",\"Copiado.\",true)}catch(e){}document.body.removeChild(ta)}});\n</script></body></html>\n";

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
    var acts = actions; actions = [];
    return sendJson(res, 200, { pending: out, actions: acts });
  }
  if(p === "/tv/logs" && req.method === "POST"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    return readBody(req, function(b){
      try{
        var arr = JSON.parse(b.toString("utf8")) || [];
        var last = logs.length ? logs[logs.length - 1].n : 0;
        if(arr.length && arr[0].n <= 1 && last > arr[arr.length - 1].n) logs = []; // la app se reinició
        arr.forEach(function(e){ if(e && e.n > last) logs.push(e); });
        if(logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
      }catch(e){}
      sendJson(res, 200, { ok: true, last: logs.length ? logs[logs.length - 1].n : 0 });
    });
  }
  if(p === "/tv/actionresult" && req.method === "POST"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    return readBody(req, function(b){
      try{ var r = JSON.parse(b.toString("utf8")); r.at = Date.now(); actionResults.push(r); }catch(e){}
      if(actionResults.length > 20) actionResults.splice(0, actionResults.length - 20);
      sendJson(res, 200, { ok: true });
    });
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
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!checkPin(req, j && j.pin, res)) return;
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
  if(p === "/api/add" && req.method === "POST"){
    return readBody(req, function(b){
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!checkPin(req, j && j.pin, res)) return;
      var link = String((j && j.link) || "").trim();
      if(!link || link.length > 8000) return sendJson(res, 400, { ok: false, detail: "Pega un magnet, hash, NZB o URL" });
      var id = ++actionSeq;
      actions.push({ id: id, type: "add", link: link, name: j.name ? String(j.name).slice(0, 300) : "" });
      sendJson(res, 200, { ok: true, id: id, tvOnline: tvOnline() });
    });
  }
  if(p === "/api/actionresult"){
    var want = Number(parsed.query.id);
    var found = null;
    actionResults.forEach(function(r){ if(r.id === want) found = r; });
    return sendJson(res, 200, { result: found });
  }
  if(p === "/api/logs"){
    if(!checkPin(req, parsed.query.pin, res)) return;
    var since = Number(parsed.query.since) || 0;
    return sendJson(res, 200, { ok: true, logs: logs.filter(function(e){ return e.n > since; }), tvOnline: tvOnline() });
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
