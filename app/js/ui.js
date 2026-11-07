/* ui.js — navegación espacial con D-pad, modales, menús y toasts. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var ui = App.ui = App.ui || {};

/* ================= Scroll helper ================= */
function scrollIntoViewSmart(el){
  if(!el) return;
  var p = el.parentNode;
  while(p && p !== document.body){
    var cs = window.getComputedStyle(p);
    var oy = cs.overflowY, ox = cs.overflowX;
    var r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight){
      var top = r.top - pr.top + p.scrollTop;
      var target = top - (p.clientHeight - r.height) / 2;
      p.scrollTop = Math.max(0, target);
    }
    if((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth){
      var left = r.left - pr.left + p.scrollLeft;
      var pad = 60;
      if(r.left < pr.left + pad) p.scrollLeft = Math.max(0, left - pad);
      else if(r.right > pr.right - pad) p.scrollLeft = left + r.width - p.clientWidth + pad;
    }
    p = p.parentNode;
  }
}
ui.scrollIntoView = scrollIntoViewSmart;

/* ================= FocusGrid (navegación espacial) =================
 * Gestiona el foco entre los elementos .focusable de un contenedor usando su
 * posición en pantalla, así sirve igual para listas, rejillas o filas mixtas.
 */
function FocusGrid(container, opts){
  this.container = container;
  this.opts = opts || {};
  this.items = [];
  this.index = 0;
  this.refresh();
}
FocusGrid.prototype.refresh = function(keepIndex){
  this.items = Array.prototype.slice.call(this.container.querySelectorAll(".focusable"))
    .filter(function(el){ return el.offsetParent !== null || el.getClientRects().length; });
  if(this.index >= this.items.length) this.index = Math.max(0, this.items.length - 1);
  if(keepIndex !== false) this.paint();
  return this;
};
FocusGrid.prototype.paint = function(){
  var self = this;
  this.items.forEach(function(el, i){ el.classList.toggle("focused", i === self.index); });
};
FocusGrid.prototype.focus = function(i, silent){
  if(!this.items.length) return;
  this.index = Math.max(0, Math.min(i, this.items.length - 1));
  this.paint();
  var el = this.items[this.index];
  scrollIntoViewSmart(el);
  if(!silent && this.opts.onFocus) this.opts.onFocus(this.index, el);
};
FocusGrid.prototype.blur = function(){
  this.items.forEach(function(el){ el.classList.remove("focused"); });
};
FocusGrid.prototype.current = function(){ return this.items[this.index] || null; };

FocusGrid.prototype.move = function(dir){
  var cur = this.items[this.index];
  if(!cur) return false;
  var a = cur.getBoundingClientRect();
  var ax = a.left + a.width/2, ay = a.top + a.height/2;
  var best = -1, bestScore = Infinity;
  for(var i = 0; i < this.items.length; i++){
    if(i === this.index) continue;
    var b = this.items[i].getBoundingClientRect();
    var bx = b.left + b.width/2, by = b.top + b.height/2;
    var dx = bx - ax, dy = by - ay, primary, secondary;
    if(dir === "up"){ if(b.bottom > a.top + 2) continue; primary = -dy; secondary = Math.abs(dx); }
    else if(dir === "down"){ if(b.top < a.bottom - 2) continue; primary = dy; secondary = Math.abs(dx); }
    else if(dir === "left"){ if(b.right > a.left + 2) continue; primary = -dx; secondary = Math.abs(dy); }
    else { if(b.left < a.right - 2) continue; primary = dx; secondary = Math.abs(dy); }
    var score = primary + secondary * 2.5;
    if(score < bestScore){ bestScore = score; best = i; }
  }
  if(best >= 0){ this.focus(best); return true; }
  return false;
};

FocusGrid.prototype.handleKey = function(k){
  var dir = k === K.UP ? "up" : k === K.DOWN ? "down" : k === K.LEFT ? "left" : k === K.RIGHT ? "right" : null;
  if(dir){
    if(!this.items.length){ if(dir === "up"){ App.focusHeader(); return true; } return false; }
    if(this.move(dir)) return true;
    if(this.opts.onEdge){ var r = this.opts.onEdge(dir); if(r !== undefined) return !!r; }
    if(dir === "up"){ App.focusHeader(); return true; }
    return true; // tragar flechas en los bordes
  }
  if(k === K.OK){
    var el = this.items[this.index];
    if(el && this.opts.onSelect){ this.opts.onSelect(this.index, el); return true; }
  }
  return false;
};
ui.FocusGrid = FocusGrid;

