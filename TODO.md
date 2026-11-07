# TODO — TorBox para Tizen

Pendientes acordados el 2026-11-07. Prioridad sugerida: **1 + 4 + 2** primero.

## Bloqueante antes de nada
- [ ] Confirmar en la TV que la app instalada (`tizen-app/TorBox.wgt`) arranca su servicio y que AVPlay
      reproduce MKV/HEVC (Registro: `[diag] avplay disponible al arrancar: true`).

## Prioridad alta (robustez, 2026-11-07)
- [x] **A1. Alternativas a los botones de colores** (Smart Remote sin colores/INFO/números): menú contextual
      manteniendo OK (y tecla TOOLS) con las mismas acciones en cada pantalla; panel de iconos en el reproductor.
- [x] **A2. Arranque rápido y sin red** de la app instalada: un solo archivo empaquetado por versión + copia local.
- [x] **A3. Volver a la versión anterior**: fijar versión / "usar anterior" desde la web del móvil y autorrollback si no arranca.
- [x] **A4. Almacenamiento**: cachés grandes a IndexedDB, límites y aviso de espacio (no perder ajustes).
- [ ] **A5. (PENDIENTE AVPlay)** Calidad: ajuste de frecuencia 24p, HDR, passthrough Dolby/Atmos, aviso de subtítulos PGS.
- [x] **A6. Registro persistente**: últimos errores guardados y mostrados al abrir ("la última vez falló…").
- [x] **A7. Seguridad**: recordatorio de rotar la API key y gestión cómoda del cambio de clave en todos los sitios.

## Uso diario
- [x] **1. Buscar en el móvil → "Ver en la TV"**: buscador en la web del móvil (teclado del móvil); al elegir
      episodio/película, la TV lo reproduce (acción remota vía service.js → remote.js → App.search.playTitle).
- [x] **2. Seguir series + descarga automática**: botón "Seguir" en la ficha; al salir un episodio nuevo
      (Trakt/TMDB) buscar la mejor fuente (idioma/calidad preferidos) y añadirla a TorBox; aviso al estar lista.
- [x] **3. Calendario "Nuevos episodios"**: fila en Inicio con los estrenos de la semana de las series seguidas.
- [x] **4. Varios add-ons a la vez**: Torrentio + Comet / MediaFusion + add-on oficial de TorBox para Stremio;
      fusionar y deduplicar fuentes por infoHash; configurar la lista desde la web del móvil.
- [x] **5. Saltar intro y créditos**: botón "Saltar intro" (IntroDB; AniSkip para anime) y "Siguiente episodio"
      al llegar a los créditos.

## Comodidad
- [x] **6. Perfiles** (varios usuarios) con su propio Continuar viendo y ajustes; PIN opcional (contenido adulto).
- [x] **7. Desfase de subtítulos** ajustable (±0,5 s) desde el reproductor.
- [x] **8. Temporizador de apagado**: "al terminar el episodio" o 30/60/90 min.
- [x] **9. Copia de seguridad de ajustes**: exportar/importar desde la web del móvil (app TizenBrew, app
      instalada y Worker comparten configuración).
- [x] **10. Estado de la cuenta TorBox** en Ajustes: plan, caducidad, almacenamiento y huecos libres.

## Extras
- [x] **12. Contraseña para el Cloudflare Worker** (si se comparte el enlace).
- [x] **13. Modo móvil** de la interfaz (diseño adaptado a pantalla vertical) para el Worker.

---

# Ideas aprobadas (lista de 100, 2026-11-07)
Numeración = la de la lista de ideas original.

## Reproductor
- [x] **#1** Selector de velocidad de reproducción (0,75×–2×).
- [x] **#2** Al reanudar, retroceder 5 s automáticamente para recuperar contexto.
- [x] **#3** Miniaturas al buscar en la barra de progreso (stills de TMDB si existen).
- [x] **#10** Zoom y relación de aspecto (rellenar, 4:3, 21:9).
- [x] **#11** Panel de información técnica: códec, resolución, bitrate, motor (AVPlay/video).
- [x] **#16** "Resumen de la temporada anterior" (sinopsis TMDB) antes del episodio 1 de una temporada.
- [x] **#18** Marcar como visto el episodio actual al saltar al siguiente.
- [x] **#19** Atajo para repetir los últimos 10 s.

## Descubrir contenido
- [x] **#21** Filtros en Inicio por género, año, idioma original y nota.
- [x] **#22** Fila "Porque viste X" basada en el historial.
- [x] **#23** Colecciones/sagas completas (TMDB collections).
- [x] **#25** Top 10 por país (España esta semana).
- [x] **#31** Búsqueda tolerante a faltas de ortografía.
- [x] **#32** Historial de búsquedas con sugerencias al escribir.
- [x] **#33** "Sorpréndeme": título aleatorio bien valorado en tu idioma.
- [x] **#34** Ocultar en Inicio lo ya visto.
- [x] **#35** Notas de Rotten Tomatoes y Metacritic además de IMDb.
- [x] **#37** Duración del episodio y hora a la que terminaría si empiezas ahora.
- [x] **#39** Próximos estrenos de cine (para pedirlos cuando salgan).

## Biblioteca y TorBox
- [x] **#42** Filtros de biblioteca: solo series, solo películas, sin terminar.
- [x] **#45** Aviso "caducará pronto" (>25 días sin uso en TorBox).
- [x] **#46** "Refrescar" con un clic los títulos a punto de caducar.
- [x] **#47** Mostrar descargas con el título bonito de TMDB en vez del nombre del release.

## TV en directo
- [x] **#61** EPG completo en rejilla tipo TDT.
- [x] **#64** Reordenar canales y numeración propia.
- [x] **#65** Ocultar canales que no interesan.
- [x] **#66** Importar listas M3U adicionales.
- [x] **#68** Mini-guía al pulsar INFO durante el directo.

## Móvil, web y otros dispositivos
- [x] **#76** Mando a distancia en la web del móvil (flechas, OK, atrás).
- [x] **#77** Ver en el móvil qué se reproduce en la TV y su progreso.
- [x] **#78** Pausar/reanudar la TV desde el móvil.
- [x] **#79** Pegar un enlace en el móvil y reproducirlo directamente en la TV.
- [x] **#80** Código QR en la TV para abrir la web del móvil sin teclear la IP.
- [x] **#81** Notificaciones push al móvil cuando termine una descarga.
- [x] **#83** Atajo de iOS/Android "Compartir → Enviar a TorBox TV".
- [x] **#84** APK para Android TV que cargue la web con soporte de mando.
- [x] **#85** PWA instalable en el móvil.
- [x] **#86** Sincronizar "Continuar viendo" entre dispositivos sin Trakt (almacenamiento en el Worker).
- [x] **#88** Gestionar varias TVs de casa desde la misma web.

## Calidad y personalización
- [x] **#89** Pantalla "Qué hay de nuevo" al actualizar de versión.
- [x] **#92** Temas de color (verde, azul, negro OLED).
- [x] **#93** Tamaño de interfaz ajustable.
- [x] **#94** Salvapantallas con pósters tras X minutos de inactividad.
- [x] **#95** Sonidos de navegación opcionales.
- [ ] **#98** Más idiomas de interfaz (catalán, gallego, euskera, portugués, francés).
- [x] **#100** Telemetría local opcional de uso de pantallas para priorizar mejoras.
