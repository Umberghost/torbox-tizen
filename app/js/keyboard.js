/* keyboard.js — teclado en pantalla navegable con D-pad (App.ui.keyboard). */
(function(){
"use strict";

var App = window.App;
var K = App.K;

/* Distribución según el idioma de la interfaz: es/gl/eu con ñ, ca/pt con ç, fr AZERTY; en sin ñ.
   Los acentos van en la capa de símbolos (#?!). */
var LAYOUTS_BY_LANG = {
  es: {
    lower: ["1234567890", "qwertyuiop", "asdfghjklñ", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKLÑ", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#€$%&*()_", "!?¿¡:;\"'/\\", "+=<>[]{}|~"]
  },
  en: {
    lower: ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKL\"", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#$%&*()_£", "!?:;\"'/\\`^", "+=<>[]{}|~"]
  },
  ca: {
    lower: ["1234567890", "qwertyuiop", "asdfghjklç", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKLÇ", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#€$%&*()_", "àèéíòóúïü·", "!?:;\"'/+=-"]
  },
  gl: {
    lower: ["1234567890", "qwertyuiop", "asdfghjklñ", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKLÑ", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#€$%&*()_", "áéíóúü¿¡:;", "!?\"'/+=-_~"]
  },
  eu: {
    lower: ["1234567890", "qwertyuiop", "asdfghjklñ", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKLÑ", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#€$%&*()_", "áéíóúüç¿¡:", "!?\"'/+=-_~"]
  },
  pt: {
    lower: ["1234567890", "qwertyuiop", "asdfghjklç", "zxcvbnm,.-"],
    upper: ["1234567890", "QWERTYUIOP", "ASDFGHJKLÇ", "ZXCVBNM;:_"],
    sym:   ["1234567890", "@#€$%&*()_", "ãõáàâéêíóú", "!?:;\"'/+=-"]
  },
  fr: {
    lower: ["1234567890", "azertyuiop", "qsdfghjklm", "wxcvbn,.-é"],
    upper: ["1234567890", "AZERTYUIOP", "QSDFGHJKLM", "WXCVBN;:_É"],
    sym:   ["1234567890", "@#€$%&*()_", "èàçùêâîôûœ", "!?:;\"'/+=-"]
  }
};
function layouts(){ return LAYOUTS_BY_LANG[App.i18n.lang()] || LAYOUTS_BY_LANG.en; }
var t = App.t;

var st = null;   // estado del teclado abierto
var el = null;   // overlay

function render(){
  var rows = layouts()[st.mode];
  var html = '<div class="kb-panel">' +
    (st.title ? '<div class="kb-title">' + App.esc(st.title) + '</div>' : '') +
    '<div class="kb-display' + (st.value ? '' : ' empty') + '"><span class="kb-text"></span><i class="kb-caret"></i></div>' +
    '<div class="kb-keys">';
  rows.forEach(function(r){
    html += '<div class="kb-row">';
    for(var i = 0; i < r.length; i++){
      var c = r.charAt(i);
      html += '<div class="kb-key focusable" data-c="' + App.esc(c) + '">' + App.esc(c) + '</div>';
    }
    html += '</div>';
  });
  html += '<div class="kb-row kb-actions">' +
    '<div class="kb-key kb-wide focusable" data-a="shift">' + App.esc(st.mode === "upper" ? t("keyboard.lower") : t("keyboard.upper")) + '</div>' +
    '<div class="kb-key kb-wide focusable" data-a="sym">' + (st.mode === "sym" ? "abc" : "#?!") + '</div>' +
    '<div class="kb-key kb-space focusable" data-a="space">' + App.esc(t("keyboard.space")) + '</div>' +
    '<div class="kb-key kb-wide focusable" data-a="del">⌫ ' + App.esc(t("keyboard.delete")) + '</div>' +
    '<div class="kb-key kb-wide focusable" data-a="clear">' + App.esc(t("keyboard.clear")) + '</div>' +
    (canPaste() ? '<div class="kb-key kb-wide focusable" data-a="paste">' + App.esc(t("keyboard.paste")) + '</div>' : '') +
    (st.secret ? '<div class="kb-key kb-wide focusable" data-a="reveal">' + App.esc(st.reveal ? t("keyboard.hide") : t("keyboard.show")) + '</div>' : '') +
    '<div class="kb-key kb-done focusable" data-a="done">✓ ' + App.esc(t("keyboard.done")) + '</div>' +
    '</div></div>' +
    '<div class="kb-help">' + App.esc(t("keyboard.help")) + '</div>' +
    '</div>';
  el.innerHTML = html;
  st.grid = new App.ui.FocusGrid(el.querySelector(".kb-keys"), {
    onEdge: function(){ return true; },
    onSelect: function(i, keyEl){ press(keyEl); }
  });
  st.grid.focus(Math.min(st.focusIndex || 0, st.grid.items.length - 1), true);
  paintValue();
}

function paintValue(){
  var txt = el.querySelector(".kb-text");
  var shown = st.secret && !st.reveal ? st.value.replace(/./g, "•") : st.value;
  txt.textContent = shown || st.placeholder || "";
  el.querySelector(".kb-display").classList.toggle("empty", !st.value);
}

/* Pegar: Ctrl/Cmd+V (evento paste del navegador) o botón "Pegar" (API del portapapeles) */
function canPaste(){ return !!(navigator.clipboard && navigator.clipboard.readText); }
function insertText(txt){
  if(!st) return;
  txt = String(txt || "").replace(/\s+/g, " ").trim();
  if(!txt) return;
  if(st.max) txt = txt.slice(0, Math.max(0, st.max - st.value.length));
  st.value += txt;
  paintValue();
}
function pasteFromClipboard(){
  navigator.clipboard.readText().then(insertText).catch(function(){
    if(App.ui.toast) App.ui.toast(t("keyboard.pasteFail"), 4000);
  });
}
document.addEventListener("paste", function(ev){
  if(!st) return;
  var txt = ev.clipboardData ? ev.clipboardData.getData("text") : "";
  if(txt){ ev.preventDefault(); insertText(txt); }
});

function insert(ch){
  if(st.max && st.value.length >= st.max) return;
  st.value += ch;
  if(st.mode === "upper" && st.autoLower){ st.mode = "lower"; st.autoLower = false; rerender(); return; }
  paintValue();
}
function rerender(){
  st.focusIndex = st.grid ? st.grid.index : 0;
  render();
}

function press(keyEl){
  var c = keyEl.getAttribute("data-c");
  if(c !== null){ insert(c); return; }
  var a = keyEl.getAttribute("data-a");
  if(a === "space") insert(" ");
  else if(a === "del"){ st.value = st.value.slice(0, -1); paintValue(); }
  else if(a === "clear"){ st.value = ""; paintValue(); }
  else if(a === "shift"){ st.mode = st.mode === "upper" ? "lower" : "upper"; st.autoLower = st.mode === "upper"; rerender(); }
  else if(a === "sym"){ st.mode = st.mode === "sym" ? "lower" : "sym"; st.autoLower = false; rerender(); }
  else if(a === "reveal"){ st.reveal = !st.reveal; rerender(); }
  else if(a === "paste") pasteFromClipboard();
  else if(a === "done") finish(true);
}

function finish(ok){
  var s = st; st = null;
  if(el && el.parentNode) el.parentNode.removeChild(el);
  el = null;
  try{
    if(ok){ if(s.onDone) s.onDone(s.value); }
    else if(s.onCancel) s.onCancel();
  }catch(e){ console.error("[keyboard]", e); }
}

App.ui = App.ui || {};
App.ui.keyboard = {
  /* opts: {title, value, placeholder, secret, max, onDone(value), onCancel()} */
  open: function(opts){
    opts = opts || {};
    if(st) finish(false);
    st = {
      title: opts.title || "", value: String(opts.value || ""), placeholder: opts.placeholder || "",
      secret: !!opts.secret, reveal: false, max: opts.max || 0,
      onDone: opts.onDone, onCancel: opts.onCancel, mode: "lower", focusIndex: 0
    };
    el = document.createElement("div");
    el.className = "kb-backdrop";
    document.body.appendChild(el);
    render();
    // empezar en "Hecho" si ya hay texto (editar = confirmar rápido)
    if(st.value){
      var done = el.querySelector('[data-a="done"]');
      st.grid.focus(st.grid.items.indexOf(done), true);
    }
  },
  isOpen: function(){ return !!st; },
  close: function(){ if(st) finish(false); },
  onKey: function(k, e){
    if(!st) return false;
    // Atrás del mando / Escape → cancelar
    if(k === K.BACK || k === K.BACK_LG || k === K.ESC){ finish(false); return true; }
    // Backspace físico → borrar
    if(k === K.BACKSPACE){ st.value = st.value.slice(0, -1); paintValue(); return true; }
    if(k === K.UP || k === K.DOWN || k === K.LEFT || k === K.RIGHT || k === K.OK){
      st.grid.handleKey(k); return true;
    }
    // Botones de color: VERDE = hecho, ROJO = borrar
    if(k === K.GREEN){ finish(true); return true; }
    if(k === K.RED){ st.value = st.value.slice(0, -1); paintValue(); return true; }
    // Ctrl/Cmd+V: no la gestionamos para que el navegador lance el evento "paste"
    if(e && (e.ctrlKey || e.metaKey) && (k === 86 || String(e.key).toLowerCase() === "v")) return false;
    // Números del mando / teclado físico
    var d = App.digit(k);
    var key = e && e.key;
    if(key && key.length === 1 && !(e.ctrlKey || e.metaKey || e.altKey)){ insert(key); return true; }
    if(d >= 0){ insert(String(d)); return true; }
    return true;
  }
};

})();
