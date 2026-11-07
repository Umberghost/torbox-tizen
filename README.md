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
