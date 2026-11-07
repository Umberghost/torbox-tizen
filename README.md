# TorBox para TizenBrew

Módulo tipo *app* para ver tu biblioteca de TorBox (torrents, usenet y descargas web) en una Samsung con Tizen, a través de TizenBrew. Navegación pensada para el mando.

## Qué hace (v2)
- Biblioteca con carátulas, puntuación y sinopsis (TMDB), series agrupadas por temporada.
- Reproductor nativo AVPlay (MKV/HEVC) con respaldo `<video>`, continuar viendo, siguiente episodio.
- Subtítulos (incrustados y .srt/.vtt) y pistas de audio.
- TV en directo (TDTChannels: RTVE, autonómicas…) y accesos a Atresplayer / Mediaset Infinity / Tivify.
- Buscar y añadir a TorBox, descargas en curso, ajustes y teclado en pantalla.

## Instalar
1. TV en modo desarrollador con **Host PC IP = 127.0.0.1** y TizenBrew instalado.
2. TizenBrew → Module Manager → Add module → `gh/Umberghost/torbox-tizen`.
3. Abre "TorBox", pega tu API key de TorBox y, opcional, tu clave TMDB en Ajustes.

`service.js` es un proxy local (127.0.0.1:8095) que TizenBrew arranca en la TV: la API de
TorBox no permite CORS desde otros orígenes que torbox.app.

## Tu API key
torbox.app → Ajustes → sección API → copia la key. Es tu credencial personal; el módulo solo la usa para hablar con `api.torbox.app`.

## Arquitectura
Ver `ARCHITECTURE.md`.

## Usar la app en el móvil, PC o Android TV (Cloudflare Worker)
1. Crea una cuenta gratis en https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** → nombre `torbox` → **Deploy**.
2. **Edit code** → borra todo, pega el contenido de `cloud/worker.js` → **Deploy**.
3. Abre `https://torbox.<tu-subdominio>.workers.dev/` en cualquier navegador. La app se sirve siempre desde
   la rama `master` de este repo (se actualiza sola). Ratón/táctil: clic = OK; botón ← = Atrás.

## App instalada (recomendada): AVPlay para MKV/HEVC
Dentro de TizenBrew la página no tiene APIs de Samsung (sin AVPlay → no abre MKV). La app instalada
`tizen-app/` sí: carga el código de la última versión etiquetada en GitHub en cada arranque (se actualiza
sola) y trae su propio servicio (proxy + web del móvil), así que no necesita TizenBrew.
1. TV en modo desarrollador con Host PC IP = IP de tu PC; reinicia.
2. `python tizen-app/build.py` → `tizen-app/TorBox.wgt`.
3. TizenBrew Installer (PC) → Select file to install → `TorBox.wgt` (lo firma con tu certificado).
4. Vuelve a poner Host PC IP = 127.0.0.1 y reinicia.
