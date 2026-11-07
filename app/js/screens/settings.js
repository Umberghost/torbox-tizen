/* screens/settings.js — pantalla de Ajustes. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var S = App.settings;

var LANGS = [
  { label: "Español", value: "spa" },
  { label: "Inglés", value: "eng" },
  { label: "Original / ninguno", value: "" }
];
/* Ajustes que se pueden restablecer con ROJO (los valores salen de core.js) */
var RESETTABLE = ["defaultSource", "autoplayNext", "subLang", "audioLang", "subSize", "uiLang", "liveListUrl"];
var APPS = [
  { id: "tivify", label: "Tivify" },
  { id: "atresplayer", label: "Atresplayer" },
  { id: "mitele", label: "Mitele / Mediaset Infinity" }
];

function mask(v){
  v = String(v || "");
  if(!v) return "Sin configurar";
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "••••••" + v.slice(-4);
}
function labelOf(list, v){
  for(var i = 0; i < list.length; i++) if(list[i].value === v) return list[i].label;
  return v === "" ? "—" : String(v);
}
function appId(id){ var m = S.get("appIds") || {}; return m[id] || ""; }
function setAppId(id, v){
  var m = Object.assign({}, S.get("appIds") || {});
  if(v) m[id] = v; else delete m[id];
  S.set("appIds", m);
}

/* Definición de filas. type: secret | text | menu | bool | action */
function rows(){
  var r = [
    { group: "Cuenta" },
    { id: "torboxToken", type: "secret", label: "API key de TorBox",
      desc: "torbox.app → Settings → API. Se guarda solo en esta TV.",
      value: function(){ return mask(S.get("torboxToken")); },
      after: function(){ App.torbox.invalidate(); } },
    { id: "tmdbKey", type: "secret", label: "Clave de TMDB (carátulas y puntuaciones)",
      desc: "themoviedb.org → Ajustes → API. Vale la “API Key” (v3) o el “Token de lectura” (v4).",
      value: function(){ return mask(S.get("tmdbKey")); },
      after: function(){ App.bus.emit("meta:keychange"); } },

    { group: "Biblioteca" },
    { id: "defaultSource", type: "menu", label: "Fuente por defecto",
      desc: "Qué descargas se muestran al abrir la biblioteca.",
      options: [{ label: "Todas", value: "all" }, { label: "Torrents", value: "torrents" },
                { label: "Usenet", value: "usenet" }, { label: "Web", value: "webdl" }] },
    { id: "uiLang", type: "menu", label: "Idioma de metadatos",
      desc: "Idioma de títulos, sinopsis y carátulas de TMDB.",
      options: [{ label: "Español (España)", value: "es-ES" }, { label: "Español (México)", value: "es-MX" },
                { label: "Inglés", value: "en-US" }] },

    { group: "Reproducción" },
    { id: "autoplayNext", type: "bool", label: "Reproducir siguiente episodio automáticamente",
      desc: "Al terminar un episodio, empieza el siguiente de la temporada." },
    { id: "subLang", type: "menu", label: "Idioma de subtítulos preferido",
      desc: "Se activa automáticamente si el archivo lo trae.", options: LANGS },
    { id: "audioLang", type: "menu", label: "Idioma de audio preferido",
      desc: "Pista de audio elegida al empezar (si hay varias).", options: LANGS },
    { id: "subSize", type: "menu", label: "Tamaño de subtítulos", desc: "",
      options: [{ label: "Pequeño", value: "s" }, { label: "Mediano", value: "m" }, { label: "Grande", value: "l" }] },

    { group: "TV en directo" },
    { id: "liveListUrl", type: "text", label: "URL de la lista de canales",
      desc: "Por defecto, la lista JSON de TDTChannels.",
      value: function(){ return S.get("liveListUrl"); },
      after: function(){ App.store.remove("live_cache"); } }
  ];
  APPS.forEach(function(a){
    r.push({ id: "app:" + a.id, type: "appid", app: a, label: "ID de la app " + a.label,
      desc: "Para el acceso directo. Vacío = detectar automáticamente.",
      value: function(){ return appId(a.id) || "Automático"; } });
  });
  r.push(
    { group: "Datos" },
    { id: "clearHistory", type: "action", label: "Borrar historial de “Continuar viendo”",
      desc: "Olvida las posiciones guardadas y lo marcado como visto.",
      run: function(){
        return App.ui.confirm("¿Borrar el historial?", "Se perderán las posiciones guardadas.", "Borrar", "Cancelar").then(function(y){
          if(!y) return;
          if(App.history && App.history.clear) App.history.clear();
          else App.store.remove("history");
          App.bus.emit("history:change");
          App.ui.toast("Historial borrado");
        });
      } },
    { id: "clearMeta", type: "action", label: "Borrar caché de carátulas y metadatos", desc: "",
      run: function(){ if(App.meta && App.meta.clearCache) App.meta.clearCache(); else App.store.remove("metacache"); App.bus.emit("meta:keychange"); App.ui.toast("Caché de metadatos borrada"); } },
    { id: "clearLive", type: "action", label: "Borrar caché de canales de TV", desc: "",
      run: function(){ App.store.remove("live_cache"); App.ui.toast("Caché de canales borrada"); } },
    { id: "logout", type: "action", label: "Cerrar sesión", desc: "Borra la API key de TorBox de esta TV.", danger: true,
      run: function(){
        return App.ui.confirm("¿Cerrar sesión?", "Tendrás que volver a introducir la API key.", "Cerrar sesión", "Cancelar").then(function(y){
          if(!y) return;
          S.set("torboxToken", "");
          App.torbox.invalidate();
          App.openSetup();
        });
      } }
  );
  return r;
}

