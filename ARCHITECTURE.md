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
