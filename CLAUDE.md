# TorBox para TizenBrew — contexto del proyecto

Documento de traspaso desde una conversación en Claude.ai. Resume el estado, las
decisiones y los siguientes pasos para que Claude Code continúe sin re-explicar nada.

## Qué es
Módulo de **TizenBrew** (tipo `app`) para ver contenido de **TorBox** en una Samsung
con **Tizen**. Es una web app que corre en el webview de TizenBrew; navegación pensada
para mando a distancia (D-pad). La tele del usuario **no tiene antena** y Tizen es
sistema cerrado (sin ADB), así que todo entra por red/APIs web.

## Estado actual: TorBox 2.0 (semver v3.0.0, 2026-11-08) — LEER ARCHITECTURE.md
- Nombre visible "TorBox 2.0" (`App.displayVersion`); semver interno v3.0.0 porque el cargador y el Worker usan
  la etiqueta vX.Y.Z más alta (ya existían v2.1–v2.5). Siguientes versiones: v3.x.
- Rediseño 2.0 (rail lateral, foco blanco, barra "Mantén OK", guía TDT principal) — spec en ARCHITECTURE.md y
  maquetas en `design/`. Interfaz en 7 idiomas (en, es, ca, gl, eu, pt, fr).
- Publicar: `python tools/bundle.py` (app/dist) + `python tizen-app/build.py` (wgt) + commit + tag + push.
- El push con `.github/workflows/android.yml` exige que `gh` tenga el scope `workflow`.

## Estado v2.3 (histórico)
- **Interfaz en inglés por defecto, multi-idioma (en/es)**: toda cadena visible con `App.t()` y textos en
  `app/i18n/<modulo>.js`. Idioma de contenido (sinopsis/episodios) separado: `App.i18n.contentLang()`.
- v2.3: Inicio (catálogos TMDB-addon localizados), Buscar estilo Stremio (Cinemeta/TMDB + add-on Torrentio del
  usuario, mejor fuente en un clic, packs de temporada, estado de descarga), OpenSubtitles, aviso "ya está listo",
  Trakt, EPG en TV en directo, formatos no compatibles (App.caps), web del móvil con Ajustes/Añadir/Registro.
- **Hallazgo en TV real (Tizen 9, Chromium 120):** dentro de TizenBrew la página NO tiene `tizen` ni `webapis`
  (AVPlay) y `<video>` no abre MKV (mkv=no; mp4 h264/hevc sí). Solución: **app instalada `tizen-app/`**
  (package TrBxApp001): cargador que resuelve la última etiqueta vX.Y.Z vía API de GitHub y carga
  `app/` desde jsDelivr@tag + servicio propio (`tizen:service`, mismo service.js). `python tizen-app/build.py`.
- Publicar = commit + tag vX.Y.Z + push (la app instalada y el Worker usan la última etiqueta; sin purgas).
- `cloud/worker.js`: Cloudflare Worker para usar la app en navegador (sirve app + proxy con lista blanca).
- TorBox cerró su Search API (search-api.torbox.app no existe): por eso Buscar usa add-ons de Stremio.

## Estado v2.0 (histórico)
- v2 modular en `app/js/` (core, ui, torbox, main + pantallas). Contratos en `ARCHITECTURE.md`.
- Hecho: biblioteca con carátulas TMDB y series agrupadas, AVPlay + fallback `<video>`/hls.js,
  continuar viendo, subtítulos/pistas, TV en directo (TDTChannels, 378 canales), accesos a
  Atresplayer/Mediaset Infinity/Tivify, buscador, descargas, ajustes, teclado en pantalla.
- **CORS:** la API de TorBox solo admite origen `https://torbox.app` (comprobado). Por eso
  `service.js` (serviceFile) levanta un proxy en `127.0.0.1:8095` y `App.net.fetch` lo usa.
- Probado en Chrome headless con API simulada; **sin probar en la TV real**.
- TV del usuario: **Samsung TU65DU7175UXXC** (2024, Tizen 8 de fábrica, actualizada a One UI Tizen).
- Pendiente de verificar en TV: AVPlay disponible en TizenBrew, serviceFile arranca, endpoints
  de búsqueda de TorBox (nombres de campo supuestos), appIds de las apps oficiales.

## Estado v1 (histórico)
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

## Pendientes actuales → ver `TODO.md`

## Roadmap original (completado en v2.x)
1. **AVPlay** — sostiene tanto el contenido de TorBox como los directos. Lo primero.
2. **Continuar viendo** — guardar posición por archivo en `localStorage` y retomar.
3. **Sección TV en directo** — cargar lista de TDTChannels (RTVE + públicos) con hls.js.
4. **Accesos directos** a Atresplayer / Mediaset Infinity (y opcional Tivify).
5. **Buscar y añadir** desde la tele con la Search API de TorBox.
6. **Subtítulos** — `.srt` externos o incrustados.

## Cómo probar / desplegar
- **TizenBrew solo carga módulos desde jsDelivr** (`gh/usuario/repo` o `npm/paquete`); NO desde
  un servidor local. Módulo publicado: `gh/Umberghost/torbox-tizen` (repo público).
- jsDelivr cachea la rama ~12 h: tras un push, purgar con
  `curl https://purge.jsdelivr.net/gh/Umberghost/torbox-tizen@master/<ruta>` (package.json, app/…).
- App servida en la TV desde `http://127.0.0.1:8081/module/gh%2FUmberghost%2Ftorbox-tizen/app/index.html`.
- Prueba en PC: `npx http-server . -p 8080` → `http://localhost:8080/app/` (+ `node service.js` para el proxy).
- TV: IP 192.168.1.147. API local `http://192.168.1.147:8001/api/v2/applications/<appId>` (GET estado,
  POST lanza). TizenBrew appId `xvvl3S1bvH.TizenBrewStandalone`. Host PC IP debe ser 127.0.0.1.

## Preguntas abiertas
- ¿Año/modelo exacto de la Samsung? (decide Tizen 8 / certificado / compatibilidad de apps).
- ¿Prioridad real de MKV? Si es alta, AVPlay sube al puesto 1 sin discusión.
