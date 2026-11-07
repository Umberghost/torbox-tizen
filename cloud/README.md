# TorBox TV — Cloudflare Worker (`worker.js`)

Sirve la app desde cualquier navegador (móvil, PC, Android TV) y hace de proxy CORS para la API de TorBox.
Despliegue: Cloudflare Dashboard → Workers & Pages → Create → pega `worker.js` → Deploy.

## Rutas

| Ruta | Para qué |
|------|----------|
| `/app/…` | La app (última etiqueta vX.Y.Z de GitHub vía jsDelivr) |
| `/proxy?url=` | Proxy CORS con lista de dominios permitidos |
| `/ping` | `{ok, service:"torbox-worker", auth, sync}` |
| `/manifest.json`, `/sw.js`, `/icon-192.png`, `/icon-512.png` | PWA instalable |
| `/sync/<clave>` | GET/PUT: sincroniza "Continuar viendo" (necesita KV) |
| `/login` | Página de contraseña (solo si defines `ACCESS_PASSWORD`) |

## Contraseña opcional (ACCESS_PASSWORD)

Si compartes el enlace del Worker, protégelo:

1. Worker → **Settings → Variables and Secrets → Add** → tipo **Secret**, nombre `ACCESS_PASSWORD`, valor tu contraseña → Deploy.
2. A partir de ahí, cualquier visita sin cookie ve la página de login. Al acertar se guarda una cookie
   `tb_auth` (HttpOnly, Secure, SameSite=Lax, 30 días) firmada con HMAC-SHA256 usando la contraseña:
   cambiar la contraseña invalida todas las sesiones.
3. Siguen públicos (sin contraseña): `/ping`, `/login`, `/manifest.json`, `/sw.js` e iconos (necesario para instalar la PWA).
4. Sin `ACCESS_PASSWORD` el Worker funciona abierto, como antes.

No hay límite de intentos en el login; usa una contraseña larga. (Opcional: añade una regla de Rate Limiting en Cloudflare para `/login`.)

## PWA (instalar en el móvil)

Abre `https://<tu-worker>.workers.dev/` en Chrome (Android) o Safari (iOS) → menú → **Instalar app / Añadir a pantalla de inicio**.
El Worker inyecta `manifest.json` y registra el service worker en el `index.html` de la app automáticamente.

## Sync de "Continuar viendo" entre dispositivos (KV opcional)

Guarda tu historial en Cloudflare KV para continuar un título en otro dispositivo sin usar Trakt.

1. Dashboard → **Storage & Databases → KV → Create a namespace** → nombre p. ej. `torbox-sync`.
2. Worker → **Settings → Bindings → Add → KV namespace** → Variable name **`TB_KV`** → elige el namespace → Deploy.
3. Comprueba `https://<tu-worker>.workers.dev/ping` → `"sync": true`.
4. En la app (servida por el Worker) el sync se activa solo: se sube y baja el historial al abrir, tras ver algo y cada
   cierto tiempo. En la app de la TV u otro origen, pon el ajuste `syncUrl` = `https://<tu-worker>.workers.dev` (Ajustes del móvil).

Detalles: la clave `<clave>` se deriva (hash) de tu API key de TorBox; la API key nunca se envía. Los datos se fusionan por
entrada (`updated` más reciente gana), máximo 500 entradas, caducan a los 180 días sin uso. Si tienes `ACCESS_PASSWORD`,
el sync también exige estar autenticado (la app en el mismo origen ya lo está; para `syncUrl` desde otra app, el cookie no
se envía: en ese caso usa un Worker sin contraseña o desactiva el sync de la TV).
