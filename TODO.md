# TODO — TorBox para Tizen

Pendientes acordados el 2026-11-07. Prioridad sugerida: **1 + 4 + 2** primero.

## Bloqueante antes de nada
- [ ] Confirmar en la TV que la app instalada (`tizen-app/TorBox.wgt`) arranca su servicio y que AVPlay
      reproduce MKV/HEVC (Registro: `[diag] avplay disponible al arrancar: true`).

## Uso diario
- [ ] **1. Buscar en el móvil → "Ver en la TV"**: buscador en la web del móvil (teclado del móvil); al elegir
      episodio/película, la TV lo reproduce (acción remota vía service.js → remote.js → App.search.playTitle).
- [ ] **2. Seguir series + descarga automática**: botón "Seguir" en la ficha; al salir un episodio nuevo
      (Trakt/TMDB) buscar la mejor fuente (idioma/calidad preferidos) y añadirla a TorBox; aviso al estar lista.
- [ ] **3. Calendario "Nuevos episodios"**: fila en Inicio con los estrenos de la semana de las series seguidas.
- [ ] **4. Varios add-ons a la vez**: Torrentio + Comet / MediaFusion + add-on oficial de TorBox para Stremio;
      fusionar y deduplicar fuentes por infoHash; configurar la lista desde la web del móvil.
- [ ] **5. Saltar intro y créditos**: botón "Saltar intro" (IntroDB; AniSkip para anime) y "Siguiente episodio"
      al llegar a los créditos.

## Comodidad
- [ ] **6. Perfiles** (varios usuarios) con su propio Continuar viendo y ajustes; PIN opcional (contenido adulto).
- [ ] **7. Desfase de subtítulos** ajustable (±0,5 s) desde el reproductor.
- [ ] **8. Temporizador de apagado**: "al terminar el episodio" o 30/60/90 min.
- [ ] **9. Copia de seguridad de ajustes**: exportar/importar desde la web del móvil (app TizenBrew, app
      instalada y Worker comparten configuración).
- [ ] **10. Estado de la cuenta TorBox** en Ajustes: plan, caducidad, almacenamiento y huecos libres.

## Extras
- [ ] **12. Contraseña para el Cloudflare Worker** (si se comparte el enlace).
- [ ] **13. Modo móvil** de la interfaz (diseño adaptado a pantalla vertical) para el Worker.

---

# Ideas aprobadas (lista de 100, 2026-11-07)
Numeración = la de la lista de ideas original.

## Reproductor
- [ ] **#1** Selector de velocidad de reproducción (0,75×–2×).
- [ ] **#2** Al reanudar, retroceder 5 s automáticamente para recuperar contexto.
- [ ] **#3** Miniaturas al buscar en la barra de progreso (stills de TMDB si existen).
- [ ] **#10** Zoom y relación de aspecto (rellenar, 4:3, 21:9).
- [ ] **#11** Panel de información técnica: códec, resolución, bitrate, motor (AVPlay/video).
- [ ] **#16** "Resumen de la temporada anterior" (sinopsis TMDB) antes del episodio 1 de una temporada.
- [ ] **#18** Marcar como visto el episodio actual al saltar al siguiente.
- [ ] **#19** Atajo para repetir los últimos 10 s.

## Descubrir contenido
- [ ] **#21** Filtros en Inicio por género, año, idioma original y nota.
- [ ] **#22** Fila "Porque viste X" basada en el historial.
- [ ] **#23** Colecciones/sagas completas (TMDB collections).
- [ ] **#25** Top 10 por país (España esta semana).
- [ ] **#31** Búsqueda tolerante a faltas de ortografía.
- [ ] **#32** Historial de búsquedas con sugerencias al escribir.
- [ ] **#33** "Sorpréndeme": título aleatorio bien valorado en tu idioma.
- [ ] **#34** Ocultar en Inicio lo ya visto.
- [ ] **#35** Notas de Rotten Tomatoes y Metacritic además de IMDb.
- [ ] **#37** Duración del episodio y hora a la que terminaría si empiezas ahora.
- [ ] **#39** Próximos estrenos de cine (para pedirlos cuando salgan).

## Biblioteca y TorBox
- [ ] **#42** Filtros de biblioteca: solo series, solo películas, sin terminar.
- [ ] **#45** Aviso "caducará pronto" (>25 días sin uso en TorBox).
- [ ] **#46** "Refrescar" con un clic los títulos a punto de caducar.
- [ ] **#47** Mostrar descargas con el título bonito de TMDB en vez del nombre del release.

## TV en directo
- [ ] **#61** EPG completo en rejilla tipo TDT.
- [ ] **#64** Reordenar canales y numeración propia.
- [ ] **#65** Ocultar canales que no interesan.
- [ ] **#66** Importar listas M3U adicionales.
- [ ] **#68** Mini-guía al pulsar INFO durante el directo.

## Móvil, web y otros dispositivos
- [ ] **#76** Mando a distancia en la web del móvil (flechas, OK, atrás).
- [ ] **#77** Ver en el móvil qué se reproduce en la TV y su progreso.
- [ ] **#78** Pausar/reanudar la TV desde el móvil.
- [ ] **#79** Pegar un enlace en el móvil y reproducirlo directamente en la TV.
- [ ] **#80** Código QR en la TV para abrir la web del móvil sin teclear la IP.
- [ ] **#81** Notificaciones push al móvil cuando termine una descarga.
- [ ] **#83** Atajo de iOS/Android "Compartir → Enviar a TorBox TV".
- [ ] **#84** APK para Android TV que cargue la web con soporte de mando.
- [ ] **#85** PWA instalable en el móvil.
- [ ] **#86** Sincronizar "Continuar viendo" entre dispositivos sin Trakt (almacenamiento en el Worker).
- [ ] **#88** Gestionar varias TVs de casa desde la misma web.

## Calidad y personalización
- [ ] **#89** Pantalla "Qué hay de nuevo" al actualizar de versión.
- [ ] **#92** Temas de color (verde, azul, negro OLED).
- [ ] **#93** Tamaño de interfaz ajustable.
- [ ] **#94** Salvapantallas con pósters tras X minutos de inactividad.
- [ ] **#95** Sonidos de navegación opcionales.
- [ ] **#98** Más idiomas de interfaz (catalán, gallego, euskera, portugués, francés).
- [ ] **#100** Telemetría local opcional de uso de pantallas para priorizar mejoras.
