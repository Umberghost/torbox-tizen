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
var VERSION = "2.4.0";

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
  stremioAddon: "string", uiLanguage: "string", contentLanguage: "string",
  autoPlayBest: "boolean", prefQuality: "string", maxSizeGB: "number", prefAudio: "string",
  hideUnsupported: "boolean", openSubs: "boolean", notifyReady: "boolean",
  traktClientId: "string", traktClientSecret: "string"
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
var PAGE = "<!doctype html><html><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>TorBox TV</title><style>\n:root{--bg:#0b0f14;--s:#141b22;--s2:#1b242d;--t:#e8eef3;--m:#8b9aa8;--a:#17c964;--d:#ff6b6b;--w:#f5c451}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}\nmain{max-width:640px;margin:0 auto}h1{font-size:24px;margin:8px 0 4px}h1 b{color:var(--a)}h2{font-size:19px;margin:0 0 4px}h3{font-size:15px;color:var(--a);text-transform:uppercase;letter-spacing:.06em;margin:22px 0 0}p{color:var(--m);margin:0 0 12px}\n.card{background:var(--s);border-radius:14px;padding:18px;margin:14px 0}label{display:block;font-weight:600;margin:14px 0 6px}\nsmall{display:block;color:var(--m);font-weight:400;margin-top:4px;word-break:break-all}\ninput,select,textarea{width:100%;padding:12px 14px;font-size:16px;background:var(--bg);color:var(--t);border:1px solid var(--s2);border-radius:10px;font-family:inherit}\ntextarea{min-height:84px;resize:vertical}input:focus,select:focus,textarea:focus{outline:none;border-color:var(--a)}\nbutton{width:100%;margin-top:16px;padding:14px;font-size:17px;font-weight:700;border:0;border-radius:10px;background:var(--a);color:#06130c}\nbutton.sec{background:var(--s2);color:var(--t)}button:disabled{opacity:.5}\n.msg{margin-top:12px;padding:12px;border-radius:10px;display:none}.ok{display:block;background:rgba(23,201,100,.15);color:var(--a)}\n.err{display:block;background:rgba(255,107,107,.15);color:var(--d)}.pin{font-size:28px;letter-spacing:10px;text-align:center}\n.tabs{display:flex;gap:8px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}.tabs a{flex:1;text-align:center;padding:10px;border-radius:10px;background:var(--s);color:var(--m);text-decoration:none;font-weight:600}\n.tabs a.on{background:var(--a);color:#06130c}section{display:none}section.on{display:block}\n#log{background:#05080b;border-radius:10px;padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word}\n#log .e{color:var(--d)}#log .w{color:var(--w)}#log .i{color:#b8c4ce}#log time{color:#56636e;margin-right:6px}\n.row{display:flex;gap:8px}.row button{margin-top:10px}\n.top{display:flex;justify-content:space-between;align-items:center}.top select{width:auto;padding:6px 10px;font-size:14px}\n</style></head><body><main>\n<div class=\"top\"><h1>Tor<b>Box</b> TV</h1><select id=\"wlang\"><option value=\"en\">English</option><option value=\"es\">Español</option></select></div>\n<p data-t=\"intro\"></p>\n<div class=\"card\"><label for=\"pin\" style=\"margin-top:0\"><span data-t=\"pin\"></span><small data-t=\"pinHelp\"></small></label>\n<input id=\"pin\" class=\"pin\" inputmode=\"numeric\" maxlength=\"4\" autocomplete=\"off\" placeholder=\"····\"></div>\n<nav class=\"tabs\"><a href=\"#\" data-tab=\"cfg\" class=\"on\" data-t=\"tabCfg\"></a><a href=\"#\" data-tab=\"add\" data-t=\"tabAdd\"></a><a href=\"#\" data-tab=\"log\" data-t=\"tabLog\"></a></nav>\n\n<section id=\"t-cfg\" class=\"on\"><form id=\"f\" class=\"card\"><p data-t=\"cfgIntro\"></p><div id=\"fields\"></div>\n<button id=\"b\" type=\"submit\" data-t=\"send\"></button><div id=\"m\" class=\"msg\"></div></form></section>\n\n<section id=\"t-add\"><form id=\"fa\" class=\"card\"><h2 data-t=\"addTitle\"></h2><p data-t=\"addIntro\"></p>\n<textarea id=\"link\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"magnet:?xt=urn:btih:…  ·  https://…/file.nzb  ·  https://…\"></textarea>\n<label for=\"lname\" data-t=\"addName\"></label><input id=\"lname\" autocomplete=\"off\">\n<button id=\"ba\" type=\"submit\" data-t=\"addBtn\"></button><div id=\"ma\" class=\"msg\"></div></form></section>\n\n<section id=\"t-log\"><div class=\"card\"><h2 data-t=\"logTitle\"></h2><p data-t=\"logIntro\"></p>\n<div class=\"row\"><button id=\"bl\" class=\"sec\" type=\"button\" data-t=\"refresh\"></button><button id=\"bc\" class=\"sec\" type=\"button\" data-t=\"copy\"></button></div>\n<div id=\"ml\" class=\"msg\"></div><div id=\"log\" style=\"margin-top:12px\"></div></div></section>\n</main><script>\nvar T={\nen:{intro:\"Remote control for the TorBox app on your TV.\",pin:\"TV PIN\",pinHelp:\"Shown on the TV: TorBox start screen or Settings.\",tabCfg:\"Settings\",tabAdd:\"Add\",tabLog:\"Log\",\ncfgIntro:\"Changes apply on the TV instantly. Leave blank / unchanged what you don't want to change.\",send:\"Send to TV\",\naddTitle:\"Add to TorBox\",addIntro:\"Paste a magnet, hash, NZB link or URL (web download). The TV adds it to your account.\",addName:\"Name (optional)\",addBtn:\"Add\",\nlogTitle:\"App log\",logIntro:\"Messages and errors from the app on the TV (last 600). Updates automatically.\",refresh:\"Refresh\",copy:\"Copy\",\nunchanged:\"— unchanged —\",current:\"Current: \",notSet:\"Not set\",yes:\"Yes\",no:\"No\",\ngAccount:\"Account\",gLang:\"Language\",gSearch:\"Search\",gPlay:\"Playback\",gTrakt:\"Trakt\",gLive:\"Live TV\",\ntorboxToken:\"TorBox API key\",torboxTokenH:\"torbox.app → Settings → API.\",stremioAddon:\"Stremio add-on (Search)\",stremioAddonH:\"Manifest URL of your add-on configured with TorBox (Torrentio, Comet, AIOStreams…), same as in Stremio.\",\ntmdbKey:\"TMDB key (artwork)\",tmdbKeyH:\"themoviedb.org → Settings → API: v3 API Key or v4 read token. Optional.\",\nuiLanguage:\"Interface language\",contentLanguage:\"Content language (synopses, episodes)\",sameUi:\"Same as interface\",\nautoPlayBest:\"Play best source with one click\",prefQuality:\"Preferred quality\",maxSizeGB:\"Max size\",noLimit:\"No limit\",prefAudio:\"Preferred audio\",any:\"Any\",\nhideUnsupported:\"Hide formats the TV can't play\",defaultSource:\"Default library source\",all:\"All\",audioLang:\"Preferred audio track\",subLang:\"Preferred subtitles\",original:\"Original\",none:\"None\",\nsubSize:\"Subtitle size\",small:\"Small\",medium:\"Medium\",large:\"Large\",autoplayNext:\"Autoplay next episode\",openSubs:\"OpenSubtitles subtitles\",notifyReady:\"Notify when downloads finish\",\ntraktClientId:\"Trakt Client ID\",traktClientIdH:\"Create an app at trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob), then link it from the TV: Settings → Trakt.\",traktClientSecret:\"Trakt Client Secret\",\nliveListUrl:\"Channel list URL\",liveListUrlH:\"Default: TDTChannels\",\nneedPin:\"Enter the 4-digit PIN shown on the TV.\",nothing:\"You didn't change anything.\",sent:\"Sent. The TV will apply the changes in a few seconds.\",saved:\"Saved. It will apply when you open TorBox on the TV.\",\ntvOff:\"TorBox is not open on the TV: changes will apply when you open it.\",noConn:\"Could not connect to the TV.\",pasteLink:\"Paste a link.\",adding:\"Sent to the TV, adding…\",addSaved:\"Saved. It will be added when you open TorBox on the TV.\",\nlogPin:\"Enter the PIN to see the log.\",noMsgs:\"No messages yet.\",copied:\"Copied.\",copyFail:\"Could not copy.\"},\nes:{intro:\"Control remoto de la app TorBox de la TV.\",pin:\"PIN de la TV\",pinHelp:\"Aparece en la TV: pantalla de inicio de TorBox o Ajustes.\",tabCfg:\"Ajustes\",tabAdd:\"Añadir\",tabLog:\"Registro\",\ncfgIntro:\"Los cambios se aplican en la TV al instante. Deja vacío / sin cambios lo que no quieras cambiar.\",send:\"Enviar a la TV\",\naddTitle:\"Añadir a TorBox\",addIntro:\"Pega un magnet, un hash, un enlace NZB o una URL (descarga web). La TV lo añade a tu cuenta.\",addName:\"Nombre (opcional)\",addBtn:\"Añadir\",\nlogTitle:\"Registro de la app\",logIntro:\"Mensajes y errores de la app en la TV (últimos 600). Se actualiza solo.\",refresh:\"Actualizar\",copy:\"Copiar\",\nunchanged:\"— sin cambios —\",current:\"Actual: \",notSet:\"Sin configurar\",yes:\"Sí\",no:\"No\",\ngAccount:\"Cuenta\",gLang:\"Idioma\",gSearch:\"Buscar\",gPlay:\"Reproducción\",gTrakt:\"Trakt\",gLive:\"TV en directo\",\ntorboxToken:\"API key de TorBox\",torboxTokenH:\"torbox.app → Settings → API.\",stremioAddon:\"Add-on de Stremio (Buscar)\",stremioAddonH:\"URL del manifest de tu add-on con TorBox (Torrentio, Comet, AIOStreams…), la misma que en Stremio.\",\ntmdbKey:\"Clave TMDB (carátulas)\",tmdbKeyH:\"themoviedb.org → Ajustes → API: API Key v3 o token de lectura v4. Opcional.\",\nuiLanguage:\"Idioma de la interfaz\",contentLanguage:\"Idioma del contenido (sinopsis, episodios)\",sameUi:\"Igual que la interfaz\",\nautoPlayBest:\"Reproducir la mejor fuente en un clic\",prefQuality:\"Calidad preferida\",maxSizeGB:\"Tamaño máximo\",noLimit:\"Sin límite\",prefAudio:\"Audio preferido\",any:\"Cualquiera\",\nhideUnsupported:\"Ocultar formatos que la TV no reproduce\",defaultSource:\"Fuente por defecto de la biblioteca\",all:\"Todas\",audioLang:\"Pista de audio preferida\",subLang:\"Subtítulos preferidos\",original:\"Original\",none:\"Ninguno\",\nsubSize:\"Tamaño de subtítulos\",small:\"Pequeño\",medium:\"Mediano\",large:\"Grande\",autoplayNext:\"Siguiente episodio automático\",openSubs:\"Subtítulos de OpenSubtitles\",notifyReady:\"Avisar al terminar descargas\",\ntraktClientId:\"Trakt Client ID\",traktClientIdH:\"Crea una app en trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob) y vincúlala desde la TV: Ajustes → Trakt.\",traktClientSecret:\"Trakt Client Secret\",\nliveListUrl:\"URL de la lista de canales\",liveListUrlH:\"Por defecto: TDTChannels\",\nneedPin:\"Introduce el PIN de 4 cifras que muestra la TV.\",nothing:\"No has cambiado nada.\",sent:\"Enviado. La TV aplicará los cambios en unos segundos.\",saved:\"Guardado. Se aplicará cuando abras TorBox en la TV.\",\ntvOff:\"La TV no tiene TorBox abierto: los cambios se aplicarán al abrirlo.\",noConn:\"No se pudo conectar con la TV.\",pasteLink:\"Pega un enlace.\",adding:\"Enviado a la TV, añadiendo…\",addSaved:\"Guardado. Se añadirá cuando abras TorBox en la TV.\",\nlogPin:\"Introduce el PIN para ver el registro.\",noMsgs:\"Sin mensajes todavía.\",copied:\"Copiado.\",copyFail:\"No se pudo copiar.\"}};\n/* Campos: [clave, tipo, grupo, opciones] — tipo: text | secret | sel | bool */\nvar F=[[\"gAccount\"],[\"torboxToken\",\"secret\"],[\"stremioAddon\",\"secret\"],[\"tmdbKey\",\"secret\"],\n[\"gLang\"],[\"uiLanguage\",\"sel\",[[\"en\",\"English\"],[\"es\",\"Español\"]]],[\"contentLanguage\",\"sel\",[[\"auto\",\"@sameUi\"],[\"en\",\"English\"],[\"es\",\"Español\"]]],\n[\"gSearch\"],[\"autoPlayBest\",\"bool\"],[\"prefQuality\",\"sel\",[[\"2160p\",\"4K / 2160p\"],[\"1080p\",\"1080p\"],[\"720p\",\"720p\"]]],[\"maxSizeGB\",\"sel\",[[0,\"@noLimit\"],[2,\"2 GB\"],[4,\"4 GB\"],[8,\"8 GB\"],[15,\"15 GB\"],[30,\"30 GB\"]]],\n[\"prefAudio\",\"sel\",[[\"es\",\"Castellano\"],[\"lat\",\"Latino\"],[\"en\",\"English\"],[\"any\",\"@any\"]]],[\"hideUnsupported\",\"bool\"],\n[\"gPlay\"],[\"audioLang\",\"sel\",[[\"spa\",\"Español\"],[\"eng\",\"English\"],[\"\",\"@original\"]]],[\"subLang\",\"sel\",[[\"spa\",\"Español\"],[\"eng\",\"English\"],[\"\",\"@none\"]]],\n[\"subSize\",\"sel\",[[\"s\",\"@small\"],[\"m\",\"@medium\"],[\"l\",\"@large\"]]],[\"autoplayNext\",\"bool\"],[\"openSubs\",\"bool\"],[\"notifyReady\",\"bool\"],[\"defaultSource\",\"sel\",[[\"all\",\"@all\"],[\"torrents\",\"Torrents\"],[\"usenet\",\"Usenet\"],[\"webdl\",\"Web\"]]],\n[\"gTrakt\"],[\"traktClientId\",\"secret\"],[\"traktClientSecret\",\"secret\"],[\"gLive\"],[\"liveListUrl\",\"text\"]];\nvar $=function(i){return document.getElementById(i)},L=\"en\",snap={};\ntry{L=localStorage.getItem(\"tblang\")||((navigator.language||\"\").slice(0,2)===\"es\"?\"es\":\"en\")}catch(e){}\nfunction t(k){return (T[L]&&T[L][k])||T.en[k]||k}\nfunction esc(s){return String(s).replace(/[&<>\"]/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c]})}\nfunction lbl(x){return x&&x.charAt&&x.charAt(0)===\"@\"?t(x.slice(1)):x}\nfunction renderFields(){var h=\"\";F.forEach(function(f){var k=f[0],ty=f[1];\n if(!ty){h+=\"<h3>\"+esc(t(k))+\"</h3>\";return}\n var help=T.en[k+\"H\"]?t(k+\"H\"):\"\",cur=snap[k];\n if(ty===\"secret\"||ty===\"text\"){h+='<label for=\"f_'+k+'\">'+esc(t(k))+'<small>'+esc(help)+(help?\" \":\"\")+esc(cur?t(\"current\")+cur:(ty===\"secret\"?t(\"notSet\"):\"\"))+'</small></label><input id=\"f_'+k+'\" data-k=\"'+k+'\" data-ty=\"'+ty+'\" autocomplete=\"off\" spellcheck=\"false\">';return}\n var opts=ty===\"bool\"?[[true,t(\"yes\")],[false,t(\"no\")]]:f[2];\n h+='<label for=\"f_'+k+'\">'+esc(t(k))+'</label><select id=\"f_'+k+'\" data-k=\"'+k+'\" data-ty=\"'+ty+'\"><option value=\"__\">'+esc(t(\"unchanged\"))+(cur!==undefined?\" (\"+esc(curLabel(opts,cur))+\")\":\"\")+'</option>';\n opts.forEach(function(o){h+='<option value=\"'+esc(JSON.stringify(o[0]))+'\">'+esc(lbl(o[1]))+'</option>'});h+=\"</select>\"});\n $(\"fields\").innerHTML=h}\nfunction curLabel(opts,v){for(var i=0;i<opts.length;i++)if(String(opts[i][0])===String(v))return lbl(opts[i][1]);return String(v)}\nfunction applyLang(){document.documentElement.lang=L;$(\"wlang\").value=L;var n=document.querySelectorAll(\"[data-t]\");for(var i=0;i<n.length;i++)n[i].textContent=t(n[i].getAttribute(\"data-t\"));renderFields();\n if(!lines.length)$(\"log\").textContent=t(\"logPin\")}\n$(\"wlang\").addEventListener(\"change\",function(){L=this.value;try{localStorage.setItem(\"tblang\",L)}catch(e){}applyLang()});\ntry{$(\"pin\").value=localStorage.getItem(\"tbpin\")||\"\"}catch(e){}\nfunction msg(id,s,ok){var m=$(id);m.textContent=s;m.className=\"msg \"+(ok?\"ok\":\"err\")}\nfunction pinOk(){var p=$(\"pin\").value.trim();if(!/^\\d{4}$/.test(p))return null;try{localStorage.setItem(\"tbpin\",p)}catch(e){}return p}\nfunction post(u,o){return fetch(u,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(o)}).then(function(r){return r.json()})}\nvar tabs=document.querySelectorAll(\".tabs a\");\nfor(var i=0;i<tabs.length;i++)tabs[i].addEventListener(\"click\",function(e){e.preventDefault();var tb=this.getAttribute(\"data-tab\");\n for(var j=0;j<tabs.length;j++){tabs[j].classList.toggle(\"on\",tabs[j]===this);$(\"t-\"+tabs[j].getAttribute(\"data-tab\")).classList.toggle(\"on\",tabs[j]===this)}\n if(tb===\"log\")loadLogs(true)});\nfunction load(){fetch(\"/api/state\").then(function(r){return r.json()}).then(function(j){snap=j.snapshot||{};\n if(!localStorage.getItem(\"tblang\")&&snap.uiLanguage&&T[snap.uiLanguage])L=snap.uiLanguage;applyLang();\n if(!j.tvOnline)msg(\"m\",t(\"tvOff\"),false)}).catch(function(){applyLang()})}\nvar lines=[];load();\n$(\"f\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();if(!pin){msg(\"m\",t(\"needPin\"),false);return}\n var s={},els=document.querySelectorAll(\"#fields [data-k]\");\n for(var i=0;i<els.length;i++){var el=els[i],k=el.getAttribute(\"data-k\"),ty=el.getAttribute(\"data-ty\");\n  if(el.tagName===\"INPUT\"){var v=el.value.trim();if(v)s[k]=v}else if(el.value!==\"__\"){s[k]=JSON.parse(el.value)}}\n if(!Object.keys(s).length){msg(\"m\",t(\"nothing\"),false);return}\n $(\"b\").disabled=true;post(\"/api/settings\",{pin:pin,settings:s}).then(function(j){$(\"b\").disabled=false;\n  if(j.ok){var ins=document.querySelectorAll(\"#fields input\");for(var i=0;i<ins.length;i++)ins[i].value=\"\";msg(\"m\",j.tvOnline?t(\"sent\"):t(\"saved\"),true);setTimeout(load,3500)}\n  else msg(\"m\",j.detail||\"Error\",false)}).catch(function(){$(\"b\").disabled=false;msg(\"m\",t(\"noConn\"),false)})});\n$(\"fa\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();if(!pin){msg(\"ma\",t(\"needPin\"),false);return}\n var link=$(\"link\").value.trim();if(!link){msg(\"ma\",t(\"pasteLink\"),false);return}\n $(\"ba\").disabled=true;post(\"/api/add\",{pin:pin,link:link,name:$(\"lname\").value.trim()}).then(function(j){$(\"ba\").disabled=false;\n  if(!j.ok){msg(\"ma\",j.detail||\"Error\",false);return}\n  msg(\"ma\",j.tvOnline?t(\"adding\"):t(\"addSaved\"),true);$(\"link\").value=\"\";$(\"lname\").value=\"\";\n  var tries=0,id=j.id;(function poll(){fetch(\"/api/actionresult?id=\"+id).then(function(r){return r.json()}).then(function(r){\n   if(r.result){msg(\"ma\",r.result.message,r.result.ok);return}if(++tries<20)setTimeout(poll,1500)}).catch(function(){})})()\n }).catch(function(){$(\"ba\").disabled=false;msg(\"ma\",t(\"noConn\"),false)})});\nvar lastN=0,logTimer=null;\nfunction loadLogs(reset){var pin=pinOk();if(!pin){msg(\"ml\",t(\"logPin\"),false);return}\n if(reset){lastN=0;lines=[]}\n fetch(\"/api/logs?pin=\"+pin+\"&since=\"+lastN).then(function(r){return r.json()}).then(function(j){\n  if(!j.ok){msg(\"ml\",j.detail||\"Error\",false);return}$(\"ml\").className=\"msg\";\n  (j.logs||[]).forEach(function(e){lastN=Math.max(lastN,e.n);lines.push(e)});if(lines.length>600)lines=lines.slice(-600);\n  var box=$(\"log\"),atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-20;\n  box.innerHTML=lines.length?lines.map(function(e){var d=new Date(e.t);return '<div class=\"'+(e.l===\"error\"?\"e\":e.l===\"warn\"?\"w\":\"i\")+'\"><time>'+d.toLocaleTimeString()+'</time>'+esc(e.m)+'</div>'}).join(\"\"):(j.tvOnline?t(\"noMsgs\"):t(\"tvOff\"));\n  if(atEnd||reset)box.scrollTop=box.scrollHeight}).catch(function(){msg(\"ml\",t(\"noConn\"),false)});\n clearTimeout(logTimer);if($(\"t-log\").classList.contains(\"on\"))logTimer=setTimeout(function(){loadLogs(false)},3000)}\n$(\"bl\").addEventListener(\"click\",function(){loadLogs(true)});\n$(\"bc\").addEventListener(\"click\",function(){var s=lines.map(function(e){return new Date(e.t).toLocaleTimeString()+\" [\"+e.l+\"] \"+e.m}).join(\"\\n\");\n if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(s).then(function(){msg(\"ml\",t(\"copied\"),true)},function(){msg(\"ml\",t(\"copyFail\"),false)});\n else{var ta=document.createElement(\"textarea\");ta.value=s;document.body.appendChild(ta);ta.select();try{document.execCommand(\"copy\");msg(\"ml\",t(\"copied\"),true)}catch(e){}document.body.removeChild(ta)}});\n</script></body></html>\n";

function tvOnline(){ return Date.now() - lastPoll < 15000; }

/* ---------------- Servidor ---------------- */
function handler(req, res){
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
}

var server = null;
function start(){
  if(server) return;
  server = http.createServer(handler);
  server.on("error", function(e){
    // Puerto ocupado: otra instancia (TizenBrew o la app instalada) ya da servicio.
    console.log("[torbox-tizen service] " + e.message);
  });
  server.listen(PORT, "0.0.0.0", function(){
    console.log("[torbox-tizen service] v" + VERSION + " en :" + PORT + " · PIN " + pin + " · " + lanIps().join(", "));
  });
}
function stop(){ if(server){ try{ server.close(); }catch(e){} server = null; } }

/* Servicio web de Tizen (app instalada) usa onStart/onStop; TizenBrew (vm) y Node arrancan directo. */
try{
  if(typeof module !== "undefined" && module.exports){
    module.exports.onStart = start;
    module.exports.onStop = stop;
    module.exports.onExit = stop;
    module.exports.onRequest = function(){};
  }
}catch(e){}
start();
