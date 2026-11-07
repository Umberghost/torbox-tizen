/*
 * TorBox TV — Cloudflare Worker
 *
 * Permite usar la app desde cualquier navegador (móvil, PC, Android TV):
 *   https://<tu-worker>.workers.dev/        → redirige a /app/
 *   https://<tu-worker>.workers.dev/app/... → sirve la app desde GitHub (jsDelivr), siempre la última versión
 *   https://<tu-worker>.workers.dev/proxy?url=<URL> → proxy CORS (la API de TorBox solo admite torbox.app)
 *   https://<tu-worker>.workers.dev/ping   → {ok:true, service:"torbox-worker"}
 *
 *   https://<tu-worker>.workers.dev/manifest.json, /sw.js, /icon-192.png, /icon-512.png → PWA instalable en el móvil
 *   https://<tu-worker>.workers.dev/sync/<clave> (GET/PUT) → sincroniza "Continuar viendo" (requiere el KV TB_KV)
 *
 * Variables opcionales (Settings → Variables and Secrets / Bindings):
 *   ACCESS_PASSWORD  → si existe, todo el Worker pide contraseña (página de login + cookie firmada HMAC).
 *   TB_KV            → KV namespace para el sync entre dispositivos.
 *
 * El proxy SOLO reenvía a los dominios de la lista ALLOWED_HOSTS (no es un proxy abierto).
 * Tus claves (API key de TorBox, etc.) viajan en cada petición desde tu navegador; el Worker
 * no guarda nada.
 */

const REPO = "gh/Umberghost/torbox-tizen";
const GH_REPO = "Umberghost/torbox-tizen";
/* La app se sirve desde la última etiqueta vX.Y.Z (inmutable en jsDelivr). Se consulta como mucho cada 5 min. */
let cachedVer = null, cachedAt = 0;
function cmpVer(a, b) {
  a = a.replace(/^v/, "").split(".").map(Number); b = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
async function latestVersion() {
  if (cachedVer && Date.now() - cachedAt < 300000) return cachedVer;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/tags?per_page=30`, { headers: { "User-Agent": "TorBox-TV-Worker" } });
    const tags = await r.json();
    const v = tags.map((t) => t.name).filter((n) => /^v\d+\.\d+\.\d+$/.test(n)).sort(cmpVer).pop();
    if (v) { cachedVer = v; cachedAt = Date.now(); }
  } catch (e) { /* se usa la última conocida o master */ }
  return cachedVer || "master";
}

const ALLOWED_HOSTS = [
  /(^|\.)torbox\.app$/i,
  /(^|\.)real-debrid\.com$/i,
  /(^|\.)tb-cdn\.[a-z]+$/i,
  /(^|\.)strem\.fun$/i,               // Torrentio
  /(^|\.)strem\.io$/i,                // Cinemeta, OpenSubtitles v3
  /(^|\.)elfhosted\.com$/i,           // TMDB add-on
  /(^|\.)themoviedb\.org$/i,
  /(^|\.)tmdb\.org$/i,
  /(^|\.)trakt\.tv$/i,
  /(^|\.)tdtchannels\.com$/i,
  /(^|\.)metahub\.space$/i,
  /(^|\.)jsdelivr\.net$/i
];

const TYPES = {
  html: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", ico: "image/x-icon", webp: "image/webp"
};

function cors(h) {
  h = h || new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept,Range,trakt-api-key,trakt-api-version");
  h.set("Access-Control-Expose-Headers", "Content-Type,Content-Length,Content-Range");
  h.set("Access-Control-Max-Age", "600");
  return h;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: cors(new Headers({ "Content-Type": "application/json; charset=utf-8" })) });
}

async function serveApp(path) {
  if (!path || path.endsWith("/")) path += "index.html";
  if (path.indexOf("..") >= 0) return new Response("Bad path", { status: 400 });
  const ver = await latestVersion();
  let res = await fetch(`https://cdn.jsdelivr.net/${REPO}@${ver}/app/${path}`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  // Una etiqueta recién publicada puede tardar unos minutos en existir en jsDelivr
  if (!res.ok && ver !== "master") res = await fetch(`https://cdn.jsdelivr.net/${REPO}@master/app/${path}`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) return new Response("Not found", { status: res.status });
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "html") {
    let html = await res.text();
    html = html.replace(/<\/head>/i, PWA_HEAD + "</head>");
    return new Response(html, { status: 200, headers: { "Content-Type": TYPES.html, "Cache-Control": "no-cache" } });
  }
  const h = new Headers();
  h.set("Content-Type", TYPES[ext] || res.headers.get("Content-Type") || "application/octet-stream");
  h.set("Cache-Control", ext === "html" ? "no-cache" : "public, max-age=300");
  return new Response(res.body, { status: 200, headers: h });
}

