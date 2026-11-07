# Arquitectura v2 — contratos entre módulos

Sin bundler ni ES modules: scripts clásicos que cuelgan del global `App`, cargados en
orden desde `app/index.html`. Objetivo de compatibilidad: Chromium 56+ (Tizen 4+).

**Reglas de JS:** ES2017 como máximo. NADA de optional chaining (`?.`), nullish (`??`),
`import/export`, class fields, `Array.prototype.flat`, `Object.fromEntries`. Sí valen
`let/const`, arrow functions, template literals, Promise, fetch, async/await.
Cada archivo envuelto en IIFE: `(function(){ "use strict"; ... })();`.
Todas las cadenas visibles en español. Escapar HTML con `App.esc()`.

## Orden de carga (app/index.html)
```
vendor/hls.min.js            (agente Live)
js/core.js                   App, config, store, settings, bus, helpers, keys, hint
js/ui.js                     App.ui: FocusGrid, modal/confirm/menu, toast
js/torbox.js                 App.torbox: list, link, (search/create los añade search.js)
js/keyboard.js               App.ui.keyboard (agente Search)
js/parse.js  js/meta.js      App.parse, App.meta (agente Library)
js/history.js js/player.js   App.history, App.player (agente Player)
js/screens/*.js              cada pantalla se registra con App.screens.register
js/main.js                   router, header nav, despacho de teclas, setup, arranque
```

## Núcleo (core.js / ui.js / main.js) — ya existe, NO modificar sin coordinar
- `App.K` — códigos de tecla: LEFT UP RIGHT DOWN OK BACK PLAY PAUSE PLAYPAUSE STOP FF RW
  PREV NEXT CHUP CHDOWN RED GREEN YELLOW BLUE INFO, D0..D9. `App.isBack(k)` (incluye
  Escape/Backspace para probar en PC).
- `App.store.get(key, def)` / `App.store.set(key, val)` — JSON en localStorage (prefijo `tb_`).
- `App.settings.get(k)` / `set(k,v)` / `define(k, def)` / `all()`. Emite `settings:change`.
  Claves predefinidas: `torboxToken, tmdbKey, defaultSource, autoplayNext, subLang,
  audioLang, subSize, uiLang, liveListUrl, appIds`.
- `App.bus.on(evt, fn)` / `off` / `emit(evt, data)`.
- `App.esc, App.fmtSize, App.fmtTime, App.isVideo, App.isSubtitle, App.debounce`.
- `App.hint(msg)` — mensaje temporal en la cabecera. `App.ui.toast(msg)`.
- `App.ui.FocusGrid(container, opts)` — navegación D-pad sobre `.focusable` dentro de
  `container`. opts: `{columns:'auto'|n, onSelect(i,el), onFocus(i,el), onEdge(dir)}`.
  `onEdge('up')` por defecto devuelve el foco a la cabecera. Métodos: `handleKey(k)`→bool,
  `refresh()`, `focus(i)`, `index`.
- `App.ui.modal({title, html, buttons:[{label, value}], onClose(value)})`,
  `App.ui.confirm(title, text) → Promise<bool>`, `App.ui.menu(title, [{label,value,selected}]) → Promise<value|null>`.
  Mientras hay modal abierto, main.js le manda las teclas.
- `App.screens.register({id, label, nav, order, mount(el), show(params, el), hide(), onKey(k, e)})`.
  `nav:true` → aparece en la barra superior. `onKey` devuelve `true` si gestionó la tecla.
  Si una pantalla no gestiona BACK, main.js hace `App.back()` (y si no hay historial, foco a la cabecera).
- `App.go(id, params)` (apila), `App.back()`, `App.replace(id, params)`, `App.current()`.
- `App.focusHeader()` — mueve el foco a la barra de secciones.