/* ================= Modales ================= */
var stack = [];

function closeTop(value){
  var m = stack.pop(); if(!m) return;
  if(m.el.parentNode) m.el.parentNode.removeChild(m.el);
  if(m.onClose) m.onClose(value);
}

/* opts: {title, html, buttons:[{label,value}], vertical, onClose(value), onKey(k)} */
ui.modal = function(opts){
  var el = document.createElement("div");
  el.className = "modal-backdrop";
  var btns = (opts.buttons || [{label:"Aceptar", value:true}]).map(function(b, i){
    return '<div class="btn focusable" data-i="'+i+'">'+App.esc(b.label)+'</div>';
  }).join("");
  el.innerHTML =
    '<div class="modal'+(opts.vertical?' vertical':'')+(opts.wide?' wide':'')+'">'+
      (opts.title ? '<h2>'+App.esc(opts.title)+'</h2>' : '')+
      (opts.html ? '<div class="modal-body">'+opts.html+'</div>' : '')+
      '<div class="modal-buttons">'+btns+'</div>'+
    '</div>';
  document.body.appendChild(el);
  var grid = new FocusGrid(el.querySelector(".modal-buttons"), {
    onEdge: function(){ return true; },
    onSelect: function(i){ closeTop((opts.buttons || [{value:true}])[i].value); }
  });
  var start = 0;
  (opts.buttons || []).forEach(function(b, i){ if(b.selected) start = i; });
  grid.focus(start, true);
  var m = { el: el, grid: grid, onClose: opts.onClose, onKey: opts.onKey, cancelValue: opts.cancelValue };
  stack.push(m);
  return { close: function(v){ if(stack[stack.length-1] === m) closeTop(v); }, el: el };
};

ui.isModalOpen = function(){ return stack.length > 0; };

/* main.js llama a esto cuando hay modal abierto */
ui.modalKey = function(k, e){
  var m = stack[stack.length-1]; if(!m) return false;
  if(m.onKey && m.onKey(k, e)) return true;
  if(App.isBack(k)){ closeTop(m.cancelValue === undefined ? null : m.cancelValue); return true; }
  m.grid.handleKey(k);
  return true;
};

ui.confirm = function(title, text, yes, no){
  return new Promise(function(resolve){
    ui.modal({
      title: title, html: text ? '<p>'+App.esc(text)+'</p>' : "",
      buttons: [{label: yes || "Sí", value: true}, {label: no || "No", value: false}],
      cancelValue: false, onClose: function(v){ resolve(!!v); }
    });
  });
};

/* items: [{label, value, selected, hint}] → Promise<value|null> */
ui.menu = function(title, items){
  return new Promise(function(resolve){
    ui.modal({
      title: title, vertical: true,
      buttons: items.map(function(it){
        return { label: (it.selected ? "● " : "") + it.label, value: it.value, selected: it.selected };
      }),
      cancelValue: null, onClose: function(v){ resolve(v === undefined ? null : v); }
    });
  });
};

/* ================= Toast ================= */
var toastEl, toastTimer;
ui.toast = function(msg, ms){
  if(!toastEl){
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastEl.classList.remove("on"); }, ms || 3000);
};

/* ================= Estados de pantalla ================= */
ui.loading = function(el, msg){
  el.innerHTML = '<div class="center"><div class="spinner"></div><p>'+App.esc(msg || "Cargando…")+'</p></div>';
};
ui.error = function(el, title, msg){
  el.innerHTML = '<div class="center err"><h2>'+App.esc(title)+'</h2><p>'+App.esc(msg || "")+'</p></div>';
};
ui.empty = function(el, title, msg){
  el.innerHTML = '<div class="center"><h2>'+App.esc(title)+'</h2><p>'+(msg || "")+'</p></div>';
};

/* Placeholder de carátula: iniciales sobre color estable derivado del título */
ui.placeholderStyle = function(title){
  var h = 0, s = String(title || "?");
  for(var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return "background:linear-gradient(135deg,hsl("+h+",45%,28%),hsl("+((h+40)%360)+",50%,16%))";
};
ui.initials = function(title){
  var w = String(title || "?").replace(/[^\wÀ-ÿ ]/g, " ").trim().split(/\s+/);
  return ((w[0] || "?").charAt(0) + (w[1] ? w[1].charAt(0) : "")).toUpperCase();
};

})();