async function proxy(request, target) {
  let u;
  try { u = new URL(target); } catch (e) { return json({ success: false, detail: "URL no válida" }, 400); }
  if (u.protocol !== "https:" && u.protocol !== "http:") return json({ success: false, detail: "Protocolo no permitido" }, 400);
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) return json({ success: false, detail: "Dominio no permitido: " + u.hostname }, 403);

  const h = new Headers();
  ["authorization", "content-type", "accept", "range", "trakt-api-key", "trakt-api-version"].forEach((k) => {
    const v = request.headers.get(k);
    if (v) h.set(k, v);
  });
  h.set("User-Agent", "TorBox-TV-Worker/1.0");
  const init = { method: request.method, headers: h, redirect: "follow" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();

  let res;
  try { res = await fetch(u.toString(), init); }
  catch (e) { return json({ success: false, detail: "Proxy: " + e.message }, 502); }
  const out = new Headers();
  ["content-type", "content-length", "content-range", "accept-ranges"].forEach((k) => {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers: cors(out) });
}


/* ---------------- Contraseña opcional (ACCESS_PASSWORD) ---------------- */
const COOKIE = "tb_auth";
const enc = new TextEncoder();
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}
async function isAuthed(request, env) {
  const c = getCookie(request, COOKIE);
  const i = c.indexOf(".");
  if (i < 0) return false;
  const exp = c.slice(0, i);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEq(c.slice(i + 1), await hmacHex(env.ACCESS_PASSWORD, "tb-auth:" + exp));
}
const LOGIN = {
  en: { title: "TorBox TV", ph: "Password", btn: "Enter", bad: "Wrong password" },
  es: { title: "TorBox TV", ph: "Contraseña", btn: "Entrar", bad: "Contraseña incorrecta" }
};
function loginPage(request, bad, next) {
  const l = LOGIN[/^es/i.test(request.headers.get("Accept-Language") || "") ? "es" : "en"];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${l.title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#e8eef3;font:16px system-ui,sans-serif}
form{background:#141b22;padding:28px;border-radius:14px;width:min(340px,90vw)}h1{margin:0 0 16px;font-size:24px}h1 b{color:#17c964}
input,button{width:100%;box-sizing:border-box;padding:13px;font-size:16px;border-radius:10px;border:1px solid #1b242d;margin-top:10px}
input{background:#0b0f14;color:#e8eef3}button{background:#17c964;color:#06130c;font-weight:700;border:0}.e{color:#ff6b6b;margin-top:10px}</style></head>
<body><form method="POST" action="/login"><h1>Tor<b>Box</b> TV</h1><input type="password" name="password" placeholder="${l.ph}" autofocus autocomplete="current-password">
<input type="hidden" name="next" value="${next.replace(/[^A-Za-z0-9_\-\/.?=&%]/g, "")}"><button>${l.btn}</button>${bad ? `<div class="e">${l.bad}</div>` : ""}</form></body></html>`;
  return new Response(html, { status: bad ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
async function handleLogin(request, env, url) {
  if (request.method !== "POST") return loginPage(request, false, url.searchParams.get("next") || "/app/");
  const f = await request.formData();
  const pw = String(f.get("password") || "");
  let next = String(f.get("next") || "/app/");
  if (!next.startsWith("/") || next.startsWith("//")) next = "/app/";
  // Se comparan los HMAC de ambas contraseñas (tiempo constante)
  const ok = safeEq(await hmacHex("login", pw), await hmacHex("login", env.ACCESS_PASSWORD));
  if (!ok) return loginPage(request, true, next);
  const exp = String(Date.now() + 30 * 86400000);
  const val = exp + "." + await hmacHex(env.ACCESS_PASSWORD, "tb-auth:" + exp);
  return new Response(null, { status: 302, headers: {
    Location: next,
    "Set-Cookie": `${COOKIE}=${val}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
  } });
}

/* ---------------- PWA ---------------- */
const ICON_192 = "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";
const ICON_512 = "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";
function b64bytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const MANIFEST = {
  name: "Faro para TorBox", short_name: "Faro", start_url: "/app/", scope: "/", display: "standalone",
  background_color: "#0b0f14", theme_color: "#0b0f14",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
  ]
};
const SW_JS = `self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});
self.addEventListener("fetch",function(){/* sin respondWith: el navegador resuelve la petición con normalidad */});`;
const PWA_HEAD = `<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0A0D12"><link rel="apple-touch-icon" href="/icon-192.png">` +
  `<script>if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(function(){});</script>`;