## TorBox (torbox.js)
- `App.torbox.SOURCES`, `App.torbox.ID_FIELD`
- `App.torbox.api(path, {method, body, form}) → Promise<json>` (Bearer)
- `App.torbox.list(source, {all}) → Promise<items>` (por defecto solo terminadas con archivos)
- `App.torbox.link(source, itemId, fileId) → Promise<url>`
- `App.torbox.allLibrary() → Promise<items>` — las 3 fuentes juntas, cada item con `_source`.

## Player (agente Player) — history.js, player.js, screens/continue.js, css/player.css
- `App.player.play(opts)` opts:
  `{ title, subtitle, url, key, live, startAt, poster, meta, subtitles:[{label,lang,url}], next }`
  - `key`: id estable para continuar viendo, formato `source:itemId:fileId` (o `live:<id>`).
  - `startAt`: si es `undefined` y hay posición guardada > 30 s y < 90 %, pregunta "¿Reanudar?".
  - `meta`: objeto libre guardado en el historial (source, itemId, fileId, showTitle, season, episode, tmdbId…).
  - `next`: `function() → Promise<opts|null>` para reproducción automática del siguiente episodio.
- `App.player.stop()`, `App.player.isActive()`, `App.player.onKey(k, e) → bool`.
- `App.history.get(key)`, `list({unfinished})`, `save(entry)`, `markWatched(key)`, `remove(key)`,
  `isWatched(key)`, `progress(key) → 0..1`. Emite `history:change`.
  entry = `{key, pos, dur, updated, title, subtitle, poster, watched, meta}`.

## Library + metadatos (agente Library) — parse.js, meta.js, screens/library.js, css/library.css
- `App.parse.name(str) → {title, year, season, episode, type:'tv'|'movie', quality}`
- `App.meta.lookup({title, year, type}) → Promise<meta|null>` con caché.
  meta = `{tmdbId, type, title, year, poster, backdrop, rating, votes, overview, genres}`
- `App.meta.recommendations(type, tmdbId) → Promise<meta[]>`
- Si no hay `tmdbKey` todo funciona sin carátulas (placeholder con iniciales).

## Live (agente Live) — screens/live.js, css/live.css, vendor/hls.min.js
## Search/Ajustes (agente Search) — keyboard.js, screens/search.js, screens/downloads.js, screens/settings.js, css/forms.css
- `App.ui.keyboard.open({title, value, placeholder, secret, onDone(value), onCancel()})`
- `App.torbox.search(query)`, `App.torbox.addMagnet(magnet, name)`, etc. (los añade search.js)

## Añadidos al contrato de pantallas
- Métodos opcionales: `focus()` (el foco vuelve de la cabecera al contenido: repintar el foco)
  y `blur()` (el foco se va a la cabecera). `hint` (string) = ayuda de cabecera por pantalla.
  `section: 'library'` en subpantallas (nav:false) para marcar qué pestaña queda activa.
- `App.ui.keyboard.isOpen()` / `onKey(k,e)` — main.js le da prioridad máxima.
- Teclas de color globales (si la pantalla no las gestiona): AMARILLO → Buscar, AZUL → Ajustes.
- `App.ui.loading/error/empty(el, ...)`, `App.ui.placeholderStyle(title)`, `App.ui.initials(title)`.
- Para probar en PC: `npx http-server . --cors -c-1 -p 8080` y abrir `http://localhost:8080/app/`.
  Atrás = Escape/Backspace. Sin Tizen, AVPlay no existe → usar `<video>` (+ hls.js para m3u8).

## Ronda 3 (v2.3) — contratos nuevos
- **Eventos del reproductor** (player.js los emite):
  `player:start {key, meta, title, live}`, `player:progress {key, meta, pos, dur}` (cada 10 s),
  `player:ended {key, meta}`, `player:close {key, meta, pos, dur}`, `player:error {key, message}`.
