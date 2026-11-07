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
var fs = require("fs");
var path = require("path");

var PORT = 8095;
var MAX_REDIRECTS = 5;
var VERSION = "2.5.0";

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
var tvStatus = null;         // {status:{active,title,pos,dur,...}, at} lo publica la TV mientras reproduce
var waiters = [];            // peticiones /tv/pending?wait=1 retenidas (long-poll) para que las teclas lleguen al instante
var PINVER_FILE = path.join(os.tmpdir(), "torbox-tizen-pinver.json");
var pinnedVersion = null;    // "v2.4.1" | null: versión fijada que lee el cargador de la app instalada
try{ var pv = JSON.parse(fs.readFileSync(PINVER_FILE, "utf8")); if(pv && typeof pv.version === "string") pinnedVersion = pv.version; }catch(e){}

/* Claves que se pueden cambiar desde la web */
var ALLOWED = {
  torboxToken: "string", tmdbKey: "string", defaultSource: "string", autoplayNext: "boolean",
  subLang: "string", audioLang: "string", subSize: "string", uiLang: "string", liveListUrl: "string",
  stremioAddon: "string", uiLanguage: "string", contentLanguage: "string",
  autoPlayBest: "boolean", prefQuality: "string", maxSizeGB: "number", prefAudio: "string",
  hideUnsupported: "boolean", openSubs: "boolean", notifyReady: "boolean",
  traktClientId: "string", traktClientSecret: "string",
  ntfyTopic: "string", followAuto: "boolean", syncUrl: "string",
  stremioAddons: "list", liveExtraLists: "list"     // listas: se envían como operaciones {ops:[{op:"add"|"remove"|"set",...}]}
};
var ACTION_TYPES = { play: 1, playUrl: 1, control: 1, key: 1, "import": 1, "export": 1 };
var CONTROL_CMDS = { playpause: 1, play: 1, pause: 1, stop: 1, seek: 1, seekTo: 1 };

/* Valida y limpia el valor de un ajuste según su tipo; devuelve undefined si no es válido */
function cleanSetting(k, v){
  var ty = ALLOWED[k];
  if(ty === "list"){
    if(!v || typeof v !== "object" || !Array.isArray(v.ops)) return undefined;
    var ops = [];
    v.ops.slice(0, 20).forEach(function(o){
      if(!o) return;
      if(o.op === "add" && typeof o.value === "string" && o.value.length < 1000) ops.push({ op: "add", value: o.value });
      else if(o.op === "remove" && typeof o.index === "number" && o.index >= 0 && o.index < 100) ops.push({ op: "remove", index: Math.floor(o.index) });
      else if(o.op === "set" && Array.isArray(o.value) && o.value.length <= 30 &&
        o.value.every(function(x){ return typeof x === "string" && x.length < 1000; })) ops.push({ op: "set", value: o.value });
    });
    return ops.length ? { ops: ops } : undefined;
  }
  if(typeof v === ty && String(v).length < 2000) return v;
  return undefined;
}