function pwaResponse(path) {
  if (path === "/manifest.json") return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
  if (path === "/sw.js") return new Response(SW_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  if (path === "/icon-192.png") return new Response(b64bytes(ICON_192), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  if (path === "/icon-512.png") return new Response(b64bytes(ICON_512), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  return null;
}

/* ---------------- Sync de "Continuar viendo" (KV opcional TB_KV) ----------------
 * GET /sync/<clave>  → {entries:[…]}     PUT /sync/<clave> {entries:[…]} → fusiona por `updated` y devuelve el resultado.
 * La <clave> es secreta (la app la deriva de tu API key). Sin binding TB_KV responde 501. */
async function handleSync(request, env, key) {
  if (!env.TB_KV) return json({ ok: false, detail: "KV no configurado (binding TB_KV)" }, 501);
  if (!/^[A-Za-z0-9]{16,128}$/.test(key)) return json({ ok: false, detail: "Clave no válida" }, 400);
  const k = "sync:" + key;
  let stored = {};
  try { stored = (await env.TB_KV.get(k, "json")) || {}; } catch (e) { stored = {}; }
  if (request.method === "GET") return json({ ok: true, entries: Object.keys(stored).map((x) => stored[x]) });
  if (request.method !== "PUT" && request.method !== "POST") return json({ ok: false, detail: "Método no permitido" }, 405);
  const text = await request.text();
  if (text.length > 1000000) return json({ ok: false, detail: "Demasiado grande" }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ ok: false, detail: "JSON no válido" }, 400); }
  (body.entries || []).forEach((e) => {
    if (!e || typeof e.key !== "string" || e.key.length > 300) return;
    const cur = stored[e.key];
    if (!cur || (e.updated || 0) > (cur.updated || 0)) stored[e.key] = e;
  });
  // máximo 500 entradas: se conservan las más recientes
  let keys = Object.keys(stored);
  if (keys.length > 500) {
    keys.sort((a, b) => (stored[b].updated || 0) - (stored[a].updated || 0));
    keys.slice(500).forEach((x) => delete stored[x]);
    keys = keys.slice(0, 500);
  }
  await env.TB_KV.put(k, JSON.stringify(stored), { expirationTtl: 180 * 86400 });
  return json({ ok: true, entries: keys.map((x) => stored[x]) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    env = env || {};
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    // Rutas públicas aunque haya contraseña: ping, login y archivos de la PWA
    const pwa = pwaResponse(url.pathname);
    if (pwa) return pwa;
    if (url.pathname === "/ping") return json({ ok: true, service: "torbox-worker", version: "1.1", auth: !!env.ACCESS_PASSWORD, sync: !!env.TB_KV });
    if (env.ACCESS_PASSWORD) {
      if (url.pathname === "/login") return handleLogin(request, env, url);
      if (!(await isAuthed(request, env))) {
        const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
        if (wantsHtml && request.method === "GET") return loginPage(request, false, url.pathname + url.search);
        return json({ success: false, detail: "Auth required" }, 401);
      }
    }
    if (url.pathname.startsWith("/sync/")) return handleSync(request, env, url.pathname.slice(6));
    if (url.pathname === "/" || url.pathname === "") return Response.redirect(url.origin + "/app/", 302);
    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ success: false, detail: "Falta url" }, 400);
      return proxy(request, target);
    }
    if (url.pathname === "/app") return Response.redirect(url.origin + "/app/", 302);
    if (url.pathname.startsWith("/app/")) return serveApp(url.pathname.slice(5));
    return json({ success: false, detail: "Ruta no encontrada" }, 404);
  }
};