- **App.subs** (subs.js): `fetch({type:'movie'|'series', imdbId, season, episode, filename}) → Promise<[{label, lang, url}]>`
  usando el add-on de subtítulos de Stremio OpenSubtitles v3 (`https://opensubtitles-v3.strem.io/subtitles/<type>/<id>.json`).
  El player, si `opts.subtitles` está vacío y `opts.meta.imdbId` existe y `openSubs`, los pide solo.
- **App.watch** (watch.js): `track({hash, name, title, meta, playOpts?})` vigila una descarga enviada a TorBox y,
  al terminar, muestra aviso "Ya está listo · OK para ver". Persistente en App.store('watch').
- **App.trakt** (trakt.js): `isLinked()`, `link()` (device code en pantalla), `unlink()`, `watchlist() → Promise<metas>`,
  `history()`, scrobble automático escuchando eventos del player (solo si meta.imdbId).
- **Pantalla home** (screens/home.js, order 5, label "Inicio"): Continuar viendo, Lista de Trakt, catálogos Cinemeta.
  Abrir un título → `App.go('search', {open:{type, id, name, poster}})` (search.js debe aceptar `params.open`).
- **Ajustes nuevos** (core.js): autoPlayBest, prefQuality, maxSizeGB, prefAudio, openSubs, notifyReady,
  traktClientId, traktClientSecret, traktAuth.
- **Búsqueda: mejor fuente** → `App.search.bestStream(streams) → stream|null` (search.js) y
  `App.search.playTitle({type, id, season, episode}) → Promise` para el siguiente episodio y para la home.

## Idiomas (i18n) — obligatorio en TODO el código visible
- Interfaz en **inglés por defecto**, multi-idioma (en, es; ampliable en `App.i18n.LANGS`).
  Ajustes: `uiLanguage` ("en"|"es"), `contentLanguage` ("auto"|"en"|"es"). Cambiar cualquiera recarga la app.
- **Ninguna cadena visible hardcodeada**: usar `App.t("modulo.clave", {vars})`. Cada agente registra sus
  textos en SU archivo `app/i18n/<modulo>.js` con `App.i18n.add("en", {...})` y `App.i18n.add("es", {...})`
  (ambos idiomas completos). Prefijo de claves = módulo (search., player., home., library., live., settings.,
  downloads., keyboard., continue., watch., subs., trakt.). Plurales: "x.one"/"x.other" con {n}.
- Labels de pantallas: `label: App.t("nav.home")` etc. (las claves nav.* van en el i18n del módulo dueño).
- Logs de consola pueden quedar en inglés/español libre (no son UI).
- **Idioma del contenido**: `App.i18n.contentLang()` ("en"|"es") y `App.i18n.tmdbLang()` ("en-US"|"es-ES").
  NO usar el ajuste obsoleto `uiLang`.
- **App.meta.title(type, imdbId) → Promise<meta>** (meta.js, agente Library): ficha localizada con forma Cinemeta
  `{id, type, name, description, poster, background, releaseInfo, imdbRating, genres, videos:[{id, season, episode, name, overview, thumbnail, released}]}`
  en el idioma de contenido; si no hay traducción, cae a inglés/Cinemeta campo a campo. Search y Home la usan
  para fichas y episodios (en lugar de pedir Cinemeta /meta directamente).

## Ronda 4 (v2.5) — contratos nuevos (LEER ENTERO ANTES DE TOCAR NADA)

