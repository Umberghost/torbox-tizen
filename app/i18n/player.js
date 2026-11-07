/* i18n/player.js — textos de player, continue, watch, subs e history. */
(function(){
"use strict";
var A = window.App.i18n;

A.add("en", {
  "nav.continue": "Continue",

  /* Idiomas (nombres de pistas) */
  "player.lang.spa": "Spanish", "player.lang.eng": "English", "player.lang.fre": "French",
  "player.lang.ger": "German", "player.lang.ita": "Italian", "player.lang.por": "Portuguese",
  "player.lang.pob": "Portuguese (BR)", "player.lang.cat": "Catalan", "player.lang.baq": "Basque",
  "player.lang.glg": "Galician", "player.lang.jpn": "Japanese", "player.lang.kor": "Korean",
  "player.lang.chi": "Chinese", "player.lang.rus": "Russian", "player.lang.dut": "Dutch",
  "player.lang.pol": "Polish", "player.lang.und": "Unknown",

  /* OSD */
  "player.live": "LIVE",
  "player.keyAudio": "Audio", "player.keySubs": "Subtitles", "player.keyTracks": "▲ Tracks", "player.keyNext": "⏭ Next",

  /* Errores */
  "player.err.unsupported": "Format or codec not supported by the TV.",
  "player.err.network": "Network error while loading the video.",
  "player.err.invalidUri": "Invalid or expired video link.",
  "player.err.seek": "Could not jump to that position.",
  "player.err.drm": "DRM-protected content.",
  "player.err.avplay": "The native player could not open the video{code}.",
  "player.err.decode": "Error decoding the video (codec not supported).",
  "player.err.browserFormat": "Format not supported by the TV browser.",
  "player.err.generic": "The video could not be played.",
  "player.err.open": "The video could not be opened.",
  "player.err.hls": "HLS error: {detail}",
  "player.err.hlsCut": "The stream was interrupted ({detail}).",
  "player.err.noHls": "This browser cannot play HLS and hls.js is missing.",
  "player.err.liveEnd": "The broadcast has ended or was interrupted.",
  "player.err.title": "Could not play",
  "player.err.learned": "This format has been marked as incompatible and will be hidden from now on (Settings → Hide incompatible formats).",
  "player.err.browserOnly": "Outside the TV only the browser player is used, which cannot open MKV/HEVC.",
  "player.retry": "Retry",
  "player.tryHtml5": "Try the HTML5 player",
  "player.tryAvplay": "Try AVPlay",

  /* Reanudar / siguiente */
  "player.resumeTitle": "Resume from {time}?",
  "player.resume": "Resume",
  "player.fromStart": "From the beginning",
  "player.nextIn": "Next episode in {n} s",
  "player.nextKeys": "OK now · Back cancel",
  "player.noNext": "No next episode",
  "player.noMore": "No more episodes",
  "player.loadingNext": "Loading next episode…",
  "player.nextFailed": "Could not load the next one: {msg}",
  "player.noLink": "No video link",

  /* Pistas */
  "player.subsOff": "Subtitles off",
  "player.subsOn": "Subtitles on",
  "player.subsTrackFail": "Could not enable that track",
  "player.subsEmpty": "The subtitle file is empty or unreadable",
  "player.subsNamed": "Subtitles: {name}",
  "player.subsLoadFail": "Could not load the subtitles: {msg}",
  "player.subsTitle": "Subtitles",
  "player.subsDisabled": "Off",
  "player.subsEmbedded": "{label} (embedded)",
  "player.subsFile": "{label} (file)",
  "player.subsNone": "(No subtitles available)",
  "player.subsLoading": "(Looking for subtitles online…)",
  "player.subsFound.one": "{n} subtitle found online (GREEN)",
  "player.subsFound.other": "{n} subtitles found online (GREEN)",
  "player.audioOne": "There is only one audio track",
  "player.audioNoSwitch": "This player cannot switch audio",
  "player.audioTitle": "Audio",
  "player.audioChanged": "Audio changed",
  "player.audioFail": "Could not change the audio track",
  "player.sizeTitle": "Subtitle size",
  "player.size.s": "Small", "player.size.m": "Medium", "player.size.l": "Large",
  "player.tracksTitle": "Tracks",
  "player.trackAudio": "Audio: {v}",
  "player.trackSubs": "Subtitles: {v}",
  "player.trackSize": "Subtitle size: {v}",
  "player.trackEngine": "Engine: {v}",
  "player.engineAvplay": "AVPlay (native)",
  "player.engineHtml5": "HTML5",
  "player.default": "Default",
  "player.embedded": "Embedded",
  "player.file": "File",
  "player.avplayTvOnly": "AVPlay is only available on the TV",

  /* Continuar viendo */
  "continue.hint": "OK resume · RED remove from list",
  "continue.title": "Continue watching",
  "continue.count.one": "{n} title",
  "continue.count.other": "{n} titles",
  "continue.emptyTitle": "Nothing in progress",
  "continue.emptyText": "When you leave something halfway it will appear here to pick it up where you left off.",
  "continue.left": "{time} left",
  "continue.preparing": "Preparing playback…",
  "continue.cantResume": "Could not resume: {msg}",
  "continue.noData": "Not enough data to resume this item",
  "continue.removeTitle": "Remove from the list?",
  "continue.remove": "Remove",
  "continue.removed": "Removed from Continue watching",
  "continue.untitled": "(untitled)",
  "continue.legendOk": "OK resume",
  "continue.legendRemove": "Remove from list",

  /* Watch (avisos de descargas) */
  "watch.ready": "Ready: {title}",
  "watch.keys": "OK to watch · Back to dismiss",
  "watch.toast": "✓ {title} is ready",
  "watch.opening": "Opening {title}…",
  "watch.notFound": "Could not find the download in TorBox",
  "watch.playFailed": "Could not play: {msg}",
  "watch.tracking": "We'll let you know when it is ready"
});

A.add("es", {
  "nav.continue": "Continuar",

  "player.lang.spa": "Español", "player.lang.eng": "Inglés", "player.lang.fre": "Francés",
  "player.lang.ger": "Alemán", "player.lang.ita": "Italiano", "player.lang.por": "Portugués",
  "player.lang.pob": "Portugués (BR)", "player.lang.cat": "Catalán", "player.lang.baq": "Euskera",
  "player.lang.glg": "Gallego", "player.lang.jpn": "Japonés", "player.lang.kor": "Coreano",
  "player.lang.chi": "Chino", "player.lang.rus": "Ruso", "player.lang.dut": "Neerlandés",
  "player.lang.pol": "Polaco", "player.lang.und": "Desconocido",

  "player.live": "EN DIRECTO",
  "player.keyAudio": "Audio", "player.keySubs": "Subtítulos", "player.keyTracks": "▲ Pistas", "player.keyNext": "⏭ Siguiente",

  "player.err.unsupported": "Formato o códec no soportado por la TV.",
  "player.err.network": "Error de red al cargar el vídeo.",
  "player.err.invalidUri": "Enlace de vídeo no válido o caducado.",
  "player.err.seek": "No se pudo saltar a esa posición.",
  "player.err.drm": "Contenido protegido con DRM.",
  "player.err.avplay": "El reproductor nativo no pudo abrir el vídeo{code}.",
  "player.err.decode": "Error al decodificar el vídeo (códec no soportado).",
  "player.err.browserFormat": "Formato no soportado por el navegador de la TV.",
  "player.err.generic": "No se pudo reproducir el vídeo.",
  "player.err.open": "No se pudo abrir el vídeo.",
  "player.err.hls": "Error HLS: {detail}",
  "player.err.hlsCut": "Se cortó la emisión ({detail}).",
  "player.err.noHls": "Este navegador no reproduce HLS y falta hls.js.",
  "player.err.liveEnd": "La emisión ha terminado o se ha cortado.",
  "player.err.title": "No se pudo reproducir",
  "player.err.learned": "Este formato queda marcado como no compatible y se ocultará a partir de ahora (Ajustes → Ocultar formatos no compatibles).",
  "player.err.browserOnly": "Fuera de la TV solo se usa el reproductor del navegador, que no abre MKV/HEVC.",
  "player.retry": "Reintentar",
  "player.tryHtml5": "Probar con reproductor HTML5",
  "player.tryAvplay": "Probar con AVPlay",

  "player.resumeTitle": "¿Reanudar desde {time}?",
  "player.resume": "Reanudar",
  "player.fromStart": "Desde el principio",
  "player.nextIn": "Siguiente episodio en {n} s",
  "player.nextKeys": "OK ya · Atrás cancelar",
  "player.noNext": "No hay siguiente episodio",
  "player.noMore": "No hay más episodios",
  "player.loadingNext": "Cargando siguiente episodio…",
  "player.nextFailed": "No se pudo cargar el siguiente: {msg}",
  "player.noLink": "No hay enlace de vídeo",

  "player.subsOff": "Subtítulos desactivados",
  "player.subsOn": "Subtítulos activados",
  "player.subsTrackFail": "No se pudo activar esa pista",
  "player.subsEmpty": "El archivo de subtítulos está vacío o no se entiende",
  "player.subsNamed": "Subtítulos: {name}",
  "player.subsLoadFail": "No se pudieron cargar los subtítulos: {msg}",
  "player.subsTitle": "Subtítulos",
  "player.subsDisabled": "Desactivados",
  "player.subsEmbedded": "{label} (incrustado)",
  "player.subsFile": "{label} (archivo)",
  "player.subsNone": "(No hay subtítulos disponibles)",
  "player.subsLoading": "(Buscando subtítulos en internet…)",
  "player.subsFound.one": "{n} subtítulo encontrado en internet (VERDE)",
  "player.subsFound.other": "{n} subtítulos encontrados en internet (VERDE)",
  "player.audioOne": "Solo hay una pista de audio",
  "player.audioNoSwitch": "Este reproductor no permite cambiar el audio",
  "player.audioTitle": "Audio",
  "player.audioChanged": "Audio cambiado",
  "player.audioFail": "No se pudo cambiar la pista de audio",
  "player.sizeTitle": "Tamaño de subtítulos",
  "player.size.s": "Pequeño", "player.size.m": "Mediano", "player.size.l": "Grande",
  "player.tracksTitle": "Pistas",
  "player.trackAudio": "Audio: {v}",
  "player.trackSubs": "Subtítulos: {v}",
  "player.trackSize": "Tamaño de subtítulos: {v}",
  "player.trackEngine": "Motor: {v}",
  "player.engineAvplay": "AVPlay (nativo)",
  "player.engineHtml5": "HTML5",
  "player.default": "Predeterminado",
  "player.embedded": "Incrustados",
  "player.file": "Archivo",
  "player.avplayTvOnly": "AVPlay solo está disponible en la TV",

  "continue.hint": "OK reanudar · ROJO quitar de la lista",
  "continue.title": "Continuar viendo",
  "continue.count.one": "{n} título",
  "continue.count.other": "{n} títulos",
  "continue.emptyTitle": "Nada a medias",
  "continue.emptyText": "Cuando dejes algo a medias aparecerá aquí para retomarlo donde lo dejaste.",
  "continue.left": "Quedan {time}",
  "continue.preparing": "Preparando reproducción…",
  "continue.cantResume": "No se pudo reanudar: {msg}",
  "continue.noData": "Faltan datos para reanudar este elemento",
  "continue.removeTitle": "¿Quitar de la lista?",
  "continue.remove": "Quitar",
  "continue.removed": "Quitado de Continuar viendo",
  "continue.untitled": "(sin título)",
  "continue.legendOk": "OK reanudar",
  "continue.legendRemove": "Quitar de la lista",

  "watch.ready": "Ya está listo: {title}",
  "watch.keys": "OK para ver · Atrás cerrar",
  "watch.toast": "✓ {title} ya está listo",
  "watch.opening": "Abriendo {title}…",
  "watch.notFound": "No se encontró la descarga en TorBox",
  "watch.playFailed": "No se pudo reproducir: {msg}",
  "watch.tracking": "Te avisaré cuando esté listo"
});

/* ---- Ronda 4: panel de iconos, saltar intro, temporizador, velocidad, zoom, info ---- */
A.add("en", {
  "settings.group.player": "Playback",
  "player.keyPanel": "▼ Controls",
  "player.subsFound.one": "{n} subtitle found online",
  "player.subsFound.other": "{n} subtitles found online",
  "continue.hint": "OK resume · Hold OK: options",
  "continue.legendRemove": "Remove from list (or hold OK)",

  "player.ctl.rw": "Back 10 s", "player.ctl.ff": "Forward 10 s", "player.ctl.replay": "Replay 10 s",
  "player.ctl.playpause": "Play/Pause", "player.ctl.audio": "Audio", "player.ctl.subs": "Subtitles",
  "player.ctl.subdelay": "Sub delay", "player.ctl.speed": "Speed", "player.ctl.zoom": "Aspect",
  "player.ctl.info": "Info", "player.ctl.sleep": "Timer", "player.ctl.next": "Next episode", "player.ctl.close": "Close",

  "player.speedTitle": "Playback speed", "player.speedSet": "Speed {v}×", "player.speedFail": "This player cannot change the speed",
  "player.zoomTitle": "Zoom / aspect ratio", "player.zoomFail": "This player cannot change the aspect ratio",
  "player.zoom.fit": "Fit (original)", "player.zoom.fill": "Fill (crop)", "player.zoom.stretch": "Stretch", "player.zoom.cinema": "Zoom 21:9",

  "player.subDelayTitle": "Subtitle delay ({v})", "player.subDelayReset": "Reset to 0",
  "player.subDelayNow": "Subtitle delay: {v} s",

  "player.infoTitle": "Technical info", "player.info.engine": "Engine", "player.info.res": "Resolution",
  "player.info.vcodec": "Video codec", "player.info.acodec": "Audio codec", "player.info.bitrate": "Bitrate",
  "player.info.fps": "Frame rate", "player.info.dropped": "Dropped frames", "player.info.size": "File size",
  "player.info.server": "Server", "player.info.speed": "Speed",

  "player.sleep.title": "Sleep timer", "player.sleep.optEnd": "At the end of the episode",
  "player.sleep.opt.other": "In {n} minutes", "player.sleep.opt.one": "In {n} minute", "player.sleep.optOff": "Off",
  "player.sleep.off": "Timer off", "player.sleep.setEnd": "The player will stop at the end of the episode",
  "player.sleep.set": "The player will stop in {n} min", "player.sleep.warn": "Stopping in {n} s…",
  "player.sleep.done": "Sleep timer: playback stopped",

  "player.skipIntro": "Skip intro", "player.skipRecap": "Skip recap", "player.skipNext": "Next episode", "player.skipAuto": "Intro skipped",
  "player.recap.title": "Previously, season {n}", "player.recap.skip": "Any key to skip",

  "player.set.speed": "Default speed", "player.set.speed.desc": "Playback speed applied when a video starts.",
  "player.set.rewind": "Rewind 5 s on resume", "player.set.rewind.desc": "Go back 5 seconds when resuming to recover context.",
  "player.set.skipAuto": "Skip intros automatically", "player.set.skipAuto.desc": "Jump over the intro without pressing OK (needs skip data for the episode).",

  "watch.notifyTitle": "Download ready", "watch.notifyBody": "{title} is ready to watch",

  "continue.actResume": "Resume", "continue.actStart": "Play from the beginning",
  "continue.actWatched": "Mark as watched", "continue.actRemove": "Remove from the list"
});

A.add("es", {
  "settings.group.player": "Reproducción",
  "player.keyPanel": "▼ Controles",
  "player.subsFound.one": "{n} subtítulo encontrado en internet",
  "player.subsFound.other": "{n} subtítulos encontrados en internet",
  "continue.hint": "OK reanudar · Mantén OK: opciones",
  "continue.legendRemove": "Quitar de la lista (o mantén OK)",

  "player.ctl.rw": "Atrás 10 s", "player.ctl.ff": "Adelante 10 s", "player.ctl.replay": "Repetir 10 s",
  "player.ctl.playpause": "Play/Pausa", "player.ctl.audio": "Audio", "player.ctl.subs": "Subtítulos",
  "player.ctl.subdelay": "Desfase subs", "player.ctl.speed": "Velocidad", "player.ctl.zoom": "Aspecto",
  "player.ctl.info": "Info", "player.ctl.sleep": "Temporizador", "player.ctl.next": "Siguiente", "player.ctl.close": "Cerrar",

  "player.speedTitle": "Velocidad de reproducción", "player.speedSet": "Velocidad {v}×", "player.speedFail": "Este reproductor no puede cambiar la velocidad",
  "player.zoomTitle": "Zoom / relación de aspecto", "player.zoomFail": "Este reproductor no puede cambiar el aspecto",
  "player.zoom.fit": "Ajustar (original)", "player.zoom.fill": "Rellenar (recortar)", "player.zoom.stretch": "Estirar", "player.zoom.cinema": "Zoom 21:9",

  "player.subDelayTitle": "Desfase de subtítulos ({v})", "player.subDelayReset": "Restablecer a 0",
  "player.subDelayNow": "Desfase de subtítulos: {v} s",

  "player.infoTitle": "Información técnica", "player.info.engine": "Motor", "player.info.res": "Resolución",
  "player.info.vcodec": "Códec de vídeo", "player.info.acodec": "Códec de audio", "player.info.bitrate": "Bitrate",
  "player.info.fps": "Fotogramas/s", "player.info.dropped": "Fotogramas perdidos", "player.info.size": "Tamaño del archivo",
  "player.info.server": "Servidor", "player.info.speed": "Velocidad",

  "player.sleep.title": "Temporizador de apagado", "player.sleep.optEnd": "Al terminar el episodio",
  "player.sleep.opt.other": "En {n} minutos", "player.sleep.opt.one": "En {n} minuto", "player.sleep.optOff": "Desactivado",
  "player.sleep.off": "Temporizador desactivado", "player.sleep.setEnd": "El reproductor se detendrá al terminar el episodio",
  "player.sleep.set": "El reproductor se detendrá en {n} min", "player.sleep.warn": "Se detiene en {n} s…",
  "player.sleep.done": "Temporizador: reproducción detenida",

  "player.skipIntro": "Saltar intro", "player.skipRecap": "Saltar resumen", "player.skipNext": "Siguiente episodio", "player.skipAuto": "Intro saltada",
  "player.recap.title": "Anteriormente, temporada {n}", "player.recap.skip": "Cualquier tecla para saltar",

  "player.set.speed": "Velocidad predeterminada", "player.set.speed.desc": "Velocidad de reproducción al empezar un vídeo.",
  "player.set.rewind": "Retroceder 5 s al reanudar", "player.set.rewind.desc": "Vuelve 5 segundos al reanudar para recuperar el hilo.",
  "player.set.skipAuto": "Saltar intros automáticamente", "player.set.skipAuto.desc": "Salta la intro sin pulsar OK (requiere datos del episodio).",

  "watch.notifyTitle": "Descarga lista", "watch.notifyBody": "{title} está listo para ver",

  "continue.actResume": "Reanudar", "continue.actStart": "Ver desde el principio",
  "continue.actWatched": "Marcar como visto", "continue.actRemove": "Quitar de la lista"
});

})();
