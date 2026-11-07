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