### Reglas generales para cada agente
- Toca SOLO tus archivos (lista en tu encargo). Otros agentes trabajan a la vez en el resto.
- Todo texto visible con `App.t()`; claves en TU `app/i18n/<modulo>.js`, en **en** y **es** completos.
- ES2017 sin `?.` ni `??`, IIFE + "use strict", `App.esc()` para HTML. Valida con `node --check`.
- **La máquina va justa de memoria**: como mucho UNA prueba headless corta (puppeteer-core está en
  `C:\Users\MVILLA~1\AppData\Local\Temp\claude\c264a034cebec732\d0472b87-eeee-4167-84c3-0715ce822f75\scratchpad\e2e\`,
  Chrome en `C:/Program Files/Google/Chrome/Application/chrome.exe`), cierra Chrome y no dejes servidores vivos.
  Puerto propio para servir: el que te indique tu encargo (nunca 8080/8095).
- No hagas commits ni push. Al final, informe breve: qué hiciste, qué no, qué verificar en la TV.
- Lo que dependa de AVPlay real (24p, HDR, passthrough, PGS) NO se hace: queda pendiente.

### A1 — Menú contextual (alternativa a botones de colores)
- main.js: mantener OK ≥ 600 ms, o la tecla TOOLS (keyCode 10135), o la tecla MENU (18 en PC=Alt? no: usa
  keyCode 10133 "Menu" si existe) abre `App.ui.menu()` con las acciones de la pantalla actual.
- Cada pantalla puede definir `actions()` → `[{label, run}]` (texto ya traducido) según el elemento enfocado.
  **Toda acción que hoy esté en un botón de color/INFO/números debe estar también en `actions()`.**
- El reproductor tiene su propio panel de iconos (agente Player) y su `actions` vía `App.player.actions()`.
- Pista en cabecera: añadir "· Hold OK: options" / "· Mantén OK: opciones" a los hints.

### Registro de filas de Ajustes (ya existe en core.js)
`App.settingsUI.add("settings.group.<x>", row)` — row como las de settings.js (`id`, `type`: menu|bool|text|
secret|action, `label`/`desc`/`options` pueden ser funciones, `value()`, `run()`, `after()`). Cada agente registra
aquí sus ajustes nuevos (NO editar settings.js salvo su dueño). La clave de grupo se traduce con `App.t`: añade
la clave del grupo a tu i18n (p.ej. "settings.group.player": "Playback").

### App.cache (agente Core) — IndexedDB asíncrono para cachés grandes
`App.cache.get(key) → Promise<val|undefined>`, `App.cache.set(key, val, ttlMs) → Promise`, `App.cache.del(key)`,
`App.cache.clear(prefix)`. Si IndexedDB falla, cae a memoria. Los demás agentes: usar App.cache para cachés
grandes nuevas (con `if(App.cache)`), App.store solo para datos pequeños.

### App.player (agente Player) — control remoto
`App.player.status() → {active, title, subtitle, pos, dur, paused, live, key}`;
`App.player.control(cmd, arg)`: cmd ∈ "playpause" | "play" | "pause" | "stop" | "seek" (arg = ±segundos) | "seekTo" (arg = s).
Emite `player:state` cuando cambia (play/pause/stop) además de los eventos existentes.

### App.notify (agente Remote) — avisos al móvil
`App.notify.send(title, body)`: si el ajuste `ntfyTopic` está configurado, POST a `https://ntfy.sh/<topic>`
(vía App.net.fetch). Sin topic, no hace nada. El agente Player lo llama desde watch.js al terminar una descarga;
Search/follow al añadir un episodio nuevo automático.

### App.follow (agente Search, js/follow.js) — seguir series
`App.follow.list() → [{imdbId, name, poster, since}]`, `isFollowing(imdbId)`, `toggle({imdbId, name, poster})`,
`upcoming() → Promise<[{imdbId, name, poster, season, episode, title, released}]>` (próximos/recientes 14 días,
desde App.meta.title videos[].released). Emite `follow:change`. Motor de auto-descarga (ajuste `followAuto`)
cada 6 h: episodios nuevos ya emitidos → mejor fuente (App.search.bestStream sobre add-ons) → si en caché,
añadir a TorBox; si no, añadir y App.watch.track. Registro en App.store('followDone').

### Acciones remotas (service.js → remote.js), agente Remote
Además de settings/add: `{type:"play", mediaType:"movie"|"series", imdbId, season, episode}` →
`App.search.playTitle(...)`; `{type:"playUrl", url, title}` → `App.player.play`; `{type:"control", cmd, arg}` →
`App.player.control`; `{type:"key", key:"up|down|left|right|ok|back|..."}` → simula tecla en la app.
La TV publica `App.player.status()` en `/tv/status` cada 2 s mientras reproduce.

### Perfiles (agente Core)
`App.profile.list()`, `current()`, `switch(id)`, `create(name, pin)`. Datos por perfil: historial, ajustes de
idioma/preferencias, follow, favoritos. Claves de cuenta (torboxToken, tmdbKey, stremioAddon(s), trakt*) son
globales. Implementación transparente en App.store (prefijo por perfil) — los demás módulos no cambian nada.

### Varios add-ons (agente Search)
Nuevo ajuste `stremioAddons` (array de URLs de manifest); `stremioAddon` (string) sigue valiendo como primero.
Fuentes fusionadas y deduplicadas por infoHash/url.

## Rediseño "TorBox 2.0" (semver interno v3.0.0) — especificación visual OBLIGATORIA
Referencia visual: `design/*.dc.html` (maquetas 1920×1080: Main=Inicio, Detail=Ficha de serie, Player=Reproductor,
Guide=TV en directo, Phone=web del móvil 390×844). Ábrelas como HTML de referencia (ignora `{{accent}}`/x-dc: es
el color de acento). Lienzo: https://claude.ai/artifact/Qst6HEoZgJZHKV6GaYftxG

**Tokens** (en `:root` de base.css; los temas de extras.js deben seguir funcionando cambiando `--accent`):
- Fondo `--bg:#0A0D12`; superficies `--surface:#141A22`, `--surface-2:#1C2430`, `--surface-3:#2B3645`; rail `#0F141B`.
- Texto `--text:#F2F5F8`, secundario `--muted:#A3AFBC`, terciario `#8494A5`; bordes `#3E4B5B`.
- Acento `--accent:#19D46B` (SOLO acción principal y estados "listo"); aviso `--warn:#F2B84B`; error `--danger:#FF6B6B`.
- Tipografía: títulos **Space Grotesk** 600/700, texto **Inter** 400–700 (Google Fonts con fallback system-ui;
  si no hay red, el fallback debe verse bien). Mínimo 19–20 px en TV para texto secundario, 22–26 px normal.
- Radios 14–20 px; rejilla de 8 px; márgenes laterales 96 px (72 px junto al rail).

**Reglas UX**
1. **Navegación lateral (rail)** de 112 px a la izquierda con iconos SVG de trazo (Inicio, Buscar, Biblioteca,
   TV, Descargas; abajo Ajustes y avatar de perfil) en vez de pestañas arriba. ◄ desde el borde izquierdo del
   contenido entra al rail; ► o OK vuelve al contenido. Sección activa: fondo acento con icono oscuro.
   "Continuar" deja de ser sección propia del rail (su contenido vive en Inicio; la pantalla puede seguir
   existiendo con nav:false).
2. **Foco inequívoco**: aro blanco 4 px (`box-shadow: 0 0 0 4px var(--text)`), escala 1.04–1.06 en tarjetas,
   sombra; botones enfocados = fondo blanco + texto oscuro + doble aro. Nunca solo cambio de color.
3. **Una acción principal por pantalla** (botón blanco grande); secundarias en `rgba(242,245,248,.13)`.
4. **Barra de pista inferior** en cada pantalla: a la izquierda las teclas útiles, a la derecha la píldora
   "Mantén OK" + "más opciones" (texto i18n existente main.hint / hints de cada pantalla). Sustituye al hint de
   la cabecera.
5. Cabecera mínima: chips de filtro/categoría a la izquierda (si la pantalla los tiene), estado
   ("TorBox conectado" con punto acento) y hora a la derecha.
6. Insignias/etiquetas: borde `#3E4B5B` radio 8 px; "Al instante" = fondo acento texto oscuro; descargando = warn.
7. Sin emoji en la UI (usar SVG inline de trazo). Contraste ≥ 4.5:1.
