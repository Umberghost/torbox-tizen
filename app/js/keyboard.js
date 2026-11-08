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
  if(!st || st.native) return;   // en el diálogo nativo el <input> recibe el pegado solo
  var txt = ev.clipboardData ? ev.clipboardData.getData("text") : "";
  if(txt){ ev.preventDefault(); st.physical = true; insertText(txt); }
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

/* ---- PC / móvil: diálogo compacto con un <input> nativo (teclado del móvil, pegar, autocompletar) ---- */
function openNative(opts){
  st = {
    native: true, value: String(opts.value || ""), secret: !!opts.secret, max: opts.max || 0,
    onDone: opts.onDone, onCancel: opts.onCancel
  };
  el = document.createElement("div");
  el.className = "kb-backdrop kb-native";
  el.innerHTML = '<form class="kb-panel kb-nat-panel" autocomplete="off">' +
    (opts.title ? '<div class="kb-title">' + App.esc(opts.title) + '</div>' : '') +
    '<div class="kb-nat-field"><input class="kb-nat-input" type="' + (st.secret ? "password" : "text") + '" enterkeyhint="done"' +
      ' autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"' +
      (st.max ? ' maxlength="' + st.max + '"' : '') +
      ' placeholder="' + App.esc(opts.placeholder || "") + '">' +
    (st.secret ? '<button type="button" class="kb-nat-eye">' + App.esc(t("keyboard.show")) + '</button>' : '') +
    '</div>' +
    '<div class="kb-nat-btns"><button type="button" class="kb-nat-cancel">' + App.esc(t("ui.cancel")) + '</button>' +
    '<button type="submit" class="kb-nat-done">✓ ' + App.esc(t("keyboard.done")) + '</button></div></form>';
  document.body.appendChild(el);
  var inp = el.querySelector(".kb-nat-input");
  inp.value = st.value;
  var cur = st;
  el.addEventListener("mousedown", function(ev){ if(ev.target === el) ev.preventDefault(); });
  el.addEventListener("click", function(ev){ if(ev.target === el && st === cur) finish(false); });
  inp.addEventListener("keydown", function(ev){
    if(ev.key === "Escape"){ ev.preventDefault(); ev.stopPropagation(); if(st === cur) finish(false); }
    else if(ev.key === "Enter"){ ev.preventDefault(); ev.stopPropagation(); if(st === cur){ cur.value = inp.value; finish(true); } }
  });
  el.querySelector("form").addEventListener("submit", function(ev){
    ev.preventDefault();
    if(st === cur){ cur.value = inp.value; finish(true); }
  });
  el.querySelector(".kb-nat-cancel").addEventListener("click", function(){ if(st === cur) finish(false); });
  var eye = el.querySelector(".kb-nat-eye");
  if(eye) eye.addEventListener("click", function(){
    var show = inp.type === "password";
    inp.type = show ? "text" : "password";
    eye.textContent = t(show ? "keyboard.hide" : "keyboard.show");
    inp.focus();
  });
  setTimeout(function(){ try{ inp.focus(); inp.select(); }catch(e){} }, 30);
}

App.ui = App.ui || {};
App.ui.keyboard = {
  /* opts: {title, value, placeholder, secret, max, onDone(value), onCancel()} */
  open: function(opts){
    opts = opts || {};
    if(st) finish(false);
    if(!App.isTizen()){ openNative(opts); return; }
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
    if(st.native){
      // el <input> recibe las teclas; solo Esc/Atrás cancelan (Intro lo gestiona el propio campo)
      if(k === K.BACK || k === K.BACK_LG || k === K.ESC){ finish(false); return true; }
      return false;
    }
    // Atrás del mando / Escape → cancelar
    if(k === K.BACK || k === K.BACK_LG || k === K.ESC){ finish(false); return true; }
    // Backspace físico → borrar
    if(k === K.BACKSPACE){ st.physical = true; st.value = st.value.slice(0, -1); paintValue(); return true; }
    /* Intro con teclado físico: si se ha escrito con él (o es Intro del teclado numérico), confirma.
     * Con el mando, OK sigue pulsando la tecla enfocada del teclado en pantalla. */
    if(k === K.OK && (st.physical || (e && e.code === "NumpadEnter"))){ finish(true); return true; }
    if(k === K.UP || k === K.DOWN || k === K.LEFT || k === K.RIGHT){
      st.physical = false;   // vuelve a manejarse con flechas: OK = tecla enfocada
      st.grid.handleKey(k); return true;
    }
    if(k === K.OK){ st.grid.handleKey(k); return true; }
    // Botones de color: VERDE = hecho, ROJO = borrar
    if(k === K.GREEN){ finish(true); return true; }
    if(k === K.RED){ st.value = st.value.slice(0, -1); paintValue(); return true; }
    // Ctrl/Cmd+V: no la gestionamos para que el navegador lance el evento "paste"
    if(e && (e.ctrlKey || e.metaKey) && (k === 86 || String(e.key).toLowerCase() === "v")) return false;
    // Números del mando / teclado físico
    var d = App.digit(k);
    var key = e && e.key;
    if(key && key.length === 1 && !(e.ctrlKey || e.metaKey || e.altKey)){ st.physical = true; insert(key); return true; }
    if(d >= 0){ insert(String(d)); return true; }
    return true;
  }
};

})();
