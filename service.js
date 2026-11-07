/*
 * service.js — proxy CORS local para TorBox (serviceFile de TizenBrew).
 *
 * La API de TorBox solo permite CORS desde https://torbox.app, así que el webview no
 * puede leer sus respuestas directamente. TizenBrew arranca este servicio Node en la
 * propia TV; la app llama a http://127.0.0.1:8095/proxy?url=<URL codificada> y el
 * servicio reenvía la petición añadiendo cabeceras CORS.
 *
 * Solo escucha en 127.0.0.1 (no es accesible desde la red). Sin dependencias.
 * En el PC, para probar: `node service.js`.
 */
"use strict";

var http = require("http");
var https = require("https");
var urlMod = require("url");

var PORT = 8095;
var HOST = "127.0.0.1";
var MAX_REDIRECTS = 5;

function cors(res, extra){
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

function forward(target, req, res, body, depth){
  var u;
  try{ u = urlMod.parse(target); }catch(e){ u = null; }
  if(!u || (u.protocol !== "https:" && u.protocol !== "http:")){
    res.writeHead(400, cors({"Content-Type": "application/json"}));
    return res.end(JSON.stringify({ success: false, detail: "URL no válida" }));
  }
  var headers = {};
  ["authorization", "content-type", "accept", "range"].forEach(function(h){
    if(req.headers[h]) headers[h] = req.headers[h];
  });
  headers["user-agent"] = "TorBox-Tizen/2.0";
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
    res.writeHead(502, cors({"Content-Type": "application/json"}));
    res.end(JSON.stringify({ success: false, detail: "Proxy: " + e.message }));
  });
  preq.setTimeout(30000, function(){ preq.abort(); });
  if(body && body.length) preq.write(body);
  preq.end();
}

var server = http.createServer(function(req, res){
  if(req.method === "OPTIONS"){ res.writeHead(204, cors()); return res.end(); }
  var parsed = urlMod.parse(req.url, true);
  if(parsed.pathname === "/ping"){
    res.writeHead(200, cors({"Content-Type": "application/json"}));
    return res.end(JSON.stringify({ ok: true, service: "torbox-tizen", version: "2.0.0" }));
  }
  if(parsed.pathname !== "/proxy" || !parsed.query.url){
    res.writeHead(404, cors({"Content-Type": "application/json"}));
    return res.end(JSON.stringify({ success: false, detail: "Ruta no encontrada" }));
  }
  var chunks = [];
  req.on("data", function(c){ chunks.push(c); });
  req.on("end", function(){ forward(String(parsed.query.url), req, res, Buffer.concat(chunks), 0); });
});

server.on("error", function(e){
  // Puerto ocupado: probablemente ya hay otra instancia corriendo; no es un error real.
  console.log("[torbox-tizen service] " + e.message);
});
server.listen(PORT, HOST, function(){
  console.log("[torbox-tizen service] proxy en http://" + HOST + ":" + PORT);
});
