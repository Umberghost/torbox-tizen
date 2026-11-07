/* screens/continue.js — "Continuar viendo": lo empezado y no terminado. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

var S = { el: null, grid: null, entries: [], visible: false, busy: false };

function cardHtml(e, i){
  var pct = Math.round(App.history.progress(e.key) * 100);
  var remain = e.dur > 0 ? App.t("continue.left", { time: App.fmtTime(Math.max(0, e.dur - e.pos)) }) : App.fmtTime(e.pos);
  var m = e.meta || {};
  var still = m.imdbId ? "https://images.metahub.space/background/medium/" + m.imdbId + "/img" : (e.poster || "");
  var alt = e.poster && e.poster !== still ? e.poster : "";
  var img = still ? '<img class="lib-img" alt="" src="' + App.esc(still) + '"' + (alt ? ' data-alt="' + App.esc(alt) + '"' : '') +
    " onload=\"this.parentNode.classList.add('has-img')\" onerror=\"var a=this.getAttribute('data-alt');if(a){this.removeAttribute('data-alt');this.src=a}else{this.parentNode.removeChild(this)}\">" : "";
  return '<div class="lib-card hm-wide focusable" data-i="' + i + '">' +
    '<div class="lib-poster hm-still" style="' + App.ui.placeholderStyle(e.title) + '"><span class="lib-initials">' +
      App.esc(App.ui.initials(e.title)) + '</span>' + img + '</div>' +
    '<div class="hm-wide-info"><div class="hm-wide-title">' + App.esc(e.title || App.t("continue.untitled")) + '</div>' +
    '<div class="hm-wide-sub num">' + App.esc(e.subtitle || "") + (e.subtitle ? " · " : "") + remain + '</div>' +
    (pct ? '<div class="hm-bar"><i style="width:' + pct + '%"></i></div>' : '') + '</div></div>';
}

function render(keepIndex){
  if(!S.el) return;
  var idx = S.grid ? S.grid.index : 0;
  S.entries = App.history.list({ unfinished: true });
  if(!S.entries.length){
    S.grid = null;
    App.ui.empty(S.el, App.t("continue.emptyTitle"), App.esc(App.t("continue.emptyText")));
    return;
  }
  S.el.innerHTML =
    '<div class="scroll"><div class="section-title">' + App.esc(App.t("continue.title")) + '<span class="muted">' +
      App.esc(App.t("continue.count", { n: S.entries.length })) + '</span></div>' +
    '<div class="hm-wide-grid">' + S.entries.map(cardHtml).join("") + '</div></div>';
  S.grid = new App.ui.FocusGrid(S.el, { onSelect: function(i){ resume(S.entries[i]); } });
  S.grid.index = keepIndex ? Math.min(idx, S.entries.length - 1) : 0;
  if(document.body.classList.contains("zone-header")) S.grid.blur();
  else S.grid.focus(S.grid.index, true);
}

function resume(e, fromStart){
  if(!e || S.busy) return;
  var m = e.meta || {};
  // Reproducido desde Buscar (add-on de Stremio): volver a pedir la mejor fuente
  if(m.source === "stremio" && m.imdbId && App.search && App.search.playTitle){
    App.ui.toast(App.t("continue.preparing"));
    Promise.resolve(App.search.playTitle({ type: m.type, id: m.imdbId, season: m.season, episode: m.episode,
                                           name: m.title || e.title, poster: e.poster, startAt: fromStart ? 0 : undefined }))
      .catch(function(err){ App.hint(App.t("continue.cantResume", { msg: err.message })); });
    return;
  }
  if(!m.source || m.itemId === undefined || m.fileId === undefined){
    App.hint(App.t("continue.noData"));
    return;
  }
  S.busy = true;
  App.ui.toast(App.t("continue.preparing"));
  App.torbox.link(m.source, m.itemId, m.fileId).then(function(url){
    S.busy = false;
    App.player.play({
      title: e.title, subtitle: e.subtitle, url: url, key: e.key,
      poster: e.poster, meta: m, startAt: fromStart ? 0 : undefined,
      subtitles: m.subtitles || undefined,
      next: (App.library && App.library.nextFor) ? function(){ return App.library.nextFor(e.key, m); } : undefined
    });
  }).catch(function(err){
    S.busy = false;
    App.hint(App.t("continue.cantResume", { msg: err.message }));
  });
}

function removeFocused(){
  if(!S.grid) return;
  var e = S.entries[S.grid.index];
  if(!e) return;
  App.ui.confirm(App.t("continue.removeTitle"), e.title, App.t("continue.remove"), App.t("ui.cancel")).then(function(yes){
    if(yes){ App.history.remove(e.key); App.ui.toast(App.t("continue.removed")); }
  });
}

/* Acciones del menu contextual global (mantener OK): sobre la tarjeta enfocada */
function actions(){
  var e = S.grid ? S.entries[S.grid.index] : null;
  if(!e) return [];
  return [
    { label: App.t("continue.actResume"), run: function(){ resume(e); } },
    { label: App.t("continue.actStart"), run: function(){ resume(e, true); } },
    { label: App.t("continue.actWatched"), run: function(){ App.history.markWatched(e.key); App.ui.toast(App.t("continue.removed")); } },
    { label: App.t("continue.actRemove"), run: removeFocused }
  ];
}

App.bus.on("history:change", function(){
  if(S.visible && !(App.player && App.player.isActive())) render(true);
  else S.dirty = true;
});
App.bus.on("player:close", function(){ if(S.visible && S.dirty){ S.dirty = false; render(true); } });

App.screens.register({
  id: "continue", label: App.t("nav.continue"), nav: true, order: 20,
  get hint(){ return App.t("v2lib.continueHint"); },
  mount: function(el){ S.el = el; },
  show: function(params){ S.visible = true; S.dirty = false; render(!!(params && params._back)); },
  hide: function(){ S.visible = false; },
  focus: function(){ if(S.grid){ S.grid.refresh(false); S.grid.focus(S.grid.index, true); } },
  blur: function(){ if(S.grid) S.grid.blur(); },
  actions: actions,
  onKey: function(k){
    if(k === K.RED){ removeFocused(); return true; }
    if(S.grid) return S.grid.handleKey(k);
    return false;
  }
});

})();
