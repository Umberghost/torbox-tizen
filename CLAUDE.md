# TorBox para TizenBrew — contexto del proyecto

Documento de traspaso desde una conversación en Claude.ai. Resume el estado, las
decisiones y los siguientes pasos para que Claude Code continúe sin re-explicar nada.

## Qué es
Módulo de **TizenBrew** (tipo `app`) para ver contenido de **TorBox** en una Samsung
con **Tizen**. Es una web app que corre en el webview de TizenBrew; navegación pensada
para mando a distancia (D-pad). La tele del usuario **no tiene antena** y Tizen es
sistema cerrado (sin ADB), así que todo entra por red/APIs web.

## Estado actual (v1, funcional)
- `package.json` — módulo `app`, `appPath: app/index.html`, teclas de medios registradas.
- `app/index.html` — UI + lógica + reproductor, autocontenido. Hace:
  - Pide la **API key** de TorBox la 1ª vez (se guarda en `localStorage`).
  - Lista descargas **terminadas** de la fuente activa.
  - `◄ ►` cambia fuente (torrents/usenet/webdl), `▲ ▼` navega, OK reproduce, Atrás vuelve.
  - Si una descarga tiene varios archivos, entra a elegir archivo.
  - Reproduce con `<video>` HTML5.
- `README.md` — instalación y límites.

## Hechos técnicos clave
### TizenBrew
- 3 tipos de módulo: `app`, `mods` (site modification), `service`. Este es `app`.
- Los módulos son paquetes npm; un `app` se sirve desde servidor/CDN y se abre en webview.
- Tizen 8 (teles 2024+): TizenBrew a veces no se instala directo y hay que recompilarlo
  desde fuente. El instalador web deja la app solo 30 días; para permanente, vía CLI.
- Modo desarrollador: Home > Apps > engranaje > `12345` > On, Host PC IP = tu máquina.

### TorBox API
- Base: `https://api.torbox.app/v1/api`
- Auth: header `Authorization: Bearer <token>` (requestdl además acepta `?token=` en query).
- Listar: `GET /{source}/mylist?bypass_cache=false` → `{success, data:[{id, name, files:[{id,name,short_name,size,mimetype}], download_finished, ...}]}`
- Enlace de reproducción: `GET /{source}/requestdl?token=<t>&{idField}=<id>&file_id=<fid>&redirect=false` → `{success, data:"<url>"}`
- `source` ∈ `torrents | usenet | webdl`; `idField` = `torrent_id | usenet_id | web_id`.

## Decisiones tomadas
- **Reproductor:** v1 con `<video>` HTML5 por simplicidad. Siguiente paso prioritario:
  migrar a **AVPlay** (reproductor nativo Tizen) para MKV/HEVC y para directos robustos.
- **CORS:** se hace `fetch` directo a la API (el webview de TizenBrew suele permitirlo).
  Plan B si una tele lo bloquea: `serviceFile` (servicio Node en la TV) como proxy.
- **TV en directo (a añadir):**
  - Embebibles y legales: **RTVE** (La 1, La 2, 24h, Clan, TDP), autonómicas y **7TV Sevilla**
    si dan HLS abierto. Fuente: listas M3U/M3U8 de **TDTChannels** / iptv-org.
  - HLS en el webview necesita **hls.js** (Chromium no reproduce HLS nativo). Algunos
    flujos son MPEG-TS crudo → no van en `<video>`; ahí AVPlay ayuda.
  - **Antena 3 / Telecinco NO son embebibles:** van con DRM/tokens vía Atresplayer y
    Mediaset Infinity. Solo se ven legalmente en sus apps oficiales (gratis). Plan:
    **accesos directos** desde el módulo que lancen esas apps con `tizen.application.launch`.
    (Tivify también las lleva, pero por licencia comercial, no por técnica; y sus canales
    de Mediaset/Atresmedia son de pago en Tivify Plus.)

## Roadmap (orden sugerido)
1. **AVPlay** — sostiene tanto el contenido de TorBox como los directos. Lo primero.
2. **Continuar viendo** — guardar posición por archivo en `localStorage` y retomar.
3. **Sección TV en directo** — cargar lista de TDTChannels (RTVE + públicos) con hls.js.
4. **Accesos directos** a Atresplayer / Mediaset Infinity (y opcional Tivify).
5. **Buscar y añadir** desde la tele con la Search API de TorBox.
6. **Subtítulos** — `.srt` externos o incrustados.

## Cómo probar
```
npx http-server . --cors -c-1 -p 8080
```
En TizenBrew → Module Manager → añadir fuente `http://IP-DE-TU-PC:8080/` → instalar "TorBox".

## Preguntas abiertas
- ¿Año/modelo exacto de la Samsung? (decide Tizen 8 / certificado / compatibilidad de apps).
- ¿Prioridad real de MKV? Si es alta, AVPlay sube al puesto 1 sin discusión.
