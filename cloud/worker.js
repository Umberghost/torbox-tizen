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
const ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAACOElEQVR42u3dsQ3CQAxA0fQpaJCyYJZlKxgB+SywfU/6E8SvIAnxHefjKYU7XAIBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkASQAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkACSAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgGp2ve5PRgvQEiCGAFoFhBFACYAwAigBEEYAJQBiCKBVQBgBlAAII4ASAGEEUAIghgBaBYQRQAmAMAIoARBDAN0pwQEQRgD9GxBGADEEUAFAGAGEEUA1AGEEEEMAFQCEEUAYAVQD0J6GAMIIoGKAtmIEEEYAFQY03hBAGAHUAdBURgBhBFA3QJMMAYQRQG0BDWAEEEMA9QfUlxFAGAE0C1AvRgAxBNBQQC0YAYQRQBsAKssIIHQA8hsIIIDchQHkORBA6ACEDkDexgMEkP8DAYQOQOgA5KsMgADyXRhA6ACEDkC2cwBkPxBAANlQBhA6ANnSCpA90QDZVA8QQPQA5LQegJwXBpATCwECiB6A0AHIufEANQSEBUD0APRzQDQAFATEAUBxQBAAFARk/AAFARk8QEFARg5QHJB5AxQEZNIABQGZMUBBQKYLUByQ0QIkgASQBJAAEkACSAJIAAkgASSAXAIBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkASQAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkACSAJIAAkgASR93xtw6s8V/Sb7ogAAAABJRU5ErkJggg==";
const ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAIMklEQVR42u3VsQ3AIBAEQXIHJJZo0M3SlQNHLgHtSFPBg27HNW8AgoYTAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAAAiAKwAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIgCsACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAACAAAAgCAAMDf2o8jgAAQDcDHKUAAiAZAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABkAASAdABkAASAdAA0AA6AZABkAASAdABhAAVyAdAA1AAKAbABlAACAdABlAACAdABlAACAdAA1AAKAbABlAACAdABlAACAdABlAABAADfATEAAEQAZAABAAGQABQAA0AAQAAZABEAAEQAZAABAAGQABQAA0AAQAAZABEAAEQAZAABAAGQABQAA0AAQAAZABEAAEQAZAABAADQABQABkAAQAAZABEAAEQAZAABAADQABQABkAAEAAZABBAAEQAYQABAADUAAwBbLAAKAACADCAACgAYgAAgAMoAAIADIAAKAACADCAACgAYgAAgAMoAAIADIAAKAACADCAACgAYgAAgAMoAAIADIAAKAAKABCAACgAwgAAgAMoAAIADIAAKAAKABCAACgAwgAAgAMiAAroAAIAMCAAKAry4AIAAygACAAMgAAoAAoAEIAAKADCAACAAygAAgAMgAAoAAoAEIAAKADCAACAAygAAgAMgAAoAAoAEIAAKADCAACAAygAAgAGgAAoAAIAMIAAKADCAACAAygAAgAGgAAoAAYP0RAAQA048AIACYfgQAAcD0CwAIANZfAEAAMP0CAAKA6RcABMDGYf0FAAEA0y8ACACmHwFAADD9CAACgPVHABAATD8CgABg+hEABADTjwAgAFh/BAABwPQjAAgAph8BQACw/ggAAoDpRwAQAEw/AoAAYPoRAAQA648AIACYfgQAAcD0IwAIgOkHAUAArD8C4AoIgOlHAEAATD8CAAJg/REAEADTjwAgAJh+BAABwPQjAAgA1h8BQAAw/QgAAoDpRwAQAEw/AoAAYP0RAAQA048AIACYfgQAAcD6IwAIgOkHAUAATD8IAAJg+kEAEADrDwKAAJh+EAAEwPSDACAAph8EAAGw/iAACIDpBwFAAEw/AgACYP0RABAA048AgACYfgQAATDrph8BQACw/ggAAoDpRwAQANMPAoAAmH4QAATA+oMAIACmHwQAATD9IAAIgPUHAUAATD8IAAJg+kEAEADTDwKAAFh/EAAEwPSDACAAph8EAAEw/SAACID1BwFAAEw/CAACYPpBAKgGwFOCAJALgEcEASAXAM8HAkAuAB4OBIBiALwaCAC5AHgvEAByAfBSIADkAuCNQAAoBsADgQCQC4CnAQEgFwCPAgJAMQBeBASAXAC8BQgAuQB4BRAAcgFwfxAAigFwfBAAcgFwdhAAcgFwcBAAcgFwahAAigFwZxAAcgFwYRAAcgFwWxAAigFwWBAAcgFwUhAAcgFwTBAAcgFwRhAAigFwQxAAcgFwPRAAcgFwNxAAcgFwMRAAigFwLhAAcgFwKBAAcgFwIhAAigFwHxAAcgFwGRAAcgFwExAAcgFwDRAAigFwChAAcgFwBBAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAEwAkABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAABMAVAAQAAAEAQAAAEAAABAAAAQDgQC/iwtfNNKX6jQAAAABJRU5ErkJggg==";
function b64bytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const MANIFEST = {
  name: "TorBox TV", short_name: "TorBox", start_url: "/app/", scope: "/", display: "standalone",
  background_color: "#0b0f14", theme_color: "#0b0f14",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
  ]
};
const SW_JS = `self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});
self.addEventListener("fetch",function(){/* sin respondWith: el navegador resuelve la petición con normalidad */});`;
const PWA_HEAD = `<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0b0f14"><link rel="apple-touch-icon" href="/icon-192.png">` +
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
