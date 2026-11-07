/* screens/continue.js — "Continuar viendo": lo empezado y no terminado. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

var S = { el: null, grid: null, entries: [], visible: false, busy: false };

function cardHtml(e, i){
  var pct = Math.round(App.history.progress(e.key) * 100);
  var remain = e.dur > 0 ? "Quedan " + App.fmtTime(Math.max(0, e.dur - e.pos)) : App.fmtTime(e.pos);
  var poster = e.poster
    ? '<div class="cw-poster" style="background-image:url(\'' + App.esc(e.poster) + '\')"></div>'
    : '<div class="cw-poster cw-ph" style="' + App.ui.placeholderStyle(e.title) + '"><span>' +
        App.esc(App.ui.initials(e.title)) + '</span></div>';
  return '<div class="cw-card focusable" data-i="' + i + '">' + poster +
    '<div class="cw-bar progress"><i style="width:' + pct + '%"></i></div>' +
    '<div class="cw-info"><div class="cw-title">' + App.esc(e.title || "(sin título)") + '</div>' +
    '<div class="cw-sub num">' + App.esc(e.subtitle || "") + (e.subtitle ? " · " : "") + remain + '</div></div>' +
    '</div>';
}

function render(keepIndex){
  if(!S.el) return;
  var idx = S.grid ? S.grid.index : 0;
  S.entries = App.history.list({ unfinished: true });
  if(!S.entries.length){
    S.grid = null;
    App.ui.empty(S.el, "Nada a medias",
      "Cuando empieces a ver algo y lo dejes sin terminar aparecerá aquí para retomarlo justo donde lo dejaste.");
    return;
  }
  S.el.innerHTML =
    '<div class="scroll"><div class="section-title">Continuar viendo<span class="muted">' +
      S.entries.length + (S.entries.length === 1 ? " título" : " títulos") + '</span></div>' +
    '<div class="cw-grid">' + S.entries.map(cardHtml).join("") + '</div>' +
    '<div class="legend cw-legend"><span>OK reanudar</span><span><i class="red"></i>Quitar de la lista</span></div></div>';
  S.grid = new App.ui.FocusGrid(S.el, { onSelect: function(i){ resume(S.entries[i]); } });
  S.grid.index = keepIndex ? Math.min(idx, S.entries.length - 1) : 0;
  if(document.body.classList.contains("zone-header")) S.grid.blur();
  else S.grid.focus(S.grid.index, true);
}

function resume(e){
  if(!e || S.busy) return;
  var m = e.meta || {};
  if(!m.source || m.itemId === undefined || m.fileId === undefined){
    App.hint("No se puede reanudar: faltan datos del archivo");
    return;
  }
  S.busy = true;
  App.ui.toast("Preparando reproducción…");
  App.torbox.link(m.source, m.itemId, m.fileId).then(function(url){
    S.busy = false;
    App.player.play({
      title: e.title, subtitle: e.subtitle, url: url, key: e.key,
      poster: e.poster, meta: m,
      subtitles: m.subtitles || undefined,
      next: (App.library && App.library.nextFor) ? function(){ return App.library.nextFor(e.key, m); } : undefined
    });
  }).catch(function(err){
    S.busy = false;
    App.hint("No se pudo obtener el enlace: " + err.message);
  });
}

function removeFocused(){
  if(!S.grid) return;
  var e = S.entries[S.grid.index];
  if(!e) return;
  App.ui.confirm("¿Quitar de Continuar viendo?", e.title, "Quitar", "Cancelar").then(function(yes){
    if(yes) App.history.remove(e.key);
  });
}

App.bus.on("history:change", function(){
  if(S.visible && !(App.player && App.player.isActive())) render(true);
  else S.dirty = true;
});
App.bus.on("player:close", function(){ if(S.visible && S.dirty){ S.dirty = false; render(true); } });

App.screens.register({
  id: "continue", label: "Continuar", nav: true, order: 20,
  hint: "▲▼◄► moverse · OK reanudar · ROJO quitar",
  mount: function(el){ S.el = el; },
  show: function(params){ S.visible = true; S.dirty = false; render(!!(params && params._back)); },
  hide: function(){ S.visible = false; },
  focus: function(){ if(S.grid){ S.grid.refresh(false); S.grid.focus(S.grid.index, true); } },
  blur: function(){ if(S.grid) S.grid.blur(); },
  onKey: function(k){
    if(k === K.RED){ removeFocused(); return true; }
    if(S.grid) return S.grid.handleKey(k);
    if(k === K.UP){ App.focusHeader(); return true; }
    return false;
  }
});

})();
