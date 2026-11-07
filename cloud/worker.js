/*
 * TorBox TV — Cloudflare Worker
 *
 * Permite usar la app desde cualquier navegador (móvil, PC, Android TV):
 *   https://<tu-worker>.workers.dev/        → redirige a /app/
 *   https://<tu-worker>.workers.dev/app/... → sirve la app desde GitHub (jsDelivr), siempre la última versión
 *   https://<tu-worker>.workers.dev/proxy?url=<URL> → proxy CORS (la API de TorBox solo admite torbox.app)
 *   https://<tu-worker>.workers.dev/ping   → {ok:true, service:"torbox-worker"}
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/" || url.pathname === "") return Response.redirect(url.origin + "/app/", 302);
    if (url.pathname === "/ping") return json({ ok: true, service: "torbox-worker", version: "1.0" });
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