function valueText(row){
  if(row.value) return row.value();
  if(row.type === "bool") return S.get(row.id) ? "Sí" : "No";
  if(row.type === "menu") return labelOf(row.options, S.get(row.id));
  if(row.type === "action") return "›";
  return String(S.get(row.id) || "");
}

var s = { el: null, grid: null, rows: [] };

function render(){
  var idx = s.grid ? s.grid.index : 0;
  s.rows = rows();
  var html = '<div class="scroll set">';
  s.rows.forEach(function(row, i){
    if(row.group){ html += '<div class="section-title set-group">' + App.esc(row.group) + '</div>'; return; }
    var v = valueText(row);
    html += '<div class="row set-row focusable' + (row.danger ? ' set-danger' : '') + '" data-i="' + i + '">' +
      '<div class="set-text"><div class="set-label">' + App.esc(row.label) + '</div>' +
        (row.desc ? '<div class="set-desc">' + App.esc(row.desc) + '</div>' : '') + '</div>' +
      (row.type === "bool"
        ? '<span class="set-toggle' + (S.get(row.id) ? ' on' : '') + '"><i></i></span>'
        : '<div class="set-value">' + App.esc(v) + '</div>') +
    '</div>';
  });
  html += '<div class="set-footer">' +
    '<div>TorBox para TizenBrew · v' + App.esc(App.version) + '</div>' +
    '<div class="legend"><span><i class="yellow"></i>Buscar</span><span><i class="blue"></i>Ajustes</span>' +
      '<span><i class="red"></i>Restablecer ajuste</span></div>' +
    '</div></div>';
  var sc = s.el.querySelector(".scroll"), top = sc ? sc.scrollTop : 0;
  s.el.innerHTML = html;
  sc = s.el.querySelector(".scroll"); if(sc) sc.scrollTop = top;
  s.grid = new App.ui.FocusGrid(s.el, { onSelect: onSelect });
  s.grid.index = Math.min(idx, s.grid.items.length - 1); s.grid.paint();
  if(document.body.classList.contains("zone-header")) s.grid.blur();
}

function rowAt(el){ return s.rows[Number(el.getAttribute("data-i"))]; }

function edit(row){
  if(row.type === "bool"){ S.set(row.id, !S.get(row.id)); render(); return; }
  if(row.type === "menu"){
    var cur = S.get(row.id);
    App.ui.menu(row.label, row.options.map(function(o){
      return { label: o.label, value: o.value, selected: o.value === cur };
    })).then(function(v){
      if(v === null) return;
      S.set(row.id, v); if(row.after) row.after(); render();
    });
    return;
  }
  if(row.type === "secret" || row.type === "text"){
    App.ui.keyboard.open({
      title: row.label, value: S.get(row.id) || "", secret: row.type === "secret",
      placeholder: row.type === "secret" ? "Pega o escribe la clave" : "",
      onDone: function(v){
        v = String(v || "").trim();
        if(row.id === "torboxToken" && !v){ App.ui.toast("La API key no puede quedar vacía"); return; }
        S.set(row.id, v); if(row.after) row.after(); render();
        App.ui.toast("Guardado");
      }
    });
    return;
  }
  if(row.type === "appid"){
    App.ui.menu(row.label, [
      { label: "Editar ID manualmente", value: "edit" },
      { label: "Detectar automáticamente", value: "auto" },
      { label: "Cancelar", value: null }
    ]).then(function(v){
      if(v === "auto"){ setAppId(row.app.id, ""); render(); App.ui.toast("Se detectará automáticamente"); }
      else if(v === "edit"){
        App.ui.keyboard.open({
          title: "ID de " + row.app.label, value: appId(row.app.id), placeholder: "p. ej. 3201xxxxxxxx",
          onDone: function(val){ setAppId(row.app.id, String(val || "").trim()); render(); }
        });
      }
    });
    return;
  }
  if(row.type === "action"){
    var p = row.run();
    if(p && p.then) p.then(render); else render();
  }
}

function onSelect(i, el){ var row = rowAt(el); if(row) edit(row); }

App.screens.register({
  id: "settings", label: "Ajustes", nav: true, order: 60,
  hint: "OK cambiar · ROJO restablecer · Atrás volver",
  mount: function(el){
    s.el = el;
    App.bus.on("settings:change", function(){ if(App.current() === "settings" && s.grid) render(); });
  },
  show: function(){ render(); },
  focus: function(){ if(s.grid){ s.grid.refresh(); s.grid.focus(s.grid.index, true); } },
  blur: function(){ if(s.grid) s.grid.blur(); },
  onKey: function(k){
    if(k === K.RED){
      var cur = s.grid && s.grid.current(), row = cur && rowAt(cur);
      if(row && RESETTABLE.indexOf(row.id) >= 0){ S.resetKey(row.id); if(row.after) row.after(); render(); App.ui.toast("Restablecido"); }
      else if(row && row.type === "appid"){ setAppId(row.app.id, ""); render(); App.ui.toast("Restablecido"); }
      return true;
    }
    return s.grid ? s.grid.handleKey(k) : false;
  }
});

})();