/* Valida una acción remota; devuelve la acción limpia o null */
function cleanAction(a){
  if(!a || typeof a !== "object" || !ACTION_TYPES[a.type]) return null;
  var o = { type: a.type };
  var str = function(v, n){ return String(v == null ? "" : v).slice(0, n); };
  if(a.type === "play"){
    if(a.mediaType !== "movie" && a.mediaType !== "series") return null;
    if(!/^[\w:.-]{1,40}$/.test(String(a.imdbId || ""))) return null;
    o.mediaType = a.mediaType; o.imdbId = String(a.imdbId);
    if(a.mediaType === "series"){ o.season = parseInt(a.season, 10) || 0; o.episode = parseInt(a.episode, 10) || 1; }
    o.title = str(a.title, 200);
  }else if(a.type === "playUrl"){
    var u = str(a.url, 8000).trim();
    if(!/^https?:\/\//i.test(u)) return null;
    o.url = u; o.title = str(a.title, 300);
  }else if(a.type === "control"){
    if(!CONTROL_CMDS[a.cmd]) return null;
    o.cmd = a.cmd; if(typeof a.arg === "number" && isFinite(a.arg)) o.arg = a.arg;
  }else if(a.type === "key"){
    if(!/^[a-z0-9]{1,12}$/.test(String(a.key || ""))) return null;
    o.key = String(a.key);
  }else if(a.type === "import"){
    if(!a.data || typeof a.data !== "object") return null;
    o.data = a.data;
  }
  return o;
}

/* Despierta la petición /tv/pending retenida cuando hay algo para la TV */
function flushWaiters(){
  if(!waiters.length || (!pending && !actions.length)) return;
  var ws = waiters; waiters = [];
  var first = ws.shift();
  ws.forEach(function(w){ clearTimeout(w.t); sendJson(w.res, 200, { pending: null, actions: [] }); });
  clearTimeout(first.t); lastPoll = Date.now();
  var out = pending; pending = null; var acts = actions; actions = [];
  sendJson(first.res, 200, { pending: out, actions: acts });
}
function queueAction(a){
  a.id = ++actionSeq;
  actions.push(a);
  if(actions.length > 100) actions.splice(0, actions.length - 100);
  flushWaiters();
  return a.id;
}

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
var PAGE = "<!doctype html><html><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>TorBox TV</title><style>\n:root{--bg:#0b0f14;--s:#141b22;--s2:#1b242d;--t:#e8eef3;--m:#8b9aa8;--a:#17c964;--d:#ff6b6b;--w:#f5c451}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}\nmain{max-width:640px;margin:0 auto}h1{font-size:24px;margin:8px 0 4px}h1 b{color:var(--a)}h2{font-size:19px;margin:0 0 4px}h3{font-size:15px;color:var(--a);text-transform:uppercase;letter-spacing:.06em;margin:22px 0 0}p{color:var(--m);margin:0 0 12px}\n.card{background:var(--s);border-radius:14px;padding:18px;margin:14px 0}label{display:block;font-weight:600;margin:14px 0 6px}\nsmall{display:block;color:var(--m);font-weight:400;margin-top:4px;word-break:break-all}\ninput,select,textarea{width:100%;padding:12px 14px;font-size:16px;background:var(--bg);color:var(--t);border:1px solid var(--s2);border-radius:10px;font-family:inherit}\ntextarea{min-height:84px;resize:vertical}input:focus,select:focus,textarea:focus{outline:none;border-color:var(--a)}\nbutton{width:100%;margin-top:16px;padding:14px;font-size:17px;font-weight:700;border:0;border-radius:10px;background:var(--a);color:#06130c;cursor:pointer}\nbutton.sec{background:var(--s2);color:var(--t)}button:disabled{opacity:.5}\n.msg{margin-top:12px;padding:12px;border-radius:10px;display:none}.ok{display:block;background:rgba(23,201,100,.15);color:var(--a)}\n.err{display:block;background:rgba(255,107,107,.15);color:var(--d)}.pin{font-size:28px;letter-spacing:10px;text-align:center}\n.tabs{display:flex;gap:8px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;overflow-x:auto}.tabs a{flex:1 0 auto;text-align:center;padding:10px 14px;border-radius:10px;background:var(--s);color:var(--m);text-decoration:none;font-weight:600;white-space:nowrap}\n.tabs a.on{background:var(--a);color:#06130c}section{display:none}section.on{display:block}\n#log{background:#05080b;border-radius:10px;padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word}\n#log .e{color:var(--d)}#log .w{color:var(--w)}#log .i{color:#b8c4ce}#log time{color:#56636e;margin-right:6px}\n.row{display:flex;gap:8px}.row>*{flex:1}.row button{margin-top:10px}.row input{margin-top:10px}\n.top{display:flex;justify-content:space-between;align-items:center}.top select{width:auto;padding:6px 10px;font-size:14px}\n.dpad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:300px;margin:6px auto 0}.dpad button,.rc button{margin:0;padding:18px 0;font-size:22px;background:var(--s2);color:var(--t)}\n.dpad button.okb{background:var(--a);color:#06130c}.rc{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}.rc.r3{grid-template-columns:repeat(3,1fr)}\n.rc button{font-size:18px;padding:16px 0}\n.bar{height:10px;background:var(--s2);border-radius:6px;overflow:hidden;margin:10px 0 6px;cursor:pointer}.bar i{display:block;height:100%;width:0;background:var(--a)}\n.np-t{font-size:18px;font-weight:700}.np-s{color:var(--m)}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;margin-top:14px}\n.pc{background:var(--s);border-radius:10px;overflow:hidden;cursor:pointer;font-size:13px}.pc img,.pc .ph{width:100%;aspect-ratio:2/3;object-fit:cover;background:var(--s2);display:block}.pc .ph{display:flex;align-items:center;justify-content:center;color:var(--m);padding:6px;text-align:center}\n.pc div.n{padding:6px 8px;line-height:1.25}.pc div.n span{color:var(--m)}\n.det{display:flex;gap:14px}.det img{width:96px;border-radius:8px;flex:none;align-self:flex-start}.det p{margin:6px 0 0;font-size:14px}\n.eps{margin-top:10px}.ep{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--s2)}.ep span{flex:1;font-size:14px}.ep button{width:auto;margin:0;padding:8px 14px;font-size:14px}\n.li{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--s2);font-size:14px;word-break:break-all}.li span{flex:1}.li button{width:auto;margin:0;padding:6px 12px;font-size:14px}\npre{background:#05080b;border-radius:10px;padding:10px;overflow:auto;font-size:13px;white-space:pre-wrap;word-break:break-all;color:#b8c4ce}\nol{color:var(--m);padding-left:20px;margin:6px 0}details summary{cursor:pointer;font-weight:700;font-size:17px}\n.tv{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--s2)}.tv span{flex:1}.tv a{color:var(--a)}.tv button{width:auto;margin:0;padding:6px 12px;font-size:14px}\n</style></head><body><main>\n<div class=\"top\"><h1>Tor<b>Box</b> TV</h1><select id=\"wlang\"><option value=\"en\">English</option><option value=\"es\">Español</option></select></div>\n<p data-t=\"intro\"></p>\n<div class=\"card\"><label for=\"pin\" style=\"margin-top:0\"><span data-t=\"pin\"></span><small data-t=\"pinHelp\"></small></label>\n<input id=\"pin\" class=\"pin\" inputmode=\"numeric\" maxlength=\"4\" autocomplete=\"off\" placeholder=\"····\"></div>\n<nav class=\"tabs\"><a href=\"#\" data-tab=\"rem\" class=\"on\" data-t=\"tabRem\"></a><a href=\"#\" data-tab=\"srch\" data-t=\"tabSrch\"></a><a href=\"#\" data-tab=\"cfg\" data-t=\"tabCfg\"></a><a href=\"#\" data-tab=\"add\" data-t=\"tabAdd\"></a><a href=\"#\" data-tab=\"log\" data-t=\"tabLog\"></a></nav>\n\n<section id=\"t-rem\" class=\"on\">\n<div class=\"card\"><h2 data-t=\"np\"></h2><div id=\"npT\" class=\"np-t\"></div><div id=\"npS\" class=\"np-s\"></div>\n<div class=\"bar\" id=\"npBar\"><i id=\"npB\"></i></div><div id=\"npTm\" class=\"np-s\"></div></div>\n<div class=\"card\"><div class=\"dpad\">\n<span></span><button data-key=\"up\">▲</button><span></span>\n<button data-key=\"left\">◄</button><button data-key=\"ok\" class=\"okb\">OK</button><button data-key=\"right\">►</button>\n<span></span><button data-key=\"down\">▼</button><span></span></div>\n<div class=\"rc r3\"><button data-key=\"back\" data-t=\"rBack\"></button><button data-key=\"home\" data-t=\"rHome\"></button><button data-key=\"info\">ℹ</button></div>\n<div class=\"rc\"><button data-cmd=\"seek\" data-arg=\"-10\" title=\"-10 s\">⏪</button><button data-cmd=\"playpause\">⏯</button><button data-cmd=\"seek\" data-arg=\"10\" title=\"+10 s\">⏩</button><button data-cmd=\"stop\">⏹</button></div>\n<div id=\"mr\" class=\"msg\"></div></div>\n</section>\n\n<section id=\"t-srch\">\n<form id=\"fs\" class=\"card\"><h2 data-t=\"srchTitle\"></h2>\n<div class=\"row\"><select id=\"stype\" style=\"margin-top:10px;flex:0 0 38%\"><option value=\"movie\" data-t=\"sMovies\"></option><option value=\"series\" data-t=\"sSeries\"></option></select>\n<input id=\"sq\" autocomplete=\"off\" data-ph=\"sPh\"></div>\n<button id=\"bs\" type=\"submit\" data-t=\"sGo\"></button><div id=\"ms\" class=\"msg\"></div>\n<div id=\"sres\" class=\"grid\"></div></form>\n<div id=\"sdet\" class=\"card\" style=\"display:none\"></div>\n<form id=\"fp\" class=\"card\"><h2 data-t=\"linkTitle\"></h2><p data-t=\"linkHelp\"></p>\n<input id=\"purl\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"https://…\"><input id=\"ptitle\" autocomplete=\"off\" data-ph=\"addName\" style=\"margin-top:8px\">\n<button id=\"bp\" type=\"submit\" data-t=\"linkBtn\"></button><div id=\"mp\" class=\"msg\"></div></form>\n</section>\n\n<section id=\"t-cfg\" ><form id=\"f\" class=\"card\"><p data-t=\"cfgIntro\"></p><div id=\"fields\"></div>\n<button id=\"b\" type=\"submit\" data-t=\"send\"></button><div id=\"m\" class=\"msg\"></div></form>\n<div class=\"card\"><h2 data-t=\"verTitle\"></h2><p data-t=\"verIntro\"></p><div id=\"verInfo\"></div>\n<input id=\"verIn\" autocomplete=\"off\" placeholder=\"v2.4.1\" style=\"margin-top:10px\"><div class=\"row\"><button id=\"bvs\" class=\"sec\" type=\"button\" data-t=\"verSet\"></button><button id=\"bvc\" class=\"sec\" type=\"button\" data-t=\"verClear\"></button></div><div id=\"mv\" class=\"msg\"></div></div>\n<div class=\"card\"><h2 data-t=\"bkTitle\"></h2><p data-t=\"bkIntro\"></p>\n<div class=\"row\"><button id=\"bex\" class=\"sec\" type=\"button\" data-t=\"bkExport\"></button><button id=\"bim\" class=\"sec\" type=\"button\" data-t=\"bkImport\"></button></div>\n<input id=\"bfile\" type=\"file\" accept=\"application/json,.json\" style=\"display:none\"><div id=\"mb\" class=\"msg\"></div></div>\n</section>\n\n<section id=\"t-add\"><form id=\"fa\" class=\"card\"><h2 data-t=\"addTitle\"></h2><p data-t=\"addIntro\"></p>\n<textarea id=\"link\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"magnet:?xt=urn:btih:…  ·  https://…/file.nzb  ·  https://…\"></textarea>\n<label for=\"lname\" data-t=\"addName\"></label><input id=\"lname\" autocomplete=\"off\">\n<button id=\"ba\" type=\"submit\" data-t=\"addBtn\"></button><div id=\"ma\" class=\"msg\"></div></form>\n<div class=\"card\"><h2 data-t=\"shTitle\"></h2><p data-t=\"shIntro\"></p><pre id=\"shUrl\"></pre>\n<h3 data-t=\"shIosT\"></h3><ol id=\"shIos\"></ol><h3 data-t=\"shAndT\"></h3><ol id=\"shAnd\"></ol></div>\n</section>\n\n<section id=\"t-log\"><div class=\"card\"><h2 data-t=\"logTitle\"></h2><p data-t=\"logIntro\"></p>\n<div class=\"row\"><button id=\"bl\" class=\"sec\" type=\"button\" data-t=\"refresh\"></button><button id=\"bc\" class=\"sec\" type=\"button\" data-t=\"copy\"></button></div>\n<div id=\"ml\" class=\"msg\"></div><div id=\"log\" style=\"margin-top:12px\"></div></div></section>\n\n<div class=\"card\"><details><summary data-t=\"tvsTitle\"></summary><p style=\"margin-top:8px\" data-t=\"tvsIntro\"></p><div id=\"tvList\"></div>\n<div class=\"row\"><input id=\"tvName\" data-ph=\"tvName\" autocomplete=\"off\"><input id=\"tvIp\" data-ph=\"tvIp\" autocomplete=\"off\" inputmode=\"decimal\"></div>\n<button id=\"tvAdd\" class=\"sec\" type=\"button\" data-t=\"tvAdd\"></button><button id=\"tvThis\" class=\"sec\" type=\"button\" data-t=\"tvSaveThis\"></button></details></div>\n</main><script>\nvar T={\nen:{intro:\"Remote control for the TorBox app on your TV.\",pin:\"TV PIN\",pinHelp:\"Shown on the TV: TorBox start screen or Settings (or scan its QR code).\",tabCfg:\"Settings\",tabAdd:\"Add\",tabLog:\"Log\",tabRem:\"Remote\",tabSrch:\"Search\",\ncfgIntro:\"Changes apply on the TV instantly. Leave blank / unchanged what you don't want to change.\",send:\"Send to TV\",\naddTitle:\"Add to TorBox\",addIntro:\"Paste a magnet, hash, NZB link or URL (web download). The TV adds it to your account.\",addName:\"Name (optional)\",addBtn:\"Add\",\nlogTitle:\"App log\",logIntro:\"Messages and errors from the app on the TV (last 600). Updates automatically.\",refresh:\"Refresh\",copy:\"Copy\",\nunchanged:\"— unchanged —\",current:\"Current: \",notSet:\"Not set\",yes:\"Yes\",no:\"No\",\ngAccount:\"Account\",gLang:\"Language\",gSearch:\"Search\",gPlay:\"Playback\",gTrakt:\"Trakt\",gLive:\"Live TV\",gNotify:\"Notifications\",gFollow:\"Following\",gSync:\"Sync\",\ntorboxToken:\"TorBox API key\",torboxTokenH:\"torbox.app → Settings → API.\",stremioAddon:\"Stremio add-on (Search)\",stremioAddonH:\"Manifest URL of your add-on configured with TorBox (Torrentio, Comet, AIOStreams…), same as in Stremio.\",\ntmdbKey:\"TMDB key (artwork)\",tmdbKeyH:\"themoviedb.org → Settings → API: v3 API Key or v4 read token. Optional.\",\nuiLanguage:\"Interface language\",contentLanguage:\"Content language (synopses, episodes)\",sameUi:\"Same as interface\",\nautoPlayBest:\"Play best source with one click\",prefQuality:\"Preferred quality\",maxSizeGB:\"Max size\",noLimit:\"No limit\",prefAudio:\"Preferred audio\",any:\"Any\",\nhideUnsupported:\"Hide formats the TV can't play\",defaultSource:\"Default library source\",all:\"All\",audioLang:\"Preferred audio track\",subLang:\"Preferred subtitles\",original:\"Original\",none:\"None\",\nsubSize:\"Subtitle size\",small:\"Small\",medium:\"Medium\",large:\"Large\",autoplayNext:\"Autoplay next episode\",openSubs:\"OpenSubtitles subtitles\",notifyReady:\"Notify when downloads finish\",\ntraktClientId:\"Trakt Client ID\",traktClientIdH:\"Create an app at trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob), then link it from the TV: Settings → Trakt.\",traktClientSecret:\"Trakt Client Secret\",\nliveListUrl:\"Channel list URL\",liveListUrlH:\"Default: TDTChannels\",\nstremioAddons:\"Stremio add-ons (several)\",stremioAddonsH:\"Add Torrentio, Comet, MediaFusion, the TorBox add-on… Sources from all of them are merged.\",\nliveExtraLists:\"Extra channel lists\",liveExtraListsH:\"Extra M3U / JSON channel list URLs, added to the default one.\",\nntfyTopic:\"ntfy topic\",ntfyTopicH:\"Install the ntfy app on your phone and subscribe to this topic. Choose something hard to guess.\",ntfyTest:\"Send test notification\",ntfyOk:\"Notification sent. Check your phone.\",ntfyNeed:\"Type a topic first.\",\nfollowAuto:\"Auto-download new episodes of followed series\",\nsyncUrl:\"Sync URL (Worker)\",syncUrlH:\"Your Cloudflare Worker with KV, to sync Continue watching between devices. Empty = off.\",\nlistEmpty:\"None\",listAdd:\"Add\",listRemove:\"Remove\",listPh:\"https://…\",listSent:\"Sent.\",\nneedPin:\"Enter the 4-digit PIN shown on the TV.\",nothing:\"You didn't change anything.\",sent:\"Sent. The TV will apply the changes in a few seconds.\",saved:\"Saved. It will apply when you open TorBox on the TV.\",\ntvOff:\"TorBox is not open on the TV: changes will apply when you open it.\",noConn:\"Could not connect to the TV.\",pasteLink:\"Paste a link.\",adding:\"Sent to the TV, adding…\",addSaved:\"Saved. It will be added when you open TorBox on the TV.\",\nlogPin:\"Enter the PIN to see the log.\",noMsgs:\"No messages yet.\",copied:\"Copied.\",copyFail:\"Could not copy.\",\nnp:\"Now playing\",npNone:\"Nothing is playing on the TV.\",npOff:\"The TV app is not reachable.\",npPaused:\"Paused\",rBack:\"Back\",rHome:\"Home\",\nsrchTitle:\"Search and play on TV\",sMovies:\"Movies\",sSeries:\"Series\",sPh:\"Title…\",sGo:\"Search\",sNone:\"No results.\",sLoading:\"Loading…\",sBack:\"← Results\",sPlayTv:\"Play on TV\",sSeason:\"Season\",sSpecials:\"Specials\",sEp:\"Episode\",sFail:\"Could not reach Cinemeta.\",\nsentTv:\"Sent to the TV.\",linkTitle:\"Paste a link and play\",linkHelp:\"Direct video URL (mp4, mkv, m3u8…). The TV plays it right away.\",linkBtn:\"Play on TV\",pasteUrl:\"Paste a http(s) link.\",\nverTitle:\"App version\",verIntro:\"Pin the version of the installed TV app (it normally loads the latest one). Applies the next time the app starts.\",verCur:\"Running: \",verPinned:\"Pinned: \",verLatest:\"latest (not pinned)\",verSet:\"Pin version\",verClear:\"Use latest\",verOk:\"Version updated.\",verBad:\"Enter a version like v2.4.1.\",\nbkTitle:\"Backup\",bkIntro:\"Export settings, watch history, favourite channels and followed series to a file, or restore them from one. The file contains your API keys: keep it private.\",bkExport:\"Export settings\",bkImport:\"Import settings\",bkWait:\"Waiting for the TV…\",bkDone:\"Backup downloaded.\",bkBad:\"Not a valid backup file.\",bkFail:\"The TV did not answer.\",\nshTitle:\"Share → Send to TorBox TV\",shIntro:\"Create a shortcut so that Share → TorBox TV adds a link to your account. It calls this address (the PIN changes if the TV service restarts):\",\nshIosT:\"iPhone / iPad (Shortcuts)\",shAndT:\"Android (HTTP Shortcuts app)\",\nshIos:[\"Open Shortcuts → + → name it “TorBox TV”.\",\"Add “Receive input from Share Sheet” (types: URLs and Text).\",\"Add “URL Encode” on Shortcut Input.\",\"Add “Get Contents of URL”: URL = the address above, with LINK replaced by the URL Encode result.\",\"Add “Show Result” (optional). Enable “Show in Share Sheet”.\"],\nshAnd:[\"Install HTTP Shortcuts, tap + → Regular shortcut.\",\"Method GET, URL = the address above, replacing LINK with the variable {shared text} (create a variable of type “Share”).\",\"Under Settings enable “Show in Share dialog”.\"],\ntvsTitle:\"My TVs\",tvsIntro:\"Save several TVs and switch between them.\",tvName:\"Name\",tvIp:\"IP address\",tvAdd:\"Save TV\",tvSaveThis:\"Save this TV\",tvOpen:\"Open\",tvDel:\"Delete\",tvNone:\"No saved TVs.\",tvHere:\"(this one)\"},\nes:{intro:\"Control remoto de la app TorBox de la TV.\",pin:\"PIN de la TV\",pinHelp:\"Aparece en la TV: pantalla de inicio de TorBox o Ajustes (o escanea su código QR).\",tabCfg:\"Ajustes\",tabAdd:\"Añadir\",tabLog:\"Registro\",tabRem:\"Mando\",tabSrch:\"Buscar\",\ncfgIntro:\"Los cambios se aplican en la TV al instante. Deja vacío / sin cambios lo que no quieras cambiar.\",send:\"Enviar a la TV\",\naddTitle:\"Añadir a TorBox\",addIntro:\"Pega un magnet, un hash, un enlace NZB o una URL (descarga web). La TV lo añade a tu cuenta.\",addName:\"Nombre (opcional)\",addBtn:\"Añadir\",\nlogTitle:\"Registro de la app\",logIntro:\"Mensajes y errores de la app en la TV (últimos 600). Se actualiza solo.\",refresh:\"Actualizar\",copy:\"Copiar\",\nunchanged:\"— sin cambios —\",current:\"Actual: \",notSet:\"Sin configurar\",yes:\"Sí\",no:\"No\",\ngAccount:\"Cuenta\",gLang:\"Idioma\",gSearch:\"Buscar\",gPlay:\"Reproducción\",gTrakt:\"Trakt\",gLive:\"TV en directo\",gNotify:\"Notificaciones\",gFollow:\"Series seguidas\",gSync:\"Sincronización\",\ntorboxToken:\"API key de TorBox\",torboxTokenH:\"torbox.app → Settings → API.\",stremioAddon:\"Add-on de Stremio (Buscar)\",stremioAddonH:\"URL del manifest de tu add-on con TorBox (Torrentio, Comet, AIOStreams…), la misma que en Stremio.\",\ntmdbKey:\"Clave TMDB (carátulas)\",tmdbKeyH:\"themoviedb.org → Ajustes → API: API Key v3 o token de lectura v4. Opcional.\",\nuiLanguage:\"Idioma de la interfaz\",contentLanguage:\"Idioma del contenido (sinopsis, episodios)\",sameUi:\"Igual que la interfaz\",\nautoPlayBest:\"Reproducir la mejor fuente en un clic\",prefQuality:\"Calidad preferida\",maxSizeGB:\"Tamaño máximo\",noLimit:\"Sin límite\",prefAudio:\"Audio preferido\",any:\"Cualquiera\",\nhideUnsupported:\"Ocultar formatos que la TV no reproduce\",defaultSource:\"Fuente por defecto de la biblioteca\",all:\"Todas\",audioLang:\"Pista de audio preferida\",subLang:\"Subtítulos preferidos\",original:\"Original\",none:\"Ninguno\",\nsubSize:\"Tamaño de subtítulos\",small:\"Pequeño\",medium:\"Mediano\",large:\"Grande\",autoplayNext:\"Siguiente episodio automático\",openSubs:\"Subtítulos de OpenSubtitles\",notifyReady:\"Avisar al terminar descargas\",\ntraktClientId:\"Trakt Client ID\",traktClientIdH:\"Crea una app en trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob) y vincúlala desde la TV: Ajustes → Trakt.\",traktClientSecret:\"Trakt Client Secret\",\nliveListUrl:\"URL de la lista de canales\",liveListUrlH:\"Por defecto: TDTChannels\",\nstremioAddons:\"Add-ons de Stremio (varios)\",stremioAddonsH:\"Añade Torrentio, Comet, MediaFusion, el add-on de TorBox… Se fusionan las fuentes de todos.\",\nliveExtraLists:\"Listas de canales extra\",liveExtraListsH:\"URLs de listas de canales M3U / JSON adicionales, se suman a la de por defecto.\",\nntfyTopic:\"Tema de ntfy\",ntfyTopicH:\"Instala la app ntfy en el móvil y suscríbete a este tema. Elige algo difícil de adivinar.\",ntfyTest:\"Enviar notificación de prueba\",ntfyOk:\"Notificación enviada. Mira tu móvil.\",ntfyNeed:\"Escribe primero un tema.\",\nfollowAuto:\"Descargar automáticamente episodios nuevos de series seguidas\",\nsyncUrl:\"URL de sincronización (Worker)\",syncUrlH:\"Tu Cloudflare Worker con KV, para sincronizar Continuar viendo entre dispositivos. Vacío = desactivado.\",\nlistEmpty:\"Ninguno\",listAdd:\"Añadir\",listRemove:\"Quitar\",listPh:\"https://…\",listSent:\"Enviado.\",\nneedPin:\"Introduce el PIN de 4 cifras que muestra la TV.\",nothing:\"No has cambiado nada.\",sent:\"Enviado. La TV aplicará los cambios en unos segundos.\",saved:\"Guardado. Se aplicará cuando abras TorBox en la TV.\",\ntvOff:\"La TV no tiene TorBox abierto: los cambios se aplicarán al abrirlo.\",noConn:\"No se pudo conectar con la TV.\",pasteLink:\"Pega un enlace.\",adding:\"Enviado a la TV, añadiendo…\",addSaved:\"Guardado. Se añadirá cuando abras TorBox en la TV.\",\nlogPin:\"Introduce el PIN para ver el registro.\",noMsgs:\"Sin mensajes todavía.\",copied:\"Copiado.\",copyFail:\"No se pudo copiar.\",\nnp:\"Reproduciendo ahora\",npNone:\"No se está reproduciendo nada en la TV.\",npOff:\"No se alcanza la app de la TV.\",npPaused:\"En pausa\",rBack:\"Atrás\",rHome:\"Inicio\",\nsrchTitle:\"Buscar y ver en la TV\",sMovies:\"Películas\",sSeries:\"Series\",sPh:\"Título…\",sGo:\"Buscar\",sNone:\"Sin resultados.\",sLoading:\"Cargando…\",sBack:\"← Resultados\",sPlayTv:\"Ver en la TV\",sSeason:\"Temporada\",sSpecials:\"Especiales\",sEp:\"Episodio\",sFail:\"No se pudo consultar Cinemeta.\",\nsentTv:\"Enviado a la TV.\",linkTitle:\"Pegar enlace y reproducir\",linkHelp:\"URL directa de vídeo (mp4, mkv, m3u8…). La TV la reproduce al momento.\",linkBtn:\"Ver en la TV\",pasteUrl:\"Pega un enlace http(s).\",\nverTitle:\"Versión de la app\",verIntro:\"Fija la versión de la app instalada en la TV (normalmente carga la última). Se aplica en el próximo arranque de la app.\",verCur:\"En uso: \",verPinned:\"Fijada: \",verLatest:\"la última (sin fijar)\",verSet:\"Fijar versión\",verClear:\"Usar la última\",verOk:\"Versión actualizada.\",verBad:\"Escribe una versión como v2.4.1.\",\nbkTitle:\"Copia de seguridad\",bkIntro:\"Exporta ajustes, historial, canales favoritos y series seguidas a un archivo, o restáuralos desde uno. El archivo contiene tus API keys: guárdalo en privado.\",bkExport:\"Exportar ajustes\",bkImport:\"Importar ajustes\",bkWait:\"Esperando a la TV…\",bkDone:\"Copia descargada.\",bkBad:\"Archivo de copia no válido.\",bkFail:\"La TV no respondió.\",\nshTitle:\"Compartir → Enviar a TorBox TV\",shIntro:\"Crea un atajo para que Compartir → TorBox TV añada un enlace a tu cuenta. Llama a esta dirección (el PIN cambia si se reinicia el servicio de la TV):\",\nshIosT:\"iPhone / iPad (Atajos)\",shAndT:\"Android (app HTTP Shortcuts)\",\nshIos:[\"Abre Atajos → + → ponle nombre “TorBox TV”.\",\"Añade “Recibir entrada de la hoja de compartir” (tipos: URL y Texto).\",\"Añade “Codificar URL” sobre la Entrada del atajo.\",\"Añade “Obtener contenido de URL”: URL = la dirección de arriba, cambiando LINK por el resultado de Codificar URL.\",\"Añade “Mostrar resultado” (opcional). Activa “Mostrar en la hoja de compartir”.\"],\nshAnd:[\"Instala HTTP Shortcuts, pulsa + → Atajo normal.\",\"Método GET, URL = la dirección de arriba, cambiando LINK por la variable {texto compartido} (crea una variable de tipo “Compartir”).\",\"En Ajustes activa “Mostrar en el diálogo de compartir”.\"],\ntvsTitle:\"Mis TVs\",tvsIntro:\"Guarda varias TVs y cambia entre ellas.\",tvName:\"Nombre\",tvIp:\"Dirección IP\",tvAdd:\"Guardar TV\",tvSaveThis:\"Guardar esta TV\",tvOpen:\"Abrir\",tvDel:\"Borrar\",tvNone:\"No hay TVs guardadas.\",tvHere:\"(esta)\"}};\n/* Campos: [clave, tipo, opciones] — tipo: text | secret | sel | bool | list | test */\nvar F=[[\"gAccount\"],[\"torboxToken\",\"secret\"],[\"stremioAddon\",\"secret\"],[\"tmdbKey\",\"secret\"],\n[\"gLang\"],[\"uiLanguage\",\"sel\",[[\"en\",\"English\"],[\"es\",\"Español\"]]],[\"contentLanguage\",\"sel\",[[\"auto\",\"@sameUi\"],[\"en\",\"English\"],[\"es\",\"Español\"]]],\n[\"gSearch\"],[\"stremioAddons\",\"list\"],[\"autoPlayBest\",\"bool\"],[\"prefQuality\",\"sel\",[[\"2160p\",\"4K / 2160p\"],[\"1080p\",\"1080p\"],[\"720p\",\"720p\"]]],[\"maxSizeGB\",\"sel\",[[0,\"@noLimit\"],[2,\"2 GB\"],[4,\"4 GB\"],[8,\"8 GB\"],[15,\"15 GB\"],[30,\"30 GB\"]]],\n[\"prefAudio\",\"sel\",[[\"es\",\"Castellano\"],[\"lat\",\"Latino\"],[\"en\",\"English\"],[\"any\",\"@any\"]]],[\"hideUnsupported\",\"bool\"],\n[\"gFollow\"],[\"followAuto\",\"bool\"],\n[\"gPlay\"],[\"audioLang\",\"sel\",[[\"spa\",\"Español\"],[\"eng\",\"English\"],[\"\",\"@original\"]]],[\"subLang\",\"sel\",[[\"spa\",\"Español\"],[\"eng\",\"English\"],[\"\",\"@none\"]]],\n[\"subSize\",\"sel\",[[\"s\",\"@small\"],[\"m\",\"@medium\"],[\"l\",\"@large\"]]],[\"autoplayNext\",\"bool\"],[\"openSubs\",\"bool\"],[\"notifyReady\",\"bool\"],[\"defaultSource\",\"sel\",[[\"all\",\"@all\"],[\"torrents\",\"Torrents\"],[\"usenet\",\"Usenet\"],[\"webdl\",\"Web\"]]],\n[\"gNotify\"],[\"ntfyTopic\",\"text\"],[\"ntfyTest\",\"test\"],\n[\"gSync\"],[\"syncUrl\",\"text\"],\n[\"gTrakt\"],[\"traktClientId\",\"secret\"],[\"traktClientSecret\",\"secret\"],[\"gLive\"],[\"liveListUrl\",\"text\"],[\"liveExtraLists\",\"list\"]];\nvar $=function(i){return document.getElementById(i)},L=\"en\",snap={},state={},lines=[];\ntry{L=localStorage.getItem(\"tblang\")||((navigator.language||\"\").slice(0,2)===\"es\"?\"es\":\"en\")}catch(e){}\nfunction t(k){return (T[L]&&T[L][k])||T.en[k]||k}\nfunction esc(s){return String(s).replace(/[&<>\"]/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c]})}\nfunction lbl(x){return x&&x.charAt&&x.charAt(0)===\"@\"?t(x.slice(1)):x}\nfunction curLabel(opts,v){for(var i=0;i<opts.length;i++)if(String(opts[i][0])===String(v))return lbl(opts[i][1]);return String(v)}\nfunction renderFields(){var h=\"\";F.forEach(function(f){var k=f[0],ty=f[1];\n if(!ty){h+=\"<h3>\"+esc(t(k))+\"</h3>\";return}\n var help=T.en[k+\"H\"]?t(k+\"H\"):\"\",cur=snap[k];\n if(ty===\"test\"){h+='<button type=\"button\" class=\"sec\" data-ntfy=\"1\">'+esc(t(\"ntfyTest\"))+'</button><div id=\"mn\" class=\"msg\"></div>';return}\n if(ty===\"list\"){var arr=cur||[];\n  h+='<label>'+esc(t(k))+(help?'<small>'+esc(help)+'</small>':'')+'</label><div data-list=\"'+k+'\">'+(arr.length?arr.map(function(u,i){return '<div class=\"li\"><span>'+esc(u)+'</span><button type=\"button\" class=\"sec\" data-rm=\"'+k+'\" data-i=\"'+i+'\">'+esc(t(\"listRemove\"))+'</button></div>'}).join(\"\"):'<small>'+esc(t(\"listEmpty\"))+'</small>')+\n  '</div><div class=\"row\"><input data-addin=\"'+k+'\" placeholder=\"'+esc(t(\"listPh\"))+'\" autocomplete=\"off\" spellcheck=\"false\"><button type=\"button\" class=\"sec\" data-add=\"'+k+'\" style=\"flex:0 0 30%\">'+esc(t(\"listAdd\"))+'</button></div>';return}\n if(ty===\"secret\"||ty===\"text\"){h+='<label for=\"f_'+k+'\">'+esc(t(k))+'<small>'+esc(help)+(help?\" \":\"\")+esc(cur?t(\"current\")+cur:(ty===\"secret\"?t(\"notSet\"):\"\"))+'</small></label><input id=\"f_'+k+'\" data-k=\"'+k+'\" data-ty=\"'+ty+'\" autocomplete=\"off\" spellcheck=\"false\">';return}\n var opts=ty===\"bool\"?[[true,t(\"yes\")],[false,t(\"no\")]]:f[2];\n h+='<label for=\"f_'+k+'\">'+esc(t(k))+'</label><select id=\"f_'+k+'\" data-k=\"'+k+'\" data-ty=\"'+ty+'\"><option value=\"__\">'+esc(t(\"unchanged\"))+(cur!==undefined?\" (\"+esc(curLabel(opts,cur))+\")\":\"\")+'</option>';\n opts.forEach(function(o){h+='<option value=\"'+esc(JSON.stringify(o[0]))+'\">'+esc(lbl(o[1]))+'</option>'});h+=\"</select>\"});\n $(\"fields\").innerHTML=h}\nfunction renderVer(){var p=state.pinnedVersion;$(\"verInfo\").innerHTML=\"<p>\"+esc(t(\"verCur\")+(snap.appVersion||state.version||\"?\"))+\" · \"+esc(t(\"verPinned\")+(p||t(\"verLatest\")))+\"</p>\"}\nvar shSteps=function(id,key){$(id).innerHTML=T[L][key].map(function(s){return \"<li>\"+esc(s)+\"</li>\"}).join(\"\")};\nfunction renderShare(){var pn=\"\";try{pn=localStorage.getItem(\"tbpin\")||\"\"}catch(e){}$(\"shUrl\").textContent=location.origin+\"/api/add?pin=\"+(pn||\"1234\")+\"&link=LINK\";shSteps(\"shIos\",\"shIos\");shSteps(\"shAnd\",\"shAnd\")}\nfunction applyLang(){document.documentElement.lang=L;$(\"wlang\").value=L;var n=document.querySelectorAll(\"[data-t]\");for(var i=0;i<n.length;i++)n[i].textContent=t(n[i].getAttribute(\"data-t\"));\n n=document.querySelectorAll(\"[data-ph]\");for(i=0;i<n.length;i++)n[i].placeholder=t(n[i].getAttribute(\"data-ph\"));\n renderFields();renderVer();renderShare();renderTvs();pollStatus();if(!lines.length)$(\"log\").textContent=t(\"logPin\")}\n$(\"wlang\").addEventListener(\"change\",function(){L=this.value;try{localStorage.setItem(\"tblang\",L)}catch(e){}applyLang()});\n/* PIN: ?pin=XXXX (del QR de la TV) o el guardado */\ntry{var qp=new URLSearchParams(location.search).get(\"pin\");if(qp&&/^\\d{4}$/.test(qp)){localStorage.setItem(\"tbpin\",qp);history.replaceState(null,\"\",location.pathname)}}catch(e){}\ntry{$(\"pin\").value=localStorage.getItem(\"tbpin\")||\"\"}catch(e){}\n$(\"pin\").addEventListener(\"input\",function(){try{if(/^\\d{4}$/.test(this.value))localStorage.setItem(\"tbpin\",this.value)}catch(e){}renderShare()});\nfunction msg(id,s,ok){var m=$(id);m.textContent=s;m.className=\"msg \"+(ok?\"ok\":\"err\")}\nfunction pinOk(){var p=$(\"pin\").value.trim();if(!/^\\d{4}$/.test(p))return null;try{localStorage.setItem(\"tbpin\",p)}catch(e){}return p}\nfunction post(u,o){return fetch(u,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(o)}).then(function(r){return r.json()})}\n/* Acción remota: {type:…}. Devuelve la promesa del JSON ({ok,id,detail}) */\nfunction act(a,msgId){var pin=pinOk();if(!pin){if(msgId)msg(msgId,t(\"needPin\"),false);return Promise.resolve({ok:false})}\n return post(\"/api/action\",{pin:pin,action:a}).then(function(j){if(!j.ok&&msgId)msg(msgId,j.detail||\"Error\",false);return j}).catch(function(){if(msgId)msg(msgId,t(\"noConn\"),false);return {ok:false}})}\nfunction waitResult(id,cb,tries){tries=tries||20;(function poll(n){fetch(\"/api/actionresult?id=\"+id).then(function(r){return r.json()}).then(function(r){\n if(r.result)cb(r.result);else if(n<tries)setTimeout(function(){poll(n+1)},1000);else cb(null)}).catch(function(){cb(null)})})(0)}\nvar tabs=document.querySelectorAll(\".tabs a\"),curTab=\"rem\";\nfunction showTab(tb){curTab=tb;for(var j=0;j<tabs.length;j++){var on=tabs[j].getAttribute(\"data-tab\")===tb;tabs[j].classList.toggle(\"on\",on);$(\"t-\"+tabs[j].getAttribute(\"data-tab\")).classList.toggle(\"on\",on)}\n if(tb===\"log\")loadLogs(true);if(tb===\"rem\")pollStatus();if(tb===\"cfg\")load();try{sessionStorage.setItem(\"tbtab\",tb)}catch(e){}}\nfor(var i=0;i<tabs.length;i++)tabs[i].addEventListener(\"click\",function(e){e.preventDefault();showTab(this.getAttribute(\"data-tab\"))});\nfunction load(){fetch(\"/api/state\").then(function(r){return r.json()}).then(function(j){snap=j.snapshot||{};state=j;\n if(!localStorage.getItem(\"tblang\")&&snap.uiLanguage&&T[snap.uiLanguage])L=snap.uiLanguage;applyLang();\n if(!j.tvOnline)msg(\"m\",t(\"tvOff\"),false)}).catch(function(){applyLang()})}\nload();try{var st0=sessionStorage.getItem(\"tbtab\");if(st0&&$(\"t-\"+st0))showTab(st0)}catch(e){}\n/* ---- Mando ---- */\nfunction fmt(s){s=Math.max(0,Math.floor(s||0));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return(h?h+\":\"+(m<10?\"0\":\"\"):\"\")+m+\":\"+(x<10?\"0\":\"\")+x}\nvar lastSt=null;\nfunction pollStatus(){clearTimeout(pollStatus.t);if(curTab!==\"rem\")return;\n fetch(\"/api/status\").then(function(r){return r.json()}).then(function(j){var s=j.status;lastSt=s;\n  if(!j.tvOnline){$(\"npT\").textContent=t(\"npOff\");$(\"npS\").textContent=\"\";$(\"npTm\").textContent=\"\";$(\"npB\").style.width=\"0\"}\n  else if(s&&s.active){$(\"npT\").textContent=s.title||\"\";$(\"npS\").textContent=(s.paused?\"⏸ \"+t(\"npPaused\")+(s.subtitle?\" · \":\"\"):\"\")+(s.subtitle||\"\");\n   $(\"npTm\").textContent=s.live?\"LIVE\":fmt(s.pos)+\" / \"+fmt(s.dur);$(\"npB\").style.width=(s.dur>0?Math.min(100,100*s.pos/s.dur):0)+\"%\"}\n  else{$(\"npT\").textContent=t(\"npNone\");$(\"npS\").textContent=\"\";$(\"npTm\").textContent=\"\";$(\"npB\").style.width=\"0\"}}).catch(function(){});\n pollStatus.t=setTimeout(pollStatus,2000)}\n$(\"npBar\").addEventListener(\"click\",function(e){if(!lastSt||!lastSt.active||!(lastSt.dur>0)||lastSt.live)return;var r=this.getBoundingClientRect();act({type:\"control\",cmd:\"seekTo\",arg:Math.floor(lastSt.dur*(e.clientX-r.left)/r.width)},\"mr\")});\nvar rem=document.querySelectorAll(\"#t-rem button[data-key],#t-rem button[data-cmd]\");\nfor(i=0;i<rem.length;i++)rem[i].addEventListener(\"click\",function(){var k=this.getAttribute(\"data-key\"),c=this.getAttribute(\"data-cmd\");\n try{navigator.vibrate&&navigator.vibrate(15)}catch(e){}\n var a=k?{type:\"key\",key:k}:{type:\"control\",cmd:c};if(this.getAttribute(\"data-arg\"))a.arg=Number(this.getAttribute(\"data-arg\"));\n act(a,\"mr\").then(function(j){if(j.ok)$(\"mr\").className=\"msg\"})});\n/* ---- Buscar (Cinemeta) ---- */\nvar CM=\"https://v3-cinemeta.strem.io/\";\nfunction playMsg(id,j){if(!j.ok)return;msg(id,j.tvOnline?t(\"sentTv\"):t(\"tvOff\"),true)}\n$(\"fs\").addEventListener(\"submit\",function(e){e.preventDefault();var q=$(\"sq\").value.trim();if(!q)return;var ty=$(\"stype\").value;\n $(\"sdet\").style.display=\"none\";$(\"sres\").innerHTML=\"\";msg(\"ms\",t(\"sLoading\"),true);\n fetch(CM+\"catalog/\"+ty+\"/top/search=\"+encodeURIComponent(q)+\".json\").then(function(r){return r.json()}).then(function(j){\n  var ms=(j.metas||[]).slice(0,30);$(\"ms\").className=\"msg\";if(!ms.length){msg(\"ms\",t(\"sNone\"),false);return}\n  $(\"sres\").innerHTML=ms.map(function(m,i){return '<div class=\"pc\" data-i=\"'+i+'\">'+(m.poster?'<img loading=\"lazy\" src=\"'+esc(m.poster)+'\" alt=\"\">':'<div class=\"ph\">'+esc(m.name)+'</div>')+'<div class=\"n\">'+esc(m.name)+'<br><span>'+esc(m.releaseInfo||\"\")+'</span></div></div>'}).join(\"\");\n  $(\"sres\").metas=ms;$(\"sres\").mtype=ty}).catch(function(){msg(\"ms\",t(\"sFail\"),false)})});\n$(\"sres\").addEventListener(\"click\",function(e){var el=e.target;while(el&&el!==this&&!el.getAttribute(\"data-i\"))el=el.parentNode;if(!el||el===this)return;openMeta(this.metas[Number(el.getAttribute(\"data-i\"))],this.mtype)});\nfunction openMeta(m,ty){var box=$(\"sdet\");box.style.display=\"block\";box.innerHTML=\"<p>\"+esc(t(\"sLoading\"))+\"</p>\";box.scrollIntoView({behavior:\"smooth\"});\n fetch(CM+\"meta/\"+ty+\"/\"+encodeURIComponent(m.id)+\".json\").then(function(r){return r.json()}).then(function(j){drawMeta(j.meta||m,ty)}).catch(function(){drawMeta(m,ty)})}\nfunction drawMeta(m,ty){var box=$(\"sdet\"),h='<div class=\"det\">'+(m.poster?'<img src=\"'+esc(m.poster)+'\" alt=\"\">':\"\")+'<div><h2>'+esc(m.name||\"\")+'</h2><small>'+esc(m.releaseInfo||\"\")+(m.imdbRating?\" · ★ \"+esc(m.imdbRating):\"\")+'</small><p>'+esc((m.description||\"\").slice(0,320))+'</p></div></div>';\n var vids=(m.videos||[]).filter(function(v){return v.season!==undefined&&v.episode!==undefined});\n if(ty===\"series\"&&vids.length){var seasons=[];vids.forEach(function(v){if(seasons.indexOf(v.season)<0)seasons.push(v.season)});seasons.sort(function(a,b){return a-b});\n  var first=seasons.filter(function(s){return s>0})[0];if(first===undefined)first=seasons[0];\n  h+='<label>'+esc(t(\"sSeason\"))+'</label><select id=\"sSeason\">'+seasons.map(function(s){return '<option value=\"'+s+'\"'+(s===first?\" selected\":\"\")+'>'+(s===0?esc(t(\"sSpecials\")):s)+'</option>'}).join(\"\")+'</select><div class=\"eps\" id=\"eps\"></div>'}\n else h+='<button id=\"bplayTv\" type=\"button\">▶ '+esc(t(\"sPlayTv\"))+'</button>';\n h+='<div id=\"mdet\" class=\"msg\"></div><button class=\"sec\" type=\"button\" id=\"bback\">'+esc(t(\"sBack\"))+'</button>';box.innerHTML=h;\n $(\"bback\").onclick=function(){box.style.display=\"none\";$(\"sres\").scrollIntoView()};\n function playEp(season,episode,title){act({type:\"play\",mediaType:ty,imdbId:m.id,season:season,episode:episode,title:title},\"mdet\").then(function(j){playMsg(\"mdet\",j)})}\n if($(\"bplayTv\"))$(\"bplayTv\").onclick=function(){playEp(undefined,undefined,m.name)};\n if($(\"sSeason\")){var draw=function(){var s=Number($(\"sSeason\").value);\n   $(\"eps\").innerHTML=vids.filter(function(v){return v.season===s}).sort(function(a,b){return a.episode-b.episode}).map(function(v){return '<div class=\"ep\"><span>'+v.episode+'. '+esc(v.title||v.name||(t(\"sEp\")+\" \"+v.episode))+'</span><button type=\"button\" data-ep=\"'+v.episode+'\">▶ '+esc(t(\"sPlayTv\"))+'</button></div>'}).join(\"\")};\n  draw();$(\"sSeason\").onchange=draw;\n  $(\"eps\").onclick=function(e){var b=e.target;if(!b.getAttribute||!b.getAttribute(\"data-ep\"))return;var ep=Number(b.getAttribute(\"data-ep\"));playEp(Number($(\"sSeason\").value),ep,m.name+\" S\"+$(\"sSeason\").value+\"E\"+ep)}}}\n$(\"fp\").addEventListener(\"submit\",function(e){e.preventDefault();var u=$(\"purl\").value.trim();if(!/^https?:\\/\\//i.test(u)){msg(\"mp\",t(\"pasteUrl\"),false);return}\n act({type:\"playUrl\",url:u,title:$(\"ptitle\").value.trim()},\"mp\").then(function(j){playMsg(\"mp\",j);if(j.ok){$(\"purl\").value=\"\";$(\"ptitle\").value=\"\"}})});\n/* ---- Ajustes ---- */\n$(\"f\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();if(!pin){msg(\"m\",t(\"needPin\"),false);return}\n var s={},els=document.querySelectorAll(\"#fields [data-k]\");\n for(var i=0;i<els.length;i++){var el=els[i],k=el.getAttribute(\"data-k\");\n  if(el.tagName===\"INPUT\"){var v=el.value.trim();if(v)s[k]=v}else if(el.value!==\"__\"){s[k]=JSON.parse(el.value)}}\n if(!Object.keys(s).length){msg(\"m\",t(\"nothing\"),false);return}\n $(\"b\").disabled=true;post(\"/api/settings\",{pin:pin,settings:s}).then(function(j){$(\"b\").disabled=false;\n  if(j.ok){var ins=document.querySelectorAll(\"#fields input[data-k]\");for(var i=0;i<ins.length;i++)ins[i].value=\"\";msg(\"m\",j.tvOnline?t(\"sent\"):t(\"saved\"),true);setTimeout(load,2500)}\n  else msg(\"m\",j.detail||\"Error\",false)}).catch(function(){$(\"b\").disabled=false;msg(\"m\",t(\"noConn\"),false)})});\nfunction sendOps(k,ops){var pin=pinOk();if(!pin){msg(\"m\",t(\"needPin\"),false);return}var s={};s[k]={ops:ops};\n post(\"/api/settings\",{pin:pin,settings:s}).then(function(j){if(j.ok){msg(\"m\",t(\"listSent\"),true);setTimeout(load,1500)}else msg(\"m\",j.detail||\"Error\",false)}).catch(function(){msg(\"m\",t(\"noConn\"),false)})}\n$(\"fields\").addEventListener(\"click\",function(e){var b=e.target;if(!b.getAttribute)return;\n if(b.getAttribute(\"data-rm\")){sendOps(b.getAttribute(\"data-rm\"),[{op:\"remove\",index:Number(b.getAttribute(\"data-i\"))}]);return}\n var ak=b.getAttribute(\"data-add\");if(ak){var inp=document.querySelector('[data-addin=\"'+ak+'\"]'),v=inp.value.trim();if(!v)return;inp.value=\"\";sendOps(ak,[{op:\"add\",value:v}]);return}\n if(b.getAttribute(\"data-ntfy\")){var tp=((document.getElementById(\"f_ntfyTopic\")||{}).value||\"\").trim()||String(snap.ntfyTopic||\"\");tp=tp.replace(/[^A-Za-z0-9_-]/g,\"\");\n  if(!tp){msg(\"mn\",t(\"ntfyNeed\"),false);return}\n  fetch(\"https://ntfy.sh/\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({topic:tp,title:\"TorBox TV\",message:\"Test ✓\",tags:[\"tv\"]})}).then(function(r){if(!r.ok)throw 0;msg(\"mn\",t(\"ntfyOk\"),true)}).catch(function(){msg(\"mn\",t(\"noConn\"),false)})}});\n/* Versión fijada */\nfunction setPin(v){var pin=pinOk();if(!pin){msg(\"mv\",t(\"needPin\"),false);return}\n if(v&&!/^v?\\d+\\.\\d+\\.\\d+$/.test(v)){msg(\"mv\",t(\"verBad\"),false);return}\n post(\"/api/pin\",{pin:pin,version:v}).then(function(j){if(j.ok){state.pinnedVersion=j.pinned;renderVer();msg(\"mv\",t(\"verOk\"),true)}else msg(\"mv\",j.detail||\"Error\",false)}).catch(function(){msg(\"mv\",t(\"noConn\"),false)})}\n$(\"bvs\").addEventListener(\"click\",function(){setPin($(\"verIn\").value.trim())});$(\"bvc\").addEventListener(\"click\",function(){$(\"verIn\").value=\"\";setPin(\"\")});\n/* Copia de seguridad */\n$(\"bex\").addEventListener(\"click\",function(){msg(\"mb\",t(\"bkWait\"),true);act({type:\"export\"},\"mb\").then(function(j){if(!j.ok)return;\n waitResult(j.id,function(r){if(!r||!r.data){msg(\"mb\",r&&r.message?r.message:t(\"bkFail\"),false);return}\n  var a=document.createElement(\"a\"),blob=new Blob([JSON.stringify(r.data,null,1)],{type:\"application/json\"});a.href=URL.createObjectURL(blob);a.download=\"torbox-backup-\"+new Date().toISOString().slice(0,10)+\".json\";\n  document.body.appendChild(a);a.click();document.body.removeChild(a);msg(\"mb\",t(\"bkDone\"),true)},25)})});\n$(\"bim\").addEventListener(\"click\",function(){if(!pinOk()){msg(\"mb\",t(\"needPin\"),false);return}$(\"bfile\").click()});\n$(\"bfile\").addEventListener(\"change\",function(){var f=this.files[0];this.value=\"\";if(!f)return;var rd=new FileReader();\n rd.onload=function(){var d;try{d=JSON.parse(rd.result)}catch(e){d=null}\n  if(!d||typeof d!==\"object\"||!d.settings){msg(\"mb\",t(\"bkBad\"),false);return}\n  msg(\"mb\",t(\"bkWait\"),true);act({type:\"import\",data:d},\"mb\").then(function(j){if(!j.ok)return;waitResult(j.id,function(r){msg(\"mb\",r?r.message:t(\"bkFail\"),!!(r&&r.ok));setTimeout(load,1500)},25)})};rd.readAsText(f)});\n/* ---- Añadir ---- */\n$(\"fa\").addEventListener(\"submit\",function(e){e.preventDefault();var pin=pinOk();if(!pin){msg(\"ma\",t(\"needPin\"),false);return}\n var link=$(\"link\").value.trim();if(!link){msg(\"ma\",t(\"pasteLink\"),false);return}\n $(\"ba\").disabled=true;post(\"/api/add\",{pin:pin,link:link,name:$(\"lname\").value.trim()}).then(function(j){$(\"ba\").disabled=false;\n  if(!j.ok){msg(\"ma\",j.detail||\"Error\",false);return}\n  msg(\"ma\",j.tvOnline?t(\"adding\"):t(\"addSaved\"),true);$(\"link\").value=\"\";$(\"lname\").value=\"\";\n  waitResult(j.id,function(r){if(r)msg(\"ma\",r.message,r.ok)},30)\n }).catch(function(){$(\"ba\").disabled=false;msg(\"ma\",t(\"noConn\"),false)})});\n/* ---- Registro ---- */\nvar lastN=0,logTimer=null;\nfunction loadLogs(reset){var pin=pinOk();if(!pin){msg(\"ml\",t(\"logPin\"),false);return}\n if(reset){lastN=0;lines=[]}\n fetch(\"/api/logs?pin=\"+pin+\"&since=\"+lastN).then(function(r){return r.json()}).then(function(j){\n  if(!j.ok){msg(\"ml\",j.detail||\"Error\",false);return}$(\"ml\").className=\"msg\";\n  (j.logs||[]).forEach(function(e){lastN=Math.max(lastN,e.n);lines.push(e)});if(lines.length>600)lines=lines.slice(-600);\n  var box=$(\"log\"),atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-20;\n  box.innerHTML=lines.length?lines.map(function(e){var d=new Date(e.t);return '<div class=\"'+(e.l===\"error\"?\"e\":e.l===\"warn\"?\"w\":\"i\")+'\"><time>'+d.toLocaleTimeString()+'</time>'+esc(e.m)+'</div>'}).join(\"\"):(j.tvOnline?t(\"noMsgs\"):t(\"tvOff\"));\n  if(atEnd||reset)box.scrollTop=box.scrollHeight}).catch(function(){msg(\"ml\",t(\"noConn\"),false)});\n clearTimeout(logTimer);if($(\"t-log\").classList.contains(\"on\"))logTimer=setTimeout(function(){loadLogs(false)},3000)}\n$(\"bl\").addEventListener(\"click\",function(){loadLogs(true)});\n$(\"bc\").addEventListener(\"click\",function(){var s=lines.map(function(e){return new Date(e.t).toLocaleTimeString()+\" [\"+e.l+\"] \"+e.m}).join(\"\\n\");\n if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(s).then(function(){msg(\"ml\",t(\"copied\"),true)},function(){msg(\"ml\",t(\"copyFail\"),false)});\n else{var ta=document.createElement(\"textarea\");ta.value=s;document.body.appendChild(ta);ta.select();try{document.execCommand(\"copy\");msg(\"ml\",t(\"copied\"),true)}catch(e){}document.body.removeChild(ta)}});\n/* ---- Varias TVs ---- */\nfunction getTvs(){try{return JSON.parse(localStorage.getItem(\"tbtvs\")||\"[]\")}catch(e){return[]}}\nfunction setTvs(a){try{localStorage.setItem(\"tbtvs\",JSON.stringify(a))}catch(e){}renderTvs()}\nfunction renderTvs(){var a=getTvs(),h=a.length?a.map(function(tv,i){var here=tv.ip===location.host||tv.ip+\":8095\"===location.host;\n return '<div class=\"tv\"><span>'+esc(tv.name)+' <small>'+esc(tv.ip)+(here?\" \"+esc(t(\"tvHere\")):\"\")+'</small></span>'+(here?\"\":'<a href=\"http://'+esc(tv.ip.indexOf(\":\")>0?tv.ip:tv.ip+\":8095\")+'/\">'+esc(t(\"tvOpen\"))+'</a>')+'<button type=\"button\" class=\"sec\" data-del=\"'+i+'\">'+esc(t(\"tvDel\"))+'</button></div>'}).join(\"\"):\"<small>\"+esc(t(\"tvNone\"))+\"</small>\";\n $(\"tvList\").innerHTML=h}\n$(\"tvList\").addEventListener(\"click\",function(e){var d=e.target.getAttribute&&e.target.getAttribute(\"data-del\");if(d===null||d===undefined)return;var a=getTvs();a.splice(Number(d),1);setTvs(a)});\nfunction addTv(name,ip){ip=ip.trim().replace(/^https?:\\/\\//,\"\").replace(/\\/.*$/,\"\");if(!ip)return;var a=getTvs().filter(function(x){return x.ip!==ip});a.push({name:name.trim()||ip,ip:ip});setTvs(a)}\n$(\"tvAdd\").addEventListener(\"click\",function(){addTv($(\"tvName\").value,$(\"tvIp\").value);$(\"tvName\").value=\"\";$(\"tvIp\").value=\"\"});\n$(\"tvThis\").addEventListener(\"click\",function(){addTv($(\"tvName\").value||\"TV\",location.host)});\napplyLang();\n</script></body></html>\n";

function tvOnline(){ return waiters.length > 0 || Date.now() - lastPoll < 15000; }

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
    if(parsed.query.wait && !pending && !actions.length){
      var w = { res: res };
      w.t = setTimeout(function(){
        waiters = waiters.filter(function(x){ return x !== w; });
        lastPoll = Date.now();
        sendJson(res, 200, { pending: null, actions: [] });
      }, 10000);
      req.on("close", function(){ clearTimeout(w.t); waiters = waiters.filter(function(x){ return x !== w; }); });
      waiters.push(w);
      return;
    }
    var out = pending; pending = null;
    var acts = actions; actions = [];
    return sendJson(res, 200, { pending: out, actions: acts });
  }
  if(p === "/tv/pin"){
    // Lo lee el cargador de la app instalada (loopback). GET → {pin: "v2.4.1" | null}
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    return sendJson(res, 200, { pin: pinnedVersion });
  }
  if(p === "/tv/status" && req.method === "POST"){
    if(!local) return sendJson(res, 403, { detail: "Solo desde la TV" });
    return readBody(req, function(b){
      try{ tvStatus = { status: JSON.parse(b.toString("utf8")) || {}, at: Date.now() }; }catch(e){}
      sendJson(res, 200, { ok: true });
    });
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
  if(p === "/api/state") return sendJson(res, 200, { snapshot: snapshot, tvOnline: tvOnline(), pinnedVersion: pinnedVersion, version: VERSION });
  if(p === "/api/settings" && req.method === "POST"){
    return readBody(req, function(b){
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!checkPin(req, j && j.pin, res)) return;
      var clean = {}, n = 0, s = j.settings || {};
      Object.keys(s).forEach(function(k){
        if(!ALLOWED[k]) return;
        var v = cleanSetting(k, s[k]);
        if(v !== undefined){ clean[k] = v; n++; }
      });
      if(!n) return sendJson(res, 400, { ok: false, detail: "Nada que cambiar" });
      var merged = pending ? pending.settings : {};
      Object.keys(clean).forEach(function(k){
        if(ALLOWED[k] === "list" && merged[k] && merged[k].ops) merged[k] = { ops: merged[k].ops.concat(clean[k].ops) };
        else merged[k] = clean[k];
      });
      pending = { settings: merged, at: Date.now() };
      flushWaiters();
      sendJson(res, 200, { ok: true, tvOnline: tvOnline() });
    });
  }
  if(p === "/api/add" && (req.method === "POST" || req.method === "GET")){
    // POST {pin, link, name}  ·  GET /api/add?pin=1234&link=<enlace>&name=  (para atajos "Compartir")
    var doAdd = function(j){
      if(!checkPin(req, j && j.pin, res)) return;
      var link = String((j && j.link) || "").trim();
      if(!link || link.length > 8000) return sendJson(res, 400, { ok: false, detail: "Pega un magnet, hash, NZB o URL" });
      var id = queueAction({ type: "add", link: link, name: j.name ? String(j.name).slice(0, 300) : "" });
      sendJson(res, 200, { ok: true, id: id, tvOnline: tvOnline() });
    };
    if(req.method === "GET") return doAdd(parsed.query);
    return readBody(req, function(b){
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      doAdd(j);
    });
  }
  if(p === "/api/action" && req.method === "POST"){
    // {pin, action:{type:"play"|"playUrl"|"control"|"key"|"import"|"export", ...}}
    return readBody(req, function(b){
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!checkPin(req, j && j.pin, res)) return;
      var a = cleanAction(j && j.action);
      if(!a) return sendJson(res, 400, { ok: false, detail: "Acción no válida" });
      sendJson(res, 200, { ok: true, id: queueAction(a), tvOnline: tvOnline() });
    });
  }
  if(p === "/api/status"){
    var st = tvStatus && Date.now() - tvStatus.at < 8000 ? tvStatus.status : null;
    return sendJson(res, 200, { status: st, tvOnline: tvOnline() });
  }
  if(p === "/api/pin" && req.method === "POST"){
    // {pin, version:"v2.4.1" | ""}: fija la versión que cargará la app instalada ("" = última)
    return readBody(req, function(b){
      var j; try{ j = JSON.parse(b.toString("utf8")); }catch(e){ return sendJson(res, 400, { ok: false, detail: "JSON no válido" }); }
      if(!checkPin(req, j && j.pin, res)) return;
      var v = String((j && j.version) || "").trim();
      if(v && !/^v?\d+\.\d+\.\d+$/.test(v)) return sendJson(res, 400, { ok: false, detail: "Versión no válida (p. ej. v2.4.1)" });
      if(v && v.charAt(0) !== "v") v = "v" + v;
      pinnedVersion = v || null;
      try{ fs.writeFileSync(PINVER_FILE, JSON.stringify({ version: pinnedVersion })); }catch(e){}
      sendJson(res, 200, { ok: true, pinned: pinnedVersion });
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
