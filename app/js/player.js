/* player.js — reproductor con dos motores (AVPlay nativo de Tizen y <video> HTML5),
 * OSD, continuar viendo, siguiente episodio, pistas de audio y subtítulos. */
(function(){
"use strict";

var App = window.App;
var K = App.K;

/* ================= Utilidades de idioma ================= */
var LANG2TO3 = { es:"spa", en:"eng", fr:"fre", de:"ger", it:"ita", pt:"por", ca:"cat",
  eu:"baq", gl:"glg", ja:"jpn", ko:"kor", zh:"chi", ru:"rus", nl:"dut", pl:"pol" };
var LANG_ALIASES = { fra:"fre", deu:"ger", esl:"spa", es:"spa", cas:"spa", spn:"spa", ea:"spa",
  nld:"dut", zho:"chi", eus:"baq" };

function normLang(l){
  l = String(l || "").toLowerCase().replace(/_/g, "-").split("-")[0];
  if(!l) return "und";
  if(LANG2TO3[l]) return LANG2TO3[l];
  if(LANG_ALIASES[l]) return LANG_ALIASES[l];
  return l;
}
function langName(l){
  var n = normLang(l), k = "player.lang." + n, t = App.t(k);
  return t === k ? n.toUpperCase() : t;
}

function isHls(url){ return /\.m3u8(\?|#|$)/i.test(String(url || "")); }

/* ================= Parser de subtítulos SRT/VTT ================= */
function parseTime(t){
  var m = String(t).trim().replace(",", ".").match(/(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/);
  if(!m) return 0;
  var ms = m[4] ? Number((m[4] + "00").slice(0, 3)) : 0;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}
function parseSubs(text){
  text = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  var blocks = text.split(/\n\s*\n/), cues = [];
  blocks.forEach(function(b){
    var lines = b.split("\n").filter(function(l){ return l.trim() !== ""; });
    for(var i = 0; i < lines.length; i++){
      if(lines[i].indexOf("-->") >= 0){
        var p = lines[i].split("-->");
        var body = lines.slice(i + 1).join("\n");
        if(body) cues.push({ s: parseTime(p[0]), e: parseTime(p[1].trim().split(/\s+/)[0]), text: body });
        break;
      }
    }
  });
  cues.sort(function(a, b){ return a.s - b.s; });
  return cues;
}
/* Escapa y conserva <i>/<b>/<u> básicos; quita estilos ASS {\...} */
function subHtml(t){
  var s = App.esc(String(t || "").replace(/\{\\[^}]*\}/g, ""));
  s = s.replace(/&lt;(\/?)(i|b|u)&gt;/gi, "<$1$2>").replace(/&lt;[^&]*?&gt;/g, "");
  return s.replace(/\\N/g, "<br>").replace(/\n/g, "<br>");
}

/* ================= Estado ================= */
var root, els = {};
var P = {
  active: false,
  opts: null,
  engine: null,          // objeto motor
  engineName: null,      // "avplay" | "video"
  started: false,        // ya empezó a reproducir alguna vez
  paused: false,
  buffering: false,
  ended: false,
  dur: 0,
  // subtítulos
  sub: { kind: "off", index: -1 },   // off | ext | emb
  extCues: [],
  extCache: {},
  embTimer: null,
  // timers
  tick: null, saveT: null, osdT: null,
  seekTarget: null, seekT: null,
  countdown: null,
  lastSaved: 0
};

function hasAvplay(){
  try{ return !!(window.webapis && webapis.avplay && typeof webapis.avplay.open === "function"); }
  catch(e){ return false; }
}

/* ================= DOM ================= */
function build(){
  if(root) return;
  root = document.getElementById("player");
  if(!root){ root = document.createElement("div"); root.id = "player"; document.body.appendChild(root); }
  root.innerHTML =
    '<object id="plAv" class="pl-av" type="application/avplayer"></object>' +
    '<video id="plVideo" class="pl-video" preload="auto" playsinline></video>' +
    '<div class="pl-sub" id="plSub"><span></span></div>' +
    '<div class="pl-spinner" id="plSpin"><div class="spinner"></div><span id="plBuf"></span></div>' +
    '<div class="pl-pause" id="plPause"><i></i><i></i></div>' +
    '<div class="pl-seek num" id="plSeek"></div>' +
    '<div class="pl-osd" id="plOsd">' +
      '<div class="pl-top"><span class="pl-live" id="plLive">' + App.esc(App.t("player.live")) + '</span>' +
        '<div class="pl-titles"><div class="pl-title" id="plTitle"></div><div class="pl-subtitle" id="plSubtitle"></div></div>' +
        '<div class="pl-engine" id="plEngine"></div></div>' +
      '<div class="pl-progress" id="plProg"><div class="pl-bar"><i id="plFill"></i><b id="plHead"></b></div>' +
        '<div class="pl-times num"><span id="plCur">0:00</span><span id="plRemain"></span><span id="plDur">0:00</span></div></div>' +
      '<div class="pl-keys legend"><span><i class="red"></i>' + App.esc(App.t("player.keyAudio")) + '</span>' +
        '<span><i class="green"></i>' + App.esc(App.t("player.keySubs")) + '</span>' +
        '<span>' + App.esc(App.t("player.keyTracks")) + '</span><span id="plNextHint">' + App.esc(App.t("player.keyNext")) + '</span></div>' +
    '</div>' +
    '<div class="pl-countdown" id="plCount"></div>' +
    '<div class="pl-error" id="plErr"></div>';
  ["plAv","plVideo","plSub","plSpin","plBuf","plPause","plSeek","plOsd","plLive","plTitle","plSubtitle",
   "plEngine","plProg","plFill","plHead","plCur","plRemain","plDur","plNextHint","plCount","plErr"]
    .forEach(function(id){ els[id] = document.getElementById(id); });
  els.subSpan = els.plSub.querySelector("span");
}

function setClass(on, cls, el){ (el || root).classList.toggle(cls, !!on); }

function showOsd(ms){
  if(!root) return;
  els.plOsd.classList.remove("hide");
  root.classList.add("osd-on");
  clearTimeout(P.osdT);
  if(!P.paused || (P.opts && P.opts.live)){
    P.osdT = setTimeout(hideOsd, ms || 4000);
  }
}
function hideOsd(){ if(root){ clearTimeout(P.osdT); els.plOsd.classList.add("hide"); root.classList.remove("osd-on"); } }

function setBuffering(on, pct){
  P.buffering = !!on;
  setClass(on, "on", els.plSpin);
  els.plBuf.textContent = on && pct ? pct + " %" : "";
}

function setPaused(p){
  P.paused = !!p;
  setClass(P.paused, "on", els.plPause);
  if(P.paused){ showOsd(); saveNow(); }
  else showOsd();
}

function applySubSize(){
  var s = App.settings.get("subSize") || "m";
  els.plSub.className = "pl-sub size-" + s;
}

function showSubText(html){
  els.subSpan.innerHTML = html || "";
  setClass(!!html, "has", els.plSub);
}

/* ================= Motor AVPlay ================= */
function AvplayEngine(handlers){
  this.h = handlers;
  this.av = webapis.avplay;
}
AvplayEngine.prototype.name = "avplay";
AvplayEngine.prototype.open = function(url, startAt){
  var self = this, av = this.av, h = this.h;
  return new Promise(function(resolve, reject){
    try{
      try{ var st = av.getState(); if(st !== "NONE"){ av.stop(); av.close(); } }catch(e){}
      av.open(url);
      var w = window.innerWidth || 1920, hh = window.innerHeight || 1080;
      var f = 1920 / w;    // AVPlay trabaja en coordenadas de 1920x1080
      av.setDisplayRect(0, 0, Math.round(w * f), Math.round(hh * f));
      try{ av.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); }catch(e){}
      av.setListener({
        onbufferingstart: function(){ h.buffering(true, 0); },
        onbufferingprogress: function(p){ h.buffering(true, p); },
        onbufferingcomplete: function(){ h.buffering(false); },
        oncurrentplaytime: function(){ /* el tick de 250 ms ya lo consulta */ },
        onstreamcompleted: function(){ h.ended(); },
        onerror: function(type){ h.error(avplayErrorText(type), String(type)); },
        onevent: function(type, data){ console.log("[avplay] evento", type, data); },
        onsubtitlechange: function(duration, text){ h.embSub(text, Number(duration) || 3000); },
        ondrmevent: function(){}
      });
      av.prepareAsync(function(){
        try{
          if(startAt > 0) av.seekTo(Math.floor(startAt * 1000));
          av.play();
          resolve();
        }catch(e){ reject(e); }
      }, function(err){
        var e2 = new Error(avplayErrorText(err));
        e2.code = String(err && err.name ? err.name : err);
        reject(e2);
      });
    }catch(e){ reject(e); }
  });
};
AvplayEngine.prototype.play = function(){ try{ this.av.play(); }catch(e){} };
AvplayEngine.prototype.pause = function(){ try{ this.av.pause(); }catch(e){} };
AvplayEngine.prototype.seek = function(sec){
  var h = this.h;
  try{
    h.buffering(true, 0);
    this.av.seekTo(Math.max(0, Math.floor(sec * 1000)),
      function(){ h.buffering(false); },
      function(){ h.buffering(false); App.hint(App.t("player.err.seek")); });
  }catch(e){ h.buffering(false); }
};
AvplayEngine.prototype.time = function(){ try{ return this.av.getCurrentTime() / 1000; }catch(e){ return 0; } };
AvplayEngine.prototype.duration = function(){ try{ return this.av.getDuration() / 1000; }catch(e){ return 0; } };
AvplayEngine.prototype.state = function(){ try{ return this.av.getState(); }catch(e){ return "NONE"; } };
AvplayEngine.prototype.tracks = function(){
  var out = { audio: [], text: [] }, info;
  try{ info = this.av.getTotalTrackInfo() || []; }catch(e){ info = []; }
  var cur = {};
  try{
    (this.av.getCurrentStreamInfo() || []).forEach(function(s){ cur[s.type] = Number(s.index); });
  }catch(e){}
  for(var i = 0; i < info.length; i++){
    var t = info[i], ex = {};
    try{ ex = typeof t.extra_info === "string" ? JSON.parse(t.extra_info) : (t.extra_info || {}); }catch(e){}
    var lang = ex.language || ex.track_lang || ex.lang || "";
    var idx = Number(t.index);
    if(t.type === "AUDIO"){
      var ch = ex.channels ? " · " + ex.channels + "ch" : "";
      var codec = ex.fourCC ? " · " + String(ex.fourCC).toUpperCase() : "";
      out.audio.push({ index: idx, lang: normLang(lang), label: langName(lang) + codec + ch, current: cur.AUDIO === idx });
    } else if(t.type === "TEXT"){
      out.text.push({ index: idx, lang: normLang(lang), label: langName(lang) + (ex.subtitle_type ? " · " + ex.subtitle_type : "") });
    }
  }
  return out;
};
AvplayEngine.prototype.selectAudio = function(i){
  try{ this.av.setSelectTrack("AUDIO", i); return true; }catch(e){ return false; }
};
AvplayEngine.prototype.selectText = function(i){
  try{
    if(i < 0){ this.av.setSilentSubtitle(true); return true; }
    this.av.setSelectTrack("TEXT", i);
    this.av.setSilentSubtitle(false);
    return true;
  }catch(e){ return false; }
};
AvplayEngine.prototype.suspend = function(){ try{ this.av.suspend(); }catch(e){} };
AvplayEngine.prototype.restore = function(){ try{ this.av.restore(); }catch(e){} };
AvplayEngine.prototype.close = function(){
  try{ this.av.stop(); }catch(e){}
  try{ this.av.close(); }catch(e){}
};

function avplayErrorText(type){
  var t = String(type || "");
  if(/NOT_SUPPORTED|UNSUPPORTED|CODEC/i.test(t)) return App.t("player.err.unsupported");
  if(/CONNECTION|NETWORK|TIMEOUT/i.test(t)) return App.t("player.err.network");
  if(/INVALID_URI/i.test(t)) return App.t("player.err.invalidUri");
  if(/SEEK/i.test(t)) return App.t("player.err.seek");
  if(/DRM/i.test(t)) return App.t("player.err.drm");
  return App.t("player.err.avplay", { code: t ? " (" + t + ")" : "" });
}

/* ================= Motor <video> ================= */
function VideoEngine(handlers){
  this.h = handlers;
  this.v = els.plVideo;
  this.hls = null;
  this._bound = false;
}
VideoEngine.prototype.name = "video";
VideoEngine.prototype.bind = function(){
  if(this._bound) return;
  this._bound = true;
  var self = this, v = this.v;
  this._on = {
    waiting: function(){ self.h.buffering(true); },
    playing: function(){ self.h.buffering(false); },
    canplay: function(){ self.h.buffering(false); },
    ended: function(){ self.h.ended(); },
    error: function(){
      if(!v.getAttribute("src") && !self.hls) return;
      var c = v.error ? v.error.code : 0;
      if(self._openFail && !self._opened){
        var m0 = c === 2 ? App.t("player.err.network") : c === 3 ? App.t("player.err.decode") :
                 c === 4 ? App.t("player.err.browserFormat") : App.t("player.err.generic");
        self._openFail(m0, "MEDIA_ERR_" + c); return;
      }
      var msg = c === 2 ? App.t("player.err.network") :
                c === 3 ? App.t("player.err.decode") :
                c === 4 ? App.t("player.err.browserFormat") :
                App.t("player.err.generic");
      self.h.error(msg, "MEDIA_ERR_" + c);
    }
  };
  Object.keys(this._on).forEach(function(ev){ v.addEventListener(ev, self._on[ev]); });
};
VideoEngine.prototype.unbind = function(){
  if(!this._bound) return;
  var self = this;
  Object.keys(this._on).forEach(function(ev){ self.v.removeEventListener(ev, self._on[ev]); });
  this._bound = false;
};
VideoEngine.prototype.open = function(url, startAt){
  var self = this, v = this.v;
  this._opened = false; this._openFail = null;
  this.bind();
  return new Promise(function(resolve, reject){
    var done = false;
    function ok(){
      if(done) return; done = true; self._opened = true;
      v.removeEventListener("loadedmetadata", ok);
      try{ if(startAt > 0) v.currentTime = startAt; }catch(e){}
      var p = v.play();
      if(p && p.catch) p.catch(function(){});
      resolve();
    }
    function fail(e){
      if(done) return; done = true;
      reject(e instanceof Error ? e : new Error(App.t("player.err.open")));
    }
    v.addEventListener("loadedmetadata", ok);
    self._openFail = function(msg, code){ var e4 = new Error(msg); e4.code = code; fail(e4); };
    var nativeHls = v.canPlayType("application/vnd.apple.mpegurl");
    if(isHls(url) && !nativeHls && window.Hls && window.Hls.isSupported && window.Hls.isSupported()){
      var hls = self.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(window.Hls.Events.ERROR, function(evt, data){
        if(data && data.fatal){
          if(!done) fail(new Error(App.t("player.err.hls", { detail: data.details || data.type })));
          else self.h.error(App.t("player.err.hlsCut", { detail: data.details || data.type }), "HLS");
        }
      });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      if(isHls(url) && !nativeHls && !window.Hls){
        fail(new Error(App.t("player.err.noHls")));
        return;
      }
      v.src = url;
      v.load();
    }
    setTimeout(function(){
      if(!done && v.error){
        var e3 = new Error(App.t("player.err.browserFormat")); e3.code = "MEDIA_ERR_" + v.error.code; fail(e3);
      }
    }, 8000);
  });
};
VideoEngine.prototype.play = function(){ var p = this.v.play(); if(p && p.catch) p.catch(function(){}); };
VideoEngine.prototype.pause = function(){ this.v.pause(); };
VideoEngine.prototype.seek = function(sec){ try{ this.v.currentTime = Math.max(0, sec); }catch(e){} };
VideoEngine.prototype.time = function(){ return this.v.currentTime || 0; };
VideoEngine.prototype.duration = function(){ var d = this.v.duration; return isFinite(d) ? d : 0; };
VideoEngine.prototype.state = function(){ return this.v.paused ? "PAUSED" : "PLAYING"; };
VideoEngine.prototype.tracks = function(){
  var out = { audio: [], text: [] }, at = this.v.audioTracks;
  if(at && at.length > 1){
    for(var i = 0; i < at.length; i++){
      out.audio.push({ index: i, lang: normLang(at[i].language), label: at[i].label || langName(at[i].language), current: at[i].enabled });
    }
  }
  if(this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 1){
    var cur = this.hls.audioTrack;
    out.audio = this.hls.audioTracks.map(function(t, i){
      return { index: i, lang: normLang(t.lang), label: t.name || langName(t.lang), current: i === cur };
    });
  }
  return out;
};
VideoEngine.prototype.selectAudio = function(i){
  if(this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 1){ this.hls.audioTrack = i; return true; }
  var at = this.v.audioTracks;
  if(at && at.length){ for(var j = 0; j < at.length; j++) at[j].enabled = (j === i); return true; }
  return false;
};
VideoEngine.prototype.selectText = function(){ return false; };
VideoEngine.prototype.suspend = function(){ this.v.pause(); };
VideoEngine.prototype.restore = function(){};
VideoEngine.prototype.close = function(){
  var v = this.v;
  try{ v.pause(); }catch(e){}
  if(this.hls){ try{ this.hls.destroy(); }catch(e){} this.hls = null; }
  this.unbind();
  v.removeAttribute("src");
  try{ v.load(); }catch(e){}
};

/* ================= Handlers comunes de motor ================= */
var handlers = {
  buffering: function(on, pct){ setBuffering(on, pct); if(on) showOsd(); },
  ended: function(){ onEnded(); },
  error: function(msg, code){ onEngineError(msg, code, P.started); },
  embSub: function(text, dur){
    if(P.sub.kind !== "emb") return;
    showSubText(subHtml(text));
    clearTimeout(P.embTimer);
    P.embTimer = setTimeout(function(){ showSubText(""); }, dur);
  }
};

function makeEngine(name){
  if(name === "avplay") return new AvplayEngine(handlers);
  return new VideoEngine(handlers);
}

/* ================= Ciclo de vida ================= */
function curTime(){ return P.engine ? P.engine.time() : 0; }

function updateUi(){
  if(!P.active || !P.engine) return;
  var t = curTime(), d = P.engine.duration() || P.dur;
  if(d > 0) P.dur = d;
  if(P.opts && !P.opts.live && P.dur > 0){
    var shown = P.seekTarget !== null ? P.seekTarget : t;
    var pct = Math.max(0, Math.min(100, shown / P.dur * 100));
    els.plFill.style.width = pct + "%";
    els.plHead.style.left = pct + "%";
    els.plCur.textContent = App.fmtTime(shown);
    els.plDur.textContent = App.fmtTime(P.dur);
    els.plRemain.textContent = "−" + App.fmtTime(P.dur - shown);
  }
  // subtítulos externos
  if(P.sub.kind === "ext" && P.extCues.length){
    var cue = findCue(P.extCues, t);
    var html = cue ? subHtml(cue.text) : "";
    if(html !== P._lastSub){ P._lastSub = html; showSubText(html); }
  }
}

function findCue(cues, t){
  var lo = 0, hi = cues.length - 1, found = null;
  while(lo <= hi){
    var mid = (lo + hi) >> 1;
    if(cues[mid].s <= t){ found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // puede haber solapes: buscar hacia atrás unos pocos
  for(var i = found; i !== null && i >= 0 && i >= found - 3; i--){
    if(cues[i].s <= t && cues[i].e >= t) return cues[i];
  }
  return null;
}

function saveNow(){
  var o = P.opts;
  if(!o || o.live || !o.key || !P.engine || !P.started) return;
  var pos = curTime();
  if(!(pos > 0)) return;
  App.history.save({
    key: o.key, pos: pos, dur: P.dur || 0, title: o.title, subtitle: o.subtitle || "",
    poster: o.poster || "", meta: o.meta || {}
  });
  P.lastSaved = Date.now();
}

function clearTimers(){
  clearInterval(P.tick); P.tick = null;
  clearInterval(P.saveT); P.saveT = null;
  clearTimeout(P.osdT);
  clearTimeout(P.seekT); P.seekT = null; P.seekTarget = null;
  clearTimeout(P.embTimer);
  stopCountdown();
}

function closeEngine(){
  if(P.engine){ try{ P.engine.close(); }catch(e){} }
  P.engine = null;
  document.body.classList.remove("avplay-on");
}

function setupUi(o){
  build();
  applySubSize();
  els.plTitle.textContent = o.title || "";
  els.plSubtitle.textContent = o.subtitle || "";
  setClass(o.live, "live", root);
  els.plNextHint.style.display = o.next ? "" : "none";
  els.plFill.style.width = "0%"; els.plHead.style.left = "0%";
  els.plCur.textContent = "0:00"; els.plDur.textContent = o.live ? "" : "0:00"; els.plRemain.textContent = "";
  els.plErr.classList.remove("on");
  els.plSeek.classList.remove("on");
  showSubText(""); P._lastSub = "";
  root.classList.add("on");
  document.body.classList.add("player-on");
}

/* Arranca la reproducción de opts con el motor indicado */
function urlList(o){
  var l = [];
  [o.url].concat(o.urls || []).forEach(function(u){ if(u && l.indexOf(u) < 0) l.push(u); });
  return l;
}

function start(o, startAt, engineName, urlIdx){
  clearTimers();
  closeEngine();
  urlIdx = urlIdx || 0;
  P.urlIdx = urlIdx;
  P.opts = o; P.active = true; P.started = false; P.ended = false; P.dur = 0;
  P.paused = false;
  setupUi(o);
  setPaused(false);
  setBuffering(true, 0);
  showOsd(6000);

  engineName = engineName || (hasAvplay() ? "avplay" : "video");
  P.engineName = engineName;
  P.engine = makeEngine(engineName);
  document.body.classList.toggle("avplay-on", engineName === "avplay");
  els.plAv.style.display = engineName === "avplay" ? "block" : "none";
  els.plVideo.style.display = engineName === "video" ? "block" : "none";
  els.plEngine.textContent = engineName === "avplay" ? "AVPlay" : "HTML5";

  var engine = P.engine;
  // subtítulos externos se cargan en paralelo
  P.sub = { kind: "off", index: -1 }; P.extCues = [];
  fetchOnlineSubs(o);

  var urls = urlList(o);
  engine.open(urls[urlIdx] || o.url, startAt || 0).then(function(){
    if(P.engine !== engine) return;
    P.started = true;
    setBuffering(false);
    P.tick = setInterval(updateUi, 250);
    P.saveT = setInterval(function(){
      if(P.paused) return;
      saveNow();
      if(!o.live) App.bus.emit("player:progress", { key: o.key || null, meta: o.meta || {}, pos: curTime(), dur: P.dur || 0 });
    }, 10000);
    setTimeout(function(){ if(P.engine === engine) autoSelectTracks(); }, 600);
    if(o.onStart) try{ o.onStart(); }catch(e){}
    App.bus.emit("player:start", { key: o.key || null, meta: o.meta || {}, title: o.title || "", live: !!o.live });
  }).catch(function(err){
    if(P.engine !== engine) return;
    // URLs alternativas: probar la siguiente antes de mostrar error
    if(urlIdx + 1 < urls.length){
      console.warn("[player] falla URL " + urlIdx + ", probando alternativa", err);
      start(o, startAt, engineName, urlIdx + 1);
      return;
    }
    onEngineError(err && err.message ? err.message : String(err), (err && err.code) || "OPEN", false);
  });
}

function isFormatError(code, msg){
  return /MEDIA_ERR_(3|4)|NOT_SUPPORTED|UNSUPPORTED|CODEC/i.test(String(code || "")) ||
         msg === App.t("player.err.unsupported") || msg === App.t("player.err.browserFormat") ||
         msg === App.t("player.err.decode");
}
function fileNameOf(o){
  if(!o) return "";
  var m = o.meta || {};
  if(m.filename) return m.filename;
  if(m.fileName) return m.fileName;
  var u = String(o.url || "");
  var last = decodeURIComponent((u.split("?")[0].split("/").pop() || ""));
  if(/\.[a-z0-9]{2,4}$/i.test(last)) return last;
  return (o.subtitle ? o.title + " " + o.subtitle : o.title) || u;
}

function onEngineError(msg, code, wasPlaying){
  console.warn("[player] error", code, msg);
  App.bus.emit("player:error", { key: P.opts ? P.opts.key : null, message: msg });
  var learned = false;
  if(P.opts && !P.opts.live && isFormatError(code, msg) && App.caps && App.caps.learnFail){
    var fname = fileNameOf(P.opts), failUrl = urlList(P.opts)[P.urlIdx || 0] || P.opts.url;
    if(/MEDIA_ERR_4/.test(String(code))){
      // MEDIA_ERR_4 también sale con 404/enlace caducado: solo aprender si el archivo responde
      App.net.fetch(failUrl, { headers: { Range: "bytes=0-0" } }).then(function(r){
        try{ if(r.body && r.body.cancel) r.body.cancel(); }catch(e){}
        if(r.ok || r.status === 206) App.caps.learnFail(fname);
      }).catch(function(){});
    } else {
      try{ App.caps.learnFail(fname); learned = true; }catch(e){}
    }
  }
  setBuffering(false);
  if(!P.active) return;
  var o = P.opts;
  var pos = wasPlaying ? curTime() : (P._startAt || 0);
  if(wasPlaying) saveNow();
  var curEngine = P.engineName;
  var alt = curEngine === "avplay" ? "video" : (hasAvplay() ? "avplay" : null);
  var altLabel = alt === "video" ? App.t("player.tryHtml5") : App.t("player.tryAvplay");
  var buttons = [];
  if(o && o.url){ buttons.push({ label: App.t("player.retry"), value: "retry" }); }
  if(alt && o){ buttons.push({ label: altLabel, value: "alt" }); }
  buttons.push({ label: App.t("ui.close"), value: "close" });
  closeEngine();
  clearTimers();
  els.plErr.textContent = msg;
  els.plErr.classList.add("on");
  App.ui.modal({
    title: App.t("player.err.title"),
    html: "<p>" + App.esc(msg) + "</p>" +
      (learned ? "<p>" + App.esc(App.t("player.err.learned")) + "</p>" : "") +
      (curEngine === "video" && !hasAvplay() && !App.isTizen() ? "<p>" + App.esc(App.t("player.err.browserOnly")) + "</p>" : ""),
    buttons: buttons, cancelValue: "close",
    onClose: function(v){
      if(!P.active) return;
      if(v === "retry") start(o, pos, curEngine);
      else if(v === "alt") start(o, pos, alt);
      else stop();
    }
  });
}

function onEnded(){
  if(!P.active || P.ended) return;
  var o = P.opts;
  if(o.live){ onEngineError(App.t("player.err.liveEnd"), "LIVE_END", false); return; }
  P.ended = true;
  if(o.key){ saveNow(); App.history.markWatched(o.key); }
  App.bus.emit("player:ended", { key: o.key || null, meta: o.meta || {} });
  if(o.next && App.settings.get("autoplayNext")){
    startCountdown();
  } else {
    stop();
  }
}

/* ---- Cuenta atrás de siguiente episodio ---- */
function startCountdown(){
  var n = 10;
  P.countdown = { n: n };
  els.plCount.classList.add("on");
  function paint(){
    els.plCount.innerHTML = '<div class="pl-count-n num">' + P.countdown.n + '</div>' +
      '<div><b>' + App.esc(App.t("player.nextIn", { n: P.countdown.n })) + '</b><br><span class="muted">' + App.esc(App.t("player.nextKeys")) + '</span></div>';
  }
  paint();
  P.countdown.t = setInterval(function(){
    P.countdown.n--;
    if(P.countdown.n <= 0){ stopCountdown(); goNext(); }
    else paint();
  }, 1000);
}
function stopCountdown(){
  if(P.countdown){ clearInterval(P.countdown.t); P.countdown = null; }
  if(els.plCount) els.plCount.classList.remove("on");
}

function goNext(){
  var o = P.opts;
  if(!o || !o.next){ App.hint(App.t("player.noNext")); return; }
  saveNow();
  setBuffering(true, 0);
  App.ui.toast(App.t("player.loadingNext"));
  Promise.resolve().then(function(){ return o.next(); }).then(function(nx){
    if(!P.active) return;
    if(!nx){ setBuffering(false); App.hint(App.t("player.noMore")); if(P.ended) stop(); return; }
    play(nx);
  }).catch(function(e){
    setBuffering(false);
    App.hint(App.t("player.nextFailed", { msg: e.message }));
    if(P.ended) stop();
  });
}

/* ================= Subtítulos en internet (OpenSubtitles vía App.subs) ================= */
function fetchOnlineSubs(o){
  P.onlineSubsPending = false;
  if(!o || o.live || o._onlineSubsTried) return;
  if(o.subtitles && o.subtitles.length) return;
  var m = o.meta || {};
  if(!m.imdbId || App.settings.get("openSubs") === false || !App.subs || !App.subs.fetch) return;
  o._onlineSubsTried = true;
  P.onlineSubsPending = true;
  App.subs.fetch({ type: m.type === "movie" ? "movie" : (m.season !== undefined && m.season !== null ? "series" : (m.type || "movie")),
                   imdbId: m.imdbId, season: m.season, episode: m.episode, filename: m.filename || fileNameOf(o) })
    .then(function(list){
      if(P.opts !== o) return;
      P.onlineSubsPending = false;
      if(!list || !list.length) return;
      o.subtitles = (o.subtitles || []).concat(list);
      App.hint(App.t("player.subsFound", { n: list.length }));
      // si el reproductor ya arrancó y no hay subtítulos activos, re-evaluar la autoselección
      if(P.started && P.sub.kind === "off") autoSelectTracks(true);
    }).catch(function(){ if(P.opts === o) P.onlineSubsPending = false; });
}

/* Decodifica un subtítulo: UTF-8 y, si sale con muchos '\uFFFD', windows-1252 */
function decodeSubs(r){
  if(!r.arrayBuffer || typeof TextDecoder === "undefined") return r.text();
  return r.arrayBuffer().then(function(buf){
    var txt = new TextDecoder("utf-8").decode(buf);
    var bad = (txt.match(/\uFFFD/g) || []).length;
    if(bad > 3 && bad > txt.length / 2000){
      try{ txt = new TextDecoder("windows-1252").decode(buf); }catch(e){}
    }
    return txt;
  });
}

/* ================= Pistas y subtítulos ================= */
function autoSelectTracks(lateExt){
  if(!P.engine) return;
  var tr = P.engine.tracks();
  var aPref = normLang(App.settings.get("audioLang")), sPref = normLang(App.settings.get("subLang"));
  var audioLang = null;
  if(tr.audio.length > 1){
    var cur = tr.audio.filter(function(a){ return a.current; })[0];
    var want = tr.audio.filter(function(a){ return a.lang === aPref; })[0];
    if(want && (!cur || cur.index !== want.index)){ P.engine.selectAudio(want.index); audioLang = want.lang; }
    else audioLang = cur ? cur.lang : tr.audio[0].lang;
  } else if(tr.audio.length === 1){
    audioLang = tr.audio[0].lang;
  }
  // Subtítulos: solo si el audio no está en el idioma preferido (o es desconocido y hay subs del idioma)
  var foreign = audioLang && audioLang !== "und" && audioLang !== aPref;
  var exts = (P.opts && P.opts.subtitles) || [];
  var extIdx = -1;
  exts.forEach(function(s, i){ if(extIdx < 0 && normLang(s.lang) === sPref) extIdx = i; });
  var emb = tr.text.filter(function(t){ return t.lang === sPref; })[0];
  if(!lateExt && P.engine.name === "avplay") P.engine.selectText(-1);
  // Solo autoactivar si sabemos que el audio está en otro idioma
  if(!foreign) return;
  if(emb && !lateExt) selectSub("emb", emb.index, true);
  else if(extIdx >= 0) selectSub("ext", extIdx, true);
}

function selectSub(kind, index, silent){
  if(P.engine && P.engine.name === "avplay" && kind !== "emb") P.engine.selectText(-1);
  clearTimeout(P.embTimer);
  showSubText(""); P._lastSub = "";
  P.extCues = [];
  if(kind === "off"){ P.sub = { kind: "off", index: -1 }; if(!silent) App.hint(App.t("player.subsOff")); return; }
  if(kind === "emb"){
    if(P.engine && P.engine.selectText(index)){
      P.sub = { kind: "emb", index: index };
      if(!silent) App.hint(App.t("player.subsOn"));
    } else App.hint(App.t("player.subsTrackFail"));
    return;
  }
  var s = (P.opts.subtitles || [])[index];
  if(!s) return;
  P.sub = { kind: "ext", index: index };
  var url = s.url;
  var p = P.extCache[url] ? Promise.resolve(P.extCache[url]) :
    App.net.fetch(url).then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return decodeSubs(r); })
      .then(function(txt){ var c = parseSubs(txt); P.extCache[url] = c; return c; });
  p.then(function(cues){
    if(P.sub.kind !== "ext" || P.sub.index !== index) return;
    P.extCues = cues;
    if(!cues.length) App.hint(App.t("player.subsEmpty"));
    else if(!silent) App.hint(App.t("player.subsNamed", { name: s.label || langName(s.lang) }));
  }).catch(function(e){
    App.hint(App.t("player.subsLoadFail", { msg: e.message }));
    P.sub = { kind: "off", index: -1 };
  });
}

function subMenu(){
  if(!P.engine) return;
  var tr = P.engine.tracks(), items = [{ label: App.t("player.subsDisabled"), value: "off", selected: P.sub.kind === "off" }];
  tr.text.forEach(function(t){
    items.push({ label: App.t("player.subsEmbedded", { label: t.label }), value: "emb:" + t.index, selected: P.sub.kind === "emb" && P.sub.index === t.index });
  });
  ((P.opts && P.opts.subtitles) || []).forEach(function(s, i){
    items.push({ label: App.t("player.subsFile", { label: s.label || langName(s.lang) }), value: "ext:" + i, selected: P.sub.kind === "ext" && P.sub.index === i });
  });
  if(items.length === 1) items.push({ label: P.onlineSubsPending ? App.t("player.subsLoading") : App.t("player.subsNone"), value: "off" });
  App.ui.menu(App.t("player.subsTitle"), items).then(function(v){
    if(v === null || !P.active) return;
    if(v === "off") return selectSub("off");
    var parts = String(v).split(":");
    selectSub(parts[0], Number(parts[1]));
  });
}

function audioMenu(){
  if(!P.engine) return;
  var tr = P.engine.tracks();
  if(tr.audio.length < 2){ App.hint(tr.audio.length ? App.t("player.audioOne") : App.t("player.audioNoSwitch")); return; }
  App.ui.menu(App.t("player.audioTitle"), tr.audio.map(function(a){
    return { label: a.label, value: a.index, selected: !!a.current };
  })).then(function(v){
    if(v === null || !P.active) return;
    if(P.engine.selectAudio(Number(v))) App.hint(App.t("player.audioChanged"));
    else App.hint(App.t("player.audioFail"));
  });
}

function sizeMenu(){
  var cur = App.settings.get("subSize") || "m";
  App.ui.menu(App.t("player.sizeTitle"), [
    { label: App.t("player.size.s"), value: "s", selected: cur === "s" },
    { label: App.t("player.size.m"), value: "m", selected: cur === "m" },
    { label: App.t("player.size.l"), value: "l", selected: cur === "l" }
  ]).then(function(v){
    if(!v) return;
    App.settings.set("subSize", v);
    applySubSize();
  });
}

function tracksPanel(){
  if(!P.engine) return;
  var tr = P.engine.tracks();
  var curA = tr.audio.filter(function(a){ return a.current; })[0];
  var subLabel = App.t("player.subsDisabled");
  if(P.sub.kind === "emb"){ var t = tr.text.filter(function(x){ return x.index === P.sub.index; })[0]; subLabel = t ? t.label : App.t("player.embedded"); }
  if(P.sub.kind === "ext"){ var s = (P.opts.subtitles || [])[P.sub.index]; subLabel = s ? (s.label || langName(s.lang)) : App.t("player.file"); }
  var size = App.t("player.size." + (App.settings.get("subSize") || "m"));
  App.ui.menu(App.t("player.tracksTitle"), [
    { label: App.t("player.trackAudio", { v: curA ? curA.label : (tr.audio.length ? tr.audio[0].label : App.t("player.default")) }), value: "audio" },
    { label: App.t("player.trackSubs", { v: subLabel }), value: "subs" },
    { label: App.t("player.trackSize", { v: size }), value: "size" },
    { label: App.t("player.trackEngine", { v: P.engineName === "avplay" ? App.t("player.engineAvplay") : App.t("player.engineHtml5") }), value: "engine" }
  ]).then(function(v){
    if(!P.active) return;
    if(v === "audio") audioMenu();
    else if(v === "subs") subMenu();
    else if(v === "size") sizeMenu();
    else if(v === "engine") switchEngine();
  });
}

function switchEngine(){
  var alt = P.engineName === "avplay" ? "video" : (hasAvplay() ? "avplay" : null);
  if(!alt){ App.hint(App.t("player.avplayTvOnly")); return; }
  var pos = P.opts.live ? 0 : curTime();
  saveNow();
  start(P.opts, pos, alt);
}

/* ================= Seek acumulativo ================= */
function seekBy(delta){
  if(!P.engine || P.opts.live || !P.started) return;
  var base = P.seekTarget !== null ? P.seekTarget : curTime();
  var max = P.dur > 0 ? Math.max(0, P.dur - 2) : Infinity;
  P.seekTarget = Math.max(0, Math.min(max, base + delta));
  var diff = Math.round(P.seekTarget - curTime());
  els.plSeek.textContent = (diff >= 0 ? "+" : "−") + App.fmtTime(Math.abs(diff)) + "  →  " + App.fmtTime(P.seekTarget);
  els.plSeek.classList.add("on");
  showOsd();
  updateUi();
  clearTimeout(P.seekT);
  P.seekT = setTimeout(function(){
    var target = P.seekTarget;
    P.seekTarget = null; P.seekT = null;
    els.plSeek.classList.remove("on");
    if(P.engine && target !== null){ P.engine.seek(target); setTimeout(saveNow, 1500); }
  }, 700);
}

function togglePause(){
  if(!P.engine || !P.started) return;
  if(P.paused){ P.engine.play(); setPaused(false); }
  else { P.engine.pause(); setPaused(true); }
}

/* ================= API pública ================= */
function play(opts){
  if(opts && !opts.url && opts.urls && opts.urls.length) opts.url = opts.urls[0];
  if(!opts || !opts.url){ App.hint(App.t("player.noLink")); return; }
  build();
  var o = opts;
  var resume = null;
  if(o.startAt === undefined && !o.live && o.key){
    var h = App.history.get(o.key);
    if(h && h.pos > 30 && !(h.dur > 0 && h.pos / h.dur >= 0.9)) resume = h.pos;
  }
  if(resume === null){
    P._startAt = o.startAt || 0;
    start(o, o.startAt || 0);
    return;
  }
  // Pausar lo que hubiera mientras se pregunta
  if(P.active && P.engine){ saveNow(); closeEngine(); clearTimers(); }
  App.ui.modal({
    title: App.t("player.resumeTitle", { time: App.fmtTime(resume) }),
    html: "<p>" + App.esc(o.title || "") + (o.subtitle ? " · " + App.esc(o.subtitle) : "") + "</p>",
    buttons: [{ label: App.t("player.resume"), value: true }, { label: App.t("player.fromStart"), value: false }],
    cancelValue: null,
    onClose: function(v){
      if(v === null){ if(P.active) stop(); return; }
      P._startAt = v ? resume : 0;
      start(o, P._startAt);
    }
  });
}

function stop(){
  var o = P.opts;
  var closePos = (P.active && P.engine && P.started) ? curTime() : 0, closeDur = P.dur || 0;
  if(P.active) saveNow();
  clearTimers();
  closeEngine();
  P.active = false;
  P.started = false;
  if(root){
    root.classList.remove("on", "live");
    els.plErr.classList.remove("on");
    showSubText("");
  }
  document.body.classList.remove("player-on");
  P.opts = null;
  if(o && o.onClose){ try{ o.onClose(); }catch(e){} }
  App.bus.emit("player:close", { key: o ? o.key : null, meta: o ? (o.meta || {}) : {}, pos: closePos, dur: closeDur });
  // repintar foco de la pantalla de debajo
  try{
    var def = App.screens && App.current() && App.screens.get(App.current());
    if(def && def.focus) def.focus();
  }catch(e){}
}

function onKey(k){
  if(!P.active) return false;
  var o = P.opts || {};

  if(P.countdown){
    if(k === K.OK || k === K.NEXT){ stopCountdown(); goNext(); }
    else if(App.isBack(k) || k === K.STOP){ stopCountdown(); stop(); }
    return true;
  }

  if(App.isBack(k) || k === K.STOP){ stop(); return true; }

  // Números (directo)
  var d = App.digit(k);
  if(d >= 0){ if(o.onDigit) o.onDigit(d); showOsd(); return true; }

  if(o.live){
    if(k === K.CHUP || (k === K.UP && o.onChannel)){ if(o.onChannel) o.onChannel(1); showOsd(); return true; }
    if(k === K.CHDOWN || (k === K.DOWN && o.onChannel)){ if(o.onChannel) o.onChannel(-1); showOsd(); return true; }
  }

  switch(k){
    case K.OK: case K.PLAYPAUSE: togglePause(); return true;
    case K.PLAY: if(P.paused) togglePause(); else showOsd(); return true;
    case K.PAUSE: if(!P.paused) togglePause(); else showOsd(); return true;
    case K.LEFT: seekBy(-10); return true;
    case K.RIGHT: seekBy(10); return true;
    case K.RW: seekBy(-60); return true;
    case K.FF: seekBy(60); return true;
    case K.UP: tracksPanel(); return true;
    case K.DOWN: case K.INFO: showOsd(); return true;
    case K.NEXT: if(o.next) goNext(); else App.hint(App.t("player.noNext")); return true;
    case K.PREV: if(!o.live && P.started){ P.engine.seek(0); showOsd(); } return true;
    case K.GREEN: subMenu(); return true;
    case K.RED: audioMenu(); return true;
    case K.YELLOW: tracksPanel(); return true;
    case K.CHUP: case K.CHDOWN: return true;
  }
  showOsd();
  return true;
}

/* ================= Visibilidad / suspensión ================= */
document.addEventListener("visibilitychange", function(){
  if(!P.active || !P.engine) return;
  if(document.hidden){
    saveNow();
    try{ P.engine.suspend(); }catch(e){}
    P._wasPaused = P.paused;
  } else {
    try{ P.engine.restore(); }catch(e){}
    if(P.engine.name === "video" && !P._wasPaused) P.engine.play();
    showOsd();
  }
});
window.addEventListener("beforeunload", function(){ if(P.active){ saveNow(); closeEngine(); } });

App.bus.on("settings:change", function(ch){
  if(ch && ch.key === "subSize" && root) applySubSize();
});

App.player = {
  play: play,
  stop: stop,
  isActive: function(){ return P.active; },
  onKey: onKey,
  engine: function(){ return P.active ? P.engineName : null; },
  hasAvplay: hasAvplay,
  parseSubs: parseSubs,
  current: function(){ return P.active && P.opts ? { key: P.opts.key, meta: P.opts.meta || {}, title: P.opts.title } : null; }
};

})();
