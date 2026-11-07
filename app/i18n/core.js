/* i18n/core.js — textos del núcleo (core, ui, main/setup, torbox, remote). */
(function(){
"use strict";
var A = window.App.i18n;

A.add("en", {
  "ui.ok": "OK", "ui.yes": "Yes", "ui.no": "No", "ui.cancel": "Cancel", "ui.close": "Close",
  "ui.loading": "Loading…", "ui.retry": "Retry", "ui.back": "Back", "ui.error": "Error",
  "core.corsBlocked": "The TV blocks direct connections to TorBox (CORS) and the proxy service is not responding. Reinstall the module in TizenBrew or restart the TV.",
  "main.hint": "▲▼◄► move · OK select · Back return",
  "main.noScreen": "Screen not available: {id}",
  "main.screenError": "Screen error",
  "main.exitTitle": "Exit TorBox?",
  "main.exit": "Exit",
  "setup.hint": "Type your API key · ▼ button · OK save",
  "setup.title": "Connect your TorBox account",
  "setup.text": "Paste your API key (torbox.app → Settings → API). It is stored only on this TV.",
  "setup.placeholder": "API key",
  "setup.save": "Save and continue",
  "setup.needKey": "Enter an API key",
  "setup.langHint": "Language: Settings → Language (or from your phone).",
  "torbox.noLink": "No download link",
  "torbox.badLink": "Link not recognised (use a magnet, hash, NZB or URL)",
  "torbox.badSource": "Unknown source",
  "remote.received": "Settings received from your phone ✓",
  "remote.noKey": "The TV has no TorBox API key yet.",
  "remote.kind.torrents": "Torrent", "remote.kind.usenet": "NZB", "remote.kind.webdl": "Web download",
  "remote.addedToast": "{what} added to TorBox ✓",
  "remote.addedReport": "{what} added to TorBox{name}. Check Downloads.",
  "remote.addFailed": "Could not add: {msg}",
  "remote.banner": "Set up from your phone or PC",
  "remote.pin": "PIN"
});

A.add("es", {
  "ui.ok": "Aceptar", "ui.yes": "Sí", "ui.no": "No", "ui.cancel": "Cancelar", "ui.close": "Cerrar",
  "ui.loading": "Cargando…", "ui.retry": "Reintentar", "ui.back": "Volver", "ui.error": "Error",
  "core.corsBlocked": "La TV bloquea la conexión directa con TorBox (CORS) y el servicio proxy no responde. Reinstala el módulo en TizenBrew o reinicia la TV.",
  "main.hint": "▲▼◄► moverse · OK elegir · Atrás volver",
  "main.noScreen": "Pantalla no disponible: {id}",
  "main.screenError": "Error en la pantalla",
  "main.exitTitle": "¿Salir de TorBox?",
  "main.exit": "Salir",
  "setup.hint": "Escribe tu API key · ▼ botón · OK guardar",
  "setup.title": "Conecta tu cuenta de TorBox",
  "setup.text": "Pega tu API key (torbox.app → Settings → API). Se guarda solo en esta TV.",
  "setup.placeholder": "API key",
  "setup.save": "Guardar y entrar",
  "setup.needKey": "Introduce una API key",
  "setup.langHint": "Idioma: Ajustes → Idioma (o desde el móvil).",
  "torbox.noLink": "Sin enlace de descarga",
  "torbox.badLink": "Enlace no reconocido (usa magnet, hash, NZB o URL)",
  "torbox.badSource": "Fuente desconocida",
  "remote.received": "Ajustes recibidos del móvil ✓",
  "remote.noKey": "La TV aún no tiene API key de TorBox.",
  "remote.kind.torrents": "Torrent", "remote.kind.usenet": "NZB", "remote.kind.webdl": "Descarga web",
  "remote.addedToast": "{what} añadido a TorBox ✓",
  "remote.addedReport": "{what} añadido a TorBox{name}. Míralo en Descargas.",
  "remote.addFailed": "No se pudo añadir: {msg}",
  "remote.banner": "Configura desde el móvil o el PC",
  "remote.pin": "PIN"
});
})();
