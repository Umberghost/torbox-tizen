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
    '<div class="pl-seek num" id="plSeek"><div class="pl-thumb" id="plThumb"></div><span id="plSeekTxt"></span></div>' +
    '<div class="pl-skip" id="plSkip"></div>' +
    '<div class="pl-sleep" id="plSleep"></div>' +
    '<div class="pl-recap" id="plRecap"></div>' +
    '<div class="pl-osd" id="plOsd">' +
      '<div class="pl-top">' +
        '<div class="pl-titles"><div class="pl-eyebrow"><span class="pl-live" id="plLive">' + App.esc(App.t("player.live")) + '</span><span id="plSubtitle"></span></div>' +
          '<h1 class="pl-title" id="plTitle"></h1><div class="pl-line" id="plLine"></div></div>' +
        '<div class="pl-tags" id="plTags"></div><span class="pl-engine" id="plEngine"></span></div>' +
      '<div class="pl-progress" id="plProg"><span class="pl-t num" id="plCur">0:00</span>' +
        '<div class="pl-bar"><i id="plFill"></i><span class="pl-segs" id="plSegs"></span><b id="plHead"></b></div>' +
        '<span class="pl-t pl-t-r num" id="plRemain"></span><span id="plDur" style="display:none"></span></div>' +
      '<div class="pl-bar-ctl" id="plPanel" role="toolbar"></div>' +
    '</div>' +
    '<div class="pl-countdown" id="plCount"></div>' +
    '<div class="pl-error" id="plErr"></div>';
  ["plAv","plVideo","plSub","plSpin","plBuf","plPause","plSeek","plOsd","plLive","plTitle","plSubtitle",
   "plEngine","plProg","plFill","plHead","plCur","plRemain","plDur","plCount","plErr",
   "plThumb","plSeekTxt","plSkip","plSleep","plRecap","plPanel","plTags","plSegs","plLine"]
    .forEach(function(id){ els[id] = document.getElementById(id); });
  els.subSpan = els.plSub.querySelector("span");
  if(!App.isTizen()) initPointer();   // ratón / táctil: nunca en la TV
}

function setClass(on, cls, el){ (el || root).classList.toggle(cls, !!on); }

function osdVisible(){ return !!(root && root.classList.contains("osd-on") && !els.plOsd.classList.contains("hide")); }
function showOsd(ms){
  if(!root) return;
  var was = osdVisible();
  els.plOsd.classList.remove("hide");
  root.classList.add("osd-on");
  if(!was){ P.ctlId = "pp"; P.barTouched = false; P.barActive = false; P._tagT = 0; }
  clearTimeout(P.osdT);
  renderBar();
  refreshTags();
  if(!P.paused || (P.opts && P.opts.live)){
    P.osdT = setTimeout(hideOsd, ms || 5000);
  }
}
function hideOsd(){ if(root){ clearTimeout(P.osdT); P.barActive = false; els.plOsd.classList.add("hide"); root.classList.remove("osd-on"); } }
/* La barra de botones solo recibe ◄► después de entrar en ella con ▼ u OK; antes ◄► siempre avanzan/retroceden */
function enterBar(){ showOsd(); P.barActive = true; renderBar(); }

/* ---- Títulos (eyebrow pequeño + título grande) ---- */
function pad2(n){ n = Number(n); return n < 10 ? "0" + n : String(n); }
function paintTitles(o){
  var m = o.meta || {}, eyebrow = o.subtitle || "", big = o.title || "", line = "";
  if(o.live){ eyebrow = ""; line = o.subtitle || ""; }
  else if(m.episodeTitle && m.season !== undefined && m.season !== null && m.episode !== undefined && m.episode !== null){
    eyebrow = (o.title || "") + " · " + App.t("player.v2.se", { s: m.season, e: pad2(m.episode) });
    big = m.episodeTitle;
  }
  els.plSubtitle.textContent = eyebrow;
  els.plTitle.textContent = big;
  els.plLine.textContent = line;
  els.plLine.style.display = line ? "" : "none";
  els.plSubtitle.style.display = eyebrow ? "" : "none";
}

/* ---- Etiquetas técnicas (calidad·códec, audio, subtítulos) ---- */
var VCODEC = { hvc1: "HEVC", hev1: "HEVC", hevc: "HEVC", h265: "HEVC", avc1: "H.264", avc: "H.264", h264: "H.264", vp09: "VP9", vp9: "VP9", av01: "AV1", av1: "AV1" };
function subLabelNow(){
  var off = App.t("player.v2.no");
  if(!P.engine) return off;
  if(P.sub.kind === "emb"){
    var t = P.engine.tracks().text.filter(function(x){ return x.index === P.sub.index; })[0];
    return t ? t.label : App.t("player.embedded");
  }
  if(P.sub.kind === "ext"){ var s = ((P.opts && P.opts.subtitles) || [])[P.sub.index]; return s ? (s.label || langName(s.lang)) : App.t("player.file"); }
  return off;
}
function refreshTags(){
  if(!P.engine || !P.opts || !osdVisible()) return;
  if(Date.now() - (P._tagT || 0) < 2000) return;
  P._tagT = Date.now();
  var o = P.opts, m = o.meta || {}, tags = [], res = "", vc = "";
  try{
    P.engine.info().forEach(function(r){
      if(r[0] === "res"){ var h = Number(String(r[1]).split("×")[1]); if(h) res = h >= 2000 ? "4K" : h + "p"; }
      if(r[0] === "vcodec"){ var k = String(r[1]).toLowerCase().split(".")[0]; vc = VCODEC[k] || String(r[1]).toUpperCase(); }
    });
  }catch(e){}
  if(!res) res = m.quality || o.quality || "";
  if(res || vc) tags.push(res + (res && vc ? " · " : "") + vc);
  try{
    var tr = P.engine.tracks(), cur = tr.audio.filter(function(a){ return a.current; })[0] || tr.audio[0];
    if(cur) tags.push(App.t("player.v2.tagAudio", { v: cur.label }));
  }catch(e){}
  if(!o.live || P.sub.kind !== "off") tags.push(App.t("player.v2.tagSubs", { v: subLabelNow() }));
  els.plTags.innerHTML = tags.map(function(x){ return '<span>' + App.esc(x) + '</span>'; }).join("");
}

/* ---- Segmentos de intro / créditos sobre la barra ---- */
function renderSegs(){
  var sig = (P.skip ? P.skip.list.length : 0) + ":" + Math.round(P.dur || 0);
  if(sig === P._segSig) return;
  P._segSig = sig;
  if(!P.skip || !(P.dur > 0)){ els.plSegs.innerHTML = ""; return; }
  els.plSegs.innerHTML = P.skip.list.map(function(x){
    var e = x.e || P.dur, l = Math.max(0, Math.min(100, x.s / P.dur * 100)), w = Math.max(0.6, Math.min(100 - l, (e - x.s) / P.dur * 100));
    return '<i style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i>';
  }).join("");
}

function setBuffering(on, pct){
  P.buffering = !!on;
  setClass(on, "on", els.plSpin);
  els.plBuf.textContent = on && pct ? pct + " %" : "";
}

function setPaused(p){
  var was = P.paused;
  P.paused = !!p;
  setClass(P.paused, "on", els.plPause);
  if(was !== P.paused) emitState();
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
      self._rh = Math.round(hh * f);
      av.setDisplayRect(0, 0, 1920, self._rh);
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
AvplayEngine.prototype.setSpeed = function(x){ try{ this.av.setSpeed(x); return true; }catch(e){ return false; } };
AvplayEngine.prototype.setZoom = function(mode){
  var av = this.av, h = this._rh || 1080, M = { fit: "PLAYER_DISPLAY_MODE_LETTER_BOX", fill: "PLAYER_DISPLAY_MODE_CROPPED_FULL",
    stretch: "PLAYER_DISPLAY_MODE_FULL_SCREEN", cinema: "PLAYER_DISPLAY_MODE_LETTER_BOX" };
  try{
    if(mode === "cinema"){
      av.setDisplayMethod(M.cinema);
      av.setDisplayRect(-Math.round(1920 * 0.165), -Math.round(h * 0.165), Math.round(1920 * 1.33), Math.round(h * 1.33));
    } else {
      av.setDisplayRect(0, 0, 1920, h);
      av.setDisplayMethod(M[mode] || M.fit);
    }
    return true;
  }catch(e){ return false; }
};
AvplayEngine.prototype.setSubOffset = function(sec){ try{ this.av.setSubtitlePosition(Math.round(sec * 1000)); return true; }catch(e){ return false; } };
AvplayEngine.prototype.info = function(){
  var out = [];
  try{
    (this.av.getCurrentStreamInfo() || []).forEach(function(s){
      var ex = {};
      try{ ex = typeof s.extra_info === "string" ? JSON.parse(s.extra_info) : (s.extra_info || {}); }catch(e){}
      if(s.type === "VIDEO"){
        if(ex.Width && ex.Height) out.push(["res", ex.Width + "×" + ex.Height]);
        if(ex.fourCC) out.push(["vcodec", String(ex.fourCC).toUpperCase()]);
        if(ex.Bit_rate) out.push(["bitrate", Math.round(Number(ex.Bit_rate) / 1000) + " kbps"]);
        if(ex.framerate) out.push(["fps", String(ex.framerate)]);
      } else if(s.type === "AUDIO"){
        if(ex.fourCC) out.push(["acodec", String(ex.fourCC).toUpperCase() + (ex.channels ? " · " + ex.channels + "ch" : "")]);
      }
    });
  }catch(e){}
  return out;
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
VideoEngine.prototype.setSpeed = function(x){ try{ this.v.defaultPlaybackRate = x; this.v.playbackRate = x; return true; }catch(e){ return false; } };
VideoEngine.prototype.setZoom = function(mode){
  var st = this.v.style;
  st.objectFit = mode === "fill" ? "cover" : mode === "stretch" ? "fill" : "contain";
  st.transform = mode === "cinema" ? "scale(1.33)" : "";
  return true;
};
VideoEngine.prototype.setSubOffset = function(){ return false; };
VideoEngine.prototype.info = function(){
  var v = this.v, out = [];
  if(v.videoWidth) out.push(["res", v.videoWidth + "×" + v.videoHeight]);
  try{
    var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
    if(q) out.push(["dropped", q.droppedVideoFrames + " / " + q.totalVideoFrames]);
  }catch(e){}
  if(this.hls && this.hls.levels && this.hls.currentLevel >= 0){
    var lv = this.hls.levels[this.hls.currentLevel];
    if(lv && lv.bitrate) out.push(["bitrate", Math.round(lv.bitrate / 1000) + " kbps"]);
    if(lv && lv.videoCodec) out.push(["vcodec", lv.videoCodec]);
    if(lv && lv.audioCodec) out.push(["acodec", lv.audioCodec]);
  }
  return out;
};
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
    els.plRemain.textContent = "−" + App.fmtTime(Math.max(0, P.dur - shown));
    renderSegs();
  }
  refreshTags();
  // subtítulos externos
  if(P.sub.kind === "ext" && P.extCues.length){
    var cue = findCue(P.extCues, t - (P.subDelay || 0));
    var html = cue ? subHtml(cue.text) : "";
    if(html !== P._lastSub){ P._lastSub = html; showSubText(html); }
  }
  skipTick(t);
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
  clearTimeout(P.recapT); P.recapT = null;
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
  paintTitles(o);
  els.plTags.innerHTML = ""; els.plSegs.innerHTML = ""; P._segSig = ""; P.barTouched = false; P.ctlId = "pp";
  setClass(o.live, "live", root);
  els.plFill.style.width = "0%"; els.plHead.style.left = "0%";
  els.plCur.textContent = "0:00"; els.plDur.textContent = o.live ? "" : "0:00"; els.plRemain.textContent = "";
  els.plErr.classList.remove("on");
  els.plSeek.classList.remove("on");
  showSubText(""); P._lastSub = "";
  closeRecap(true);
  els.plVideo.style.objectFit = ""; els.plVideo.style.transform = "";
  P.skip = null; P.skipCur = null; els.plSkip.classList.remove("on");
  els.plThumb.style.backgroundImage = ""; P.still = "";
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
    afterStart(o, engine, startAt || 0);
    if(o.onStart) try{ o.onStart(); }catch(e){}
    App.bus.emit("player:start", { key: o.key || null, meta: o.meta || {}, title: o.title || "", live: !!o.live });
    emitState();
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
  // En el PC/móvil (sin AVPlay): ofrecer el enlace para un reproductor externo como VLC
  var pcLink = !App.isTizen() && o && o.url && !o.live;
  if(pcLink){
    buttons.push({ label: App.t("player.copyLink"), value: "copy" });
    buttons.push({ label: App.t("player.openLink"), value: "open" });
  }
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
      else if(v === "copy"){
        var url = o.url;
        var done = function(){ App.ui.toast(App.t("player.linkCopied"), 9000); };
        if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function(){ window.prompt("URL", url); });
        else window.prompt("URL", url);
        stop();
      }
      else if(v === "open"){ try{ window.open(o.url, "_blank"); }catch(e){} stop(); }
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
  if(P.sleep && P.sleep.mode === "end"){
    App.ui.toast(App.t("player.sleep.done"), 5000);
    stop();
  } else if(o.next && App.settings.get("autoplayNext")){
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
      '<div><b>' + App.esc(App.t("player.nextIn", { n: P.countdown.n })) + '</b><span class="muted">' + App.esc(App.t("player.nextKeys")) + '</span></div>';
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
  if(!P.ended && o.key && !o.live){   // #18: saltar al siguiente = visto
    try{ App.history.markWatched(o.key); }catch(e){}
  }
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
  els.plSeekTxt.textContent = (diff >= 0 ? "+" : "−") + App.fmtTime(Math.abs(diff)) + "  →  " + App.fmtTime(P.seekTarget);
  els.plThumb.style.display = P.still ? "block" : "none";
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

/* ◄► mantenido: el salto crece cuanto más tiempo se mantiene (10 s → 30 s → 1 min → 2 min por repetición) */
function holdStep(){
  var now = Date.now();
  if(!P.holdT0 || now - (P.holdLast || 0) > 350) P.holdT0 = now;   // pulsación nueva
  P.holdLast = now;
  var held = now - P.holdT0;
  return held < 1500 ? 10 : held < 4000 ? 30 : held < 8000 ? 60 : 120;
}

function togglePause(){
  if(!P.engine || !P.started) return;
  if(P.paused){ P.engine.play(); setPaused(false); }
  else { P.engine.pause(); setPaused(true); }
}

/* ================= Estado público / eventos ================= */
function statusObj(){
  var o = P.opts || {};
  var active = !!(P.active && P.opts);
  return {
    active: active,
    title: active ? (o.title || "") : "",
    subtitle: active ? (o.subtitle || "") : "",
    pos: active && P.engine && P.started ? curTime() : 0,
    dur: P.dur || 0,
    paused: !!P.paused,
    live: active ? !!o.live : false,
    key: active ? (o.key || null) : null,
    poster: active ? (o.poster || "") : ""
  };
}
function emitState(){ App.bus.emit("player:state", statusObj()); }

function control(cmd, arg){
  if(!P.active || !P.engine) return false;
  switch(cmd){
    case "playpause": togglePause(); return true;
    case "play": if(P.paused) togglePause(); return true;
    case "pause": if(!P.paused) togglePause(); return true;
    case "stop": stop(); return true;
    case "seek": if(P.started && !P.opts.live){ var t = Math.max(0, curTime() + Number(arg || 0)); P.engine.seek(t); showOsd(); } return true;
    case "seekTo": if(P.started && !P.opts.live){ P.engine.seek(Math.max(0, Number(arg || 0))); showOsd(); } return true;
  }
  return false;
}

/* ================= Velocidad ================= */
var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
function setSpeed(x){
  x = Number(x) || 1;
  if(!P.engine) return;
  if(P.engine.setSpeed(x)){ P.speed = x; if(x !== 1 || P._speedShown) App.hint(App.t("player.speedSet", { v: x })); P._speedShown = true; }
  else App.hint(App.t("player.speedFail"));
}
function speedMenu(){
  App.ui.menu(App.t("player.speedTitle"), SPEEDS.map(function(x){
    return { label: x + "×", value: x, selected: (P.speed || 1) === x };
  })).then(function(v){ if(v !== null && P.active) setSpeed(v); });
}

/* ================= Zoom / aspecto ================= */
var ZOOMS = ["fit", "fill", "stretch", "cinema"];
function setZoom(m){
  if(!P.engine) return;
  if(P.engine.setZoom(m)){ P.zoom = m; App.hint(App.t("player.zoom." + m)); }
  else App.hint(App.t("player.zoomFail"));
}
function zoomMenu(){
  App.ui.menu(App.t("player.zoomTitle"), ZOOMS.map(function(m){
    return { label: App.t("player.zoom." + m), value: m, selected: (P.zoom || "fit") === m };
  })).then(function(v){ if(v && P.active) setZoom(v); });
}

/* ================= Desfase de subtítulos (por serie) ================= */
function showKeyOf(o){
  var m = (o && o.meta) || {};
  return String(m.imdbId || m.showTitle || m.title || (o && o.title) || (o && o.key) || "");
}
function loadSubDelay(o){
  var map = App.store.get("subDelay", {}) || {};
  P.subDelay = Number(map[showKeyOf(o)]) || 0;
  applySubDelayEngine();
}
function applySubDelayEngine(){
  if(P.engine && P.sub.kind === "emb" && P.engine.setSubOffset) P.engine.setSubOffset(P.subDelay || 0);
}
function setSubDelay(v){
  P.subDelay = Math.round(v * 100) / 100;
  var map = App.store.get("subDelay", {}) || {};
  var k = showKeyOf(P.opts);
  if(P.subDelay) map[k] = P.subDelay; else delete map[k];
  App.store.set("subDelay", map);
  applySubDelayEngine();
  P._lastSub = "";
  App.hint(App.t("player.subDelayNow", { v: (P.subDelay > 0 ? "+" : "") + P.subDelay.toFixed(2).replace(/0$/, "") }));
}
function subDelayMenu(){
  var cur = P.subDelay || 0;
  var items = [
    { label: "+0,25 s", value: 0.25 }, { label: "+0,5 s", value: 0.5 },
    { label: "−0,25 s", value: -0.25 }, { label: "−0,5 s", value: -0.5 },
    { label: App.t("player.subDelayReset"), value: "reset" }
  ];
  App.ui.menu(App.t("player.subDelayTitle", { v: cur.toFixed(2) + " s" }), items).then(function(v){
    if(v === null || !P.active) return;
    if(v === "reset") setSubDelay(0); else setSubDelay(cur + Number(v));
  });
}

/* ================= Información técnica ================= */
function infoPanel(){
  if(!P.engine) return;
  var o = P.opts || {}, rows = [];
  rows.push([App.t("player.info.engine"), P.engineName === "avplay" ? "AVPlay" : "HTML5"]);
  P.engine.info().forEach(function(r){ rows.push([App.t("player.info." + r[0]), r[1]]); });
  var m = o.meta || {}, size = Number(m.size || m.bytes || 0);
  if(size > 0 && P.dur > 0 && !rows.some(function(r){ return r[0] === App.t("player.info.bitrate"); })){
    rows.push([App.t("player.info.bitrate"), "~" + Math.round(size * 8 / P.dur / 1000) + " kbps"]);
  }
  if(size > 0) rows.push([App.t("player.info.size"), App.fmtSize(size)]);
  var dm = String(urlList(o)[P.urlIdx || 0] || "").match(/^https?:\/\/([^\/?#]+)/i);
  if(dm) rows.push([App.t("player.info.server"), dm[1]]);
  if(P.speed && P.speed !== 1) rows.push([App.t("player.info.speed"), P.speed + "×"]);
  App.ui.modal({
    title: App.t("player.infoTitle"),
    html: '<table class="pl-info">' + rows.map(function(r){
      return "<tr><td>" + App.esc(r[0]) + "</td><td>" + App.esc(r[1]) + "</td></tr>";
    }).join("") + "</table>",
    buttons: [{ label: App.t("ui.close"), value: true }], cancelValue: true
  });
}

/* ================= Temporizador de apagado ================= */
function clearSleep(){
  if(P.sleep && P.sleep.t) clearInterval(P.sleep.t);
  P.sleep = null;
  if(els.plSleep) els.plSleep.classList.remove("on");
}
function setSleep(mode){
  clearSleep();
  P.speed = 1; P.zoom = "fit"; P.subDelay = 0; P._speedShown = false;
  if(mode === "off"){ App.hint(App.t("player.sleep.off")); return; }
  if(mode === "end"){
    P.sleep = { mode: "end" };
    App.hint(App.t("player.sleep.setEnd"));
    return;
  }
  var mins = Number(mode);
  P.sleep = { mode: "min", at: Date.now() + mins * 60000, warned: false };
  App.hint(App.t("player.sleep.set", { n: mins }));
  P.sleep.t = setInterval(sleepTick, 1000);
}
function sleepTick(){
  var S = P.sleep;
  if(!S || S.mode !== "min"){ return; }
  var left = Math.round((S.at - Date.now()) / 1000);
  if(left <= 30 && left > 0){
    S.warned = true;
    els.plSleep.textContent = App.t("player.sleep.warn", { n: left });
    els.plSleep.classList.add("on");
  }
  if(left <= 0){
    clearInterval(S.t);
    try{ if(P.engine && !P.paused) P.engine.pause(); }catch(e){}
    App.ui.toast(App.t("player.sleep.done"), 6000);
    stop();
  }
}
function sleepMenu(){
  var cur = P.sleep ? (P.sleep.mode === "end" ? "end" : "min") : "off";
  var items = [
    { label: App.t("player.sleep.optEnd"), value: "end", selected: cur === "end" },
    { label: App.t("player.sleep.opt", { n: 30 }), value: 30 },
    { label: App.t("player.sleep.opt", { n: 60 }), value: 60 },
    { label: App.t("player.sleep.opt", { n: 90 }), value: 90 },
    { label: App.t("player.sleep.optOff"), value: "off", selected: cur === "off" }
  ];
  App.ui.menu(App.t("player.sleep.title"), items).then(function(v){
    if(v === null || !P.active) return;
    setSleep(v);
  });
}

/* ================= Saltar intro / créditos ================= */
var skipMem = {};
function cacheGet(k){
  if(App.cache && App.cache.get) return App.cache.get(k).catch(function(){ return undefined; });
  return Promise.resolve(skipMem[k]);
}
function cacheSet(k, v, ttl){
  if(App.cache && App.cache.set) { try{ App.cache.set(k, v, ttl); }catch(e){} }
  else skipMem[k] = v;
}
function skipRemote(m){
  var isNum = function(x){ return x !== undefined && x !== null && x !== ""; };
  // Anime con id de MyAnimeList: AniSkip
  if(m.malId && isNum(m.episode)){
    var u = "https://api.aniskip.com/v2/skip-times/" + encodeURIComponent(m.malId) + "/" + encodeURIComponent(m.episode) +
      "?types[]=op&types[]=ed&types[]=recap&episodeLength=0";
    return App.net.fetch(u).then(function(r){ if(!r.ok) return []; return r.json(); }).then(function(j){
      var out = [];
      ((j && j.results) || []).forEach(function(x){
        var iv = x.interval || {};
        var kind = /^(op|mixed-op)$/.test(x.skipType) ? "intro" : /^(ed|mixed-ed)$/.test(x.skipType) ? "credits" : x.skipType === "recap" ? "recap" : null;
        if(kind && iv.endTime > iv.startTime) out.push({ kind: kind, s: Number(iv.startTime), e: Number(iv.endTime) });
      });
      return out;
    });
  }
  if(!m.imdbId || !/^tt\d+$/.test(String(m.imdbId))) return Promise.resolve([]);
  // TheIntroDB (sin clave): imdb_id + temporada/episodio
  var url = "https://api.theintrodb.org/v2/media?imdb_id=" + m.imdbId +
    (isNum(m.season) && isNum(m.episode) ? "&season=" + m.season + "&episode=" + m.episode : "");
  return App.net.fetch(url).then(function(r){ if(!r.ok) return null; return r.json(); }).then(function(j){
    var out = [];
    if(!j) return out;
    ["intro", "recap", "credits"].forEach(function(kind){
      (j[kind] || []).forEach(function(x){
        var s = Number(x.start_ms) / 1000, e = x.end_ms === null || x.end_ms === undefined ? 0 : Number(x.end_ms) / 1000;
        if(isFinite(s) && (e === 0 || e > s)) out.push({ kind: kind, s: s, e: e });
      });
    });
    return out;
  });
}
function fetchSkip(o){
  if(!o || o.live) return;
  var m = o.meta || {};
  if(!m.imdbId && !m.malId) return;
  var key = "skip:" + (m.malId ? "mal" + m.malId : m.imdbId) + ":" + (m.season !== undefined && m.season !== null ? m.season : "m") + ":" + (m.episode !== undefined && m.episode !== null ? m.episode : "");
  cacheGet(key).then(function(v){
    if(v !== undefined && v !== null) return v;
    return skipRemote(m).then(function(list){
      cacheSet(key, list, list.length ? 14 * 86400000 : 2 * 86400000);
      return list;
    });
  }).then(function(list){
    if(P.opts !== o || !list) return;
    P.skip = { list: list.map(function(x){ return { kind: x.kind, s: x.s, e: x.e, done: false }; }) };
  }).catch(function(e){ console.warn("[player] skip", e && e.message); });
}
function skipTick(t){
  if(!P.skip || !P.skip.list.length || P.seekTarget !== null){ return; }
  var cur = null, dur = P.dur || 0;
  P.skip.list.forEach(function(x){
    var e = x.e || dur || 0;
    if(x.kind === "credits" && !(P.opts && P.opts.next)) return;
    if(t >= x.s && (e === 0 || t < e - 1) && !cur) cur = x;
  });
  if(cur === P.skipCur) return;
  P.skipCur = cur;
  if(!cur){ els.plSkip.classList.remove("on"); return; }
  if(cur.kind !== "credits" && !cur.done && App.settings.get("skipIntroAuto") === true && cur.e > 0){
    cur.done = true; P.skipCur = null;
    els.plSkip.classList.remove("on");
    App.hint(App.t("player.skipAuto"));
    P.engine.seek(cur.e);
    return;
  }
  els.plSkip.innerHTML = App.esc(App.t(cur.kind === "credits" ? "player.skipNext" : cur.kind === "recap" ? "player.skipRecap" : "player.skipIntro")) +
    ' <span class="pl-skip-ok">OK</span>';
  els.plSkip.classList.add("on");
}
function doSkip(){
  var cur = P.skipCur;
  if(!cur) return false;
  cur.done = true;
  els.plSkip.classList.remove("on");
  P.skipCur = null;
  if(cur.kind === "credits"){ goNext(); return true; }
  if(cur.e > 0 && P.engine) P.engine.seek(cur.e);
  return true;
}

/* ================= Miniatura del episodio (#3) y resumen de temporada (#16) ================= */
function afterStart(o, engine, startAt){
  if(o.live) return;
  loadSubDelay(o);
  var spd = Number(App.settings.get("playerSpeed")) || 1;
  if(P.speed && P.speed !== 1) spd = P.speed;
  if(spd !== 1 && engine.setSpeed) { if(engine.setSpeed(spd)) P.speed = spd; }
  if(P.zoom && P.zoom !== "fit") engine.setZoom(P.zoom);
  fetchSkip(o);
  fetchStill(o);
  maybeRecap(o, startAt);
}
function fetchStill(o){
  var m = o.meta || {};
  if(m.season === undefined || m.season === null || m.episode === undefined || m.episode === null || !App.meta) return;
  var setStill = function(url){
    if(P.opts !== o || !url) return;
    P.still = url;
    els.plThumb.style.backgroundImage = "url('" + String(url).replace(/'/g, "%27") + "')";
  };
  var viaTitle = function(){
    if(!m.imdbId || !App.meta.title) return null;
    return App.meta.title("series", m.imdbId).then(function(t){
      var v = t && (t.videos || []).filter(function(x){ return Number(x.season) === Number(m.season) && Number(x.episode) === Number(m.episode); })[0];
      if(v && v.thumbnail) setStill(v.thumbnail);
    });
  };
  var p = null;
  if(m.tmdbId && App.meta.season){
    p = App.meta.season(m.tmdbId, m.season).then(function(s){
      var ep = s && (s.episodes || []).filter(function(x){ return Number(x.episode) === Number(m.episode); })[0];
      if(ep && ep.still) setStill(ep.still); else return viaTitle();
    });
  } else p = viaTitle();
  if(p && p.catch) p.catch(function(){});
}

function closeRecap(silent){
  clearTimeout(P.recapT); P.recapT = null;
  if(els.plRecap) els.plRecap.classList.remove("on");
  if(P.recap){
    P.recap = false;
    if(!silent && P.engine && !P.paused){ P.engine.play(); }
  }
}
function maybeRecap(o, startAt){
  var m = o.meta || {};
  if(!(Number(m.season) > 1) || Number(m.episode) !== 1 || startAt > 5 || !App.meta) return;
  var done = function(text){
    if(!text || P.opts !== o || !P.active) return;
    P.recap = true;
    try{ P.engine.pause(); }catch(e){}
    els.plRecap.innerHTML = '<div class="pl-recap-h">' + App.esc(App.t("player.recap.title", { n: Number(m.season) - 1 })) + '</div>' +
      '<div class="pl-recap-t">' + App.esc(text) + '</div>' +
      '<div class="pl-recap-k">' + App.esc(App.t("player.recap.skip")) + '</div>';
    els.plRecap.classList.add("on");
    P.recapT = setTimeout(function(){ closeRecap(false); }, 6000);
  };
  var fromTitle = function(){
    if(!m.imdbId || !App.meta.title) return null;
    return App.meta.title("series", m.imdbId).then(function(t){
      var vs = ((t && t.videos) || []).filter(function(x){ return Number(x.season) === Number(m.season) - 1 && x.overview; });
      var last = vs.length ? vs[vs.length - 1] : null;
      return last ? last.overview : "";
    });
  };
  var p = null;
  if(m.tmdbId && App.meta.season){
    p = App.meta.season(m.tmdbId, Number(m.season) - 1).then(function(s){
      return (s && s.overview) ? s.overview : fromTitle();
    });
  } else p = fromTitle();
  if(p && p.then) p.then(function(txt){ done(txt ? String(txt).slice(0, 420) : ""); }).catch(function(){});
}

/* ================= Barra de controles (siempre visible con el OSD) ================= */
var SVG = {
  rw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  ff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 4l11 8-11 8z"/><rect x="17" y="4" width="3" height="16" rx="1"/></svg>',
  fsIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fsOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
};
function nextLabel(o){
  var m = (o && o.meta) || {};
  if(m.episode !== undefined && m.episode !== null && !isNaN(Number(m.episode))) return App.t("player.v2.nextEp", { ep: "E" + pad2(Number(m.episode) + 1) });
  return App.t("player.ctl.next");
}
/* it: {id, grp:"l"|"r", ic (svg|texto), txt (texto del botón), label (acción), run, keep, more (va al menú ···)} */
function allItems(){
  var o = P.opts || {}, live = !!o.live, L = [];
  function add(it, show){ if(show === false) return; L.push(it); }
  add({ id: "rw", grp: "l", ic: SVG.rw, label: App.t("player.ctl.rw"), run: function(){ seekBy(-10); }, keep: true }, !live);
  add({ id: "pp", grp: "l", ic: P.paused ? SVG.play : SVG.pause, label: App.t("player.ctl.playpause"), run: togglePause, keep: true, main: true });
  add({ id: "ff", grp: "l", ic: SVG.ff, label: App.t("player.ctl.ff"), run: function(){ seekBy(10); }, keep: true }, !live);
  add({ id: "next", grp: "l", ic: SVG.next, txt: nextLabel(o), label: App.t("player.ctl.next"), run: function(){ goNext(); } }, !!o.next && !live);
  add({ id: "audio", grp: "r", txt: App.t("player.ctl.audio"), label: App.t("player.ctl.audio"), run: audioMenu });
  add({ id: "subs", grp: "r", txt: App.t("player.ctl.subs"), label: App.t("player.ctl.subs"), run: subMenu });
  add({ id: "speed", grp: "r", txt: App.t("player.v2.speed", { v: P.speed || 1 }), label: App.t("player.ctl.speed"), run: speedMenu }, !live);
  var cmp = !App.isTizen() && document.body.classList.contains("mobile");   // móvil: lo secundario va al menú ···
  add({ id: "zoom", grp: "r", txt: App.t("player.v2.picture"), label: App.t("player.ctl.zoom"), run: zoomMenu, more: cmp });
  add({ id: "sleep", grp: "r", txt: App.t("player.v2.sleepIn"), label: App.t("player.ctl.sleep"), run: sleepMenu, more: cmp });
  add({ id: "info", grp: "r", ic: "i", sq: true, label: App.t("player.ctl.info"), run: infoPanel, more: cmp });
  add({ id: "fs", grp: "r", ic: fsEl() ? SVG.fsOut : SVG.fsIn, sq: true, label: App.t(fsEl() ? "player.ctl.fsExit" : "player.ctl.fs"), run: toggleFs },
    !App.isTizen() && fsSupported());
  add({ id: "replay", more: true, label: App.t("player.ctl.replay"), run: function(){
    if(!P.started) return;
    P.engine.seek(Math.max(0, curTime() - 10));
    if(P.paused) togglePause();
    showOsd();
  } }, !live);
  add({ id: "subdelay", more: true, label: App.t("player.ctl.subdelay"), run: subDelayMenu }, !live);
  add({ id: "close", more: true, label: App.t("player.ctl.close"), run: stop });
  return L;
}
function barItems(){
  var all = allItems(), bar = all.filter(function(x){ return !x.more; }), more = all.filter(function(x){ return x.more; });
  if(more.length) bar.push({ id: "more", grp: "r", ic: "···", sq: true, label: App.t("player.v2.more"), run: function(){ moreMenu(more); } });
  return bar;
}
function moreMenu(more){
  App.ui.menu(App.t("player.v2.more"), more.map(function(it){ return { label: it.label, value: it.id }; })).then(function(v){
    if(v === null || !P.active) return;
    var it = more.filter(function(x){ return x.id === v; })[0];
    if(it) it.run();
  });
}
function btnHtml(it, foc){
  var cls = "pl-b" + (it.main ? " main" : "") + (it.sq ? " sq" : "") + (it.ic && it.txt ? " ictxt" : "") + (!it.ic ? " txt" : "") + (foc ? " focused" : "");
  var inner = (it.ic ? (it.ic.charAt(0) === "<" ? '<span class="pl-bi">' + it.ic + '</span>' : '<span class="pl-bt">' + App.esc(it.ic) + '</span>') : "") +
    (it.txt ? '<span class="pl-bx">' + App.esc(it.txt) + '</span>' : "");
  return '<button class="' + cls + '" aria-label="' + App.esc(it.label) + '">' + inner + '</button>';
}
function renderBar(){
  if(!els || !els.plPanel || !P.opts) return;
  var items = P.barItems = barItems();
  var idx = -1;
  items.forEach(function(it, i){ if(it.id === P.ctlId) idx = i; });
  if(idx < 0){ idx = 0; items.forEach(function(it, i){ if(it.id === "pp") idx = i; }); P.ctlId = items[idx] ? items[idx].id : "pp"; }
  var l = "", r = "";
  items.forEach(function(it, i){ var h = btnHtml(it, i === idx && !!P.barActive); if(it.grp === "l") l += h; else r += h; });
  els.plPanel.innerHTML = '<div class="pl-grp">' + l + '</div><div class="pl-grp">' + r + '</div>';
}
function barKey(k){
  var items = P.barItems || [], idx = 0;
  items.forEach(function(it, i){ if(it.id === P.ctlId) idx = i; });
  if(k === K.LEFT || k === K.RIGHT){
    idx = Math.max(0, Math.min(items.length - 1, idx + (k === K.RIGHT ? 1 : -1)));
    P.ctlId = items[idx].id; P.barTouched = true;
    showOsd();
    return true;
  }
  if(k === K.OK){
    var it = items[idx];
    P.barTouched = true;
    if(it){ it.run(); if(P.active){ if(it.keep) showOsd(); else renderBar(); } }
    return true;
  }
  return false;
}
function actions(){
  if(!P.active) return [];
  return allItems().map(function(it){ return { label: it.label, run: it.run }; });
}

/* ================= PC / móvil (ratón y táctil): pantalla completa, gestos, barra, atajos =================
 * Todo esto solo se activa fuera de la TV (!App.isTizen()); en Tizen no se registra ningún manejador.
 * Atajos de teclado en PC: Espacio = play/pausa, F = pantalla completa, M = silencio (main.js la convierte en K.MENU,
 * así que aquí K.MENU = silencio), ◄► ±10 s, ▼/Intro = barra de botones, Esc = atrás/cerrar. */
function fsEl(){ return document.fullscreenElement || document.webkitFullscreenElement || null; }
function fsSupported(){ var d = document.documentElement; return !!(d.requestFullscreen || d.webkitRequestFullscreen); }
function isTouchUi(){ var c = document.body.classList; return c.contains("touch") || c.contains("mobile"); }
function exitFs(){
  if(!fsEl()) return;
  try{ var r = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if(r && r.catch) r.catch(function(){}); }catch(e){}
}
/* Se pone en pantalla completa el documento (no solo #player) para que los menús/modales sigan visibles */
function toggleFs(){
  if(App.isTizen()) return;
  if(fsEl()){ exitFs(); return; }
  var d = document.documentElement, req = d.requestFullscreen || d.webkitRequestFullscreen;
  if(!req) return;
  function lock(){
    try{
      if(isTouchUi() && window.screen && screen.orientation && screen.orientation.lock){
        var q = screen.orientation.lock("landscape"); if(q && q.catch) q.catch(function(){});
      }
    }catch(e){}
  }
  try{ var pr = req.call(d); if(pr && pr.then) pr.then(lock, function(){}); else lock(); }catch(e){}
}
function toggleMute(){
  if(!els.plVideo || P.engineName !== "video") return;
  els.plVideo.muted = !els.plVideo.muted;
  App.hint(App.t(els.plVideo.muted ? "player.muted" : "player.unmuted"));
}
function onFsChange(){
  if(!fsEl()){ try{ if(window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); }catch(e){} }
  if(P.active) renderBar();
}
if(!App.isTizen()){
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
}

function flashSkip(dir){
  var el = els.plDt; if(!el) return;
  el.textContent = (dir < 0 ? "−10" : "+10");
  el.className = "pl-dt on " + (dir < 0 ? "l" : "r");
  clearTimeout(P._dtT);
  P._dtT = setTimeout(function(){ el.className = "pl-dt"; }, 550);
}
function scrubTo(bar, x){
  var r = bar.getBoundingClientRect();
  var ratio = r.width > 0 ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0;
  clearTimeout(P.seekT); P.seekT = null;
  P.seekTarget = Math.max(0, Math.min(Math.max(0, P.dur - 2), ratio * P.dur));
  els.plSeekTxt.textContent = App.fmtTime(P.seekTarget) + " / " + App.fmtTime(P.dur);
  els.plThumb.style.display = P.still ? "block" : "none";
  els.plSeek.classList.add("on");
  clearTimeout(P.osdT);
  updateUi();
}
function mouseMs(){ return 3000; }
function mouseHide(){
  if(!P.active) return;
  var hov = root.querySelector(".pl-b:hover,.pl-bar:hover,.pl-x:hover");
  if(hov){ P.osdT = setTimeout(mouseHide, 1500); return; }
  hideOsd();
}
function initPointer(){
  var dt = document.createElement("div"); dt.className = "pl-dt"; root.appendChild(dt); els.plDt = dt;
  var xb = document.createElement("button"); xb.className = "pl-x"; xb.setAttribute("aria-label", App.t("player.ctl.close"));
  xb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  els.plOsd.appendChild(xb);
  xb.addEventListener("click", function(){ stop(); });
  els.plSkip.addEventListener("click", function(){ doSkip(); });

  // botones de la barra: toque / clic
  els.plPanel.addEventListener("click", function(e){
    var btn = e.target.closest ? e.target.closest("button") : null;
    if(!btn || !P.active) return;
    var idx = Array.prototype.indexOf.call(els.plPanel.querySelectorAll("button"), btn);
    var it = (P.barItems || [])[idx];
    if(!it) return;
    P.ctlId = it.id; P.barTouched = true;
    it.run();
    if(P.active){ if(it.keep) showOsd(); else renderBar(); }
  });

  // barra de progreso: clic/toque y arrastre
  var bar = root.querySelector(".pl-bar"), scrub = null;
  bar.addEventListener("pointerdown", function(e){
    if(!P.active || !P.started || (P.opts && P.opts.live) || !(P.dur > 0)) return;
    if(e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    try{ bar.setPointerCapture(e.pointerId); }catch(er){}
    scrub = e.pointerId; scrubTo(bar, e.clientX);
  });
  bar.addEventListener("pointermove", function(e){ if(scrub === e.pointerId) scrubTo(bar, e.clientX); });
  function endScrub(e, commit){
    if(scrub !== e.pointerId) return;
    scrub = null;
    var target = P.seekTarget;
    els.plSeek.classList.remove("on");
    if(commit && P.engine && target !== null){ P.engine.seek(target); setTimeout(saveNow, 1500); }
    setTimeout(function(){ P.seekTarget = null; if(P.active) updateUi(); }, 450);
    if(P.active) showOsd(mouseMs());
  }
  bar.addEventListener("pointerup", function(e){ endScrub(e, true); });
  bar.addEventListener("pointercancel", function(e){ endScrub(e, false); });

  // toques / clics sobre el vídeo
  var down = null, tap = { timer: null, t: 0, x: 0 }, chain = { t: 0, dir: 0 };
  function ui(t){ return !!(t.closest && t.closest(".pl-b,.pl-bar,.pl-x,.pl-skip,.pl-recap,.pl-countdown")); }
  root.addEventListener("pointerdown", function(e){
    if(!P.active || (e.pointerType === "mouse" && e.button !== 0) || ui(e.target)){ down = null; return; }
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  root.addEventListener("pointercancel", function(){ down = null; });
  root.addEventListener("pointerup", function(e){
    if(!down || !P.active) return;
    var d = down; down = null;
    if(Math.abs(e.clientX - d.x) > 12 || Math.abs(e.clientY - d.y) > 12 || Date.now() - d.t > 500) return;
    if(P.recap || P.countdown) return;
    var touch = e.pointerType !== "mouse", now = Date.now(), w = root.clientWidth || 1;
    var dir = e.clientX < w / 3 ? -1 : e.clientX > w * 2 / 3 ? 1 : 0;
    function seekTap(dr){ if(P.opts && P.opts.live) return; flashSkip(dr); seekBy(dr * 10); chain.t = now; chain.dir = dr; }
    if(touch && dir && chain.dir === dir && now - chain.t < 550){ seekTap(dir); return; }   // toques seguidos siguen saltando
    if(tap.timer && now - tap.t < 320 && Math.abs(e.clientX - tap.x) < 90){
      clearTimeout(tap.timer); tap.timer = null;
      if(!touch) toggleFs();
      else if(dir) seekTap(dir);
      else togglePause();
      return;
    }
    tap.t = now; tap.x = e.clientX;
    tap.timer = setTimeout(function(){
      tap.timer = null;
      if(!P.active) return;
      if(touch){ if(osdVisible()) hideOsd(); else showOsd(); }
      else togglePause();
    }, 280);
  });

  // ratón: mostrar OSD al mover y ocultarlo (con el cursor) tras unos segundos
  var lx = -1, ly = -1;
  root.addEventListener("pointermove", function(e){
    if(!P.active || e.pointerType !== "mouse") return;
    if(Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) < 3) return;
    lx = e.clientX; ly = e.clientY;
    if(scrub !== null) return;
    if(!osdVisible()) showOsd(mouseMs());
    else if(!P.paused || (P.opts && P.opts.live)){ clearTimeout(P.osdT); P.osdT = setTimeout(mouseHide, mouseMs()); }
  });
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
      var rw = App.settings.get("resumeRewind") !== false ? 5 : 0;
      P._startAt = v ? Math.max(0, resume - rw) : 0;
      start(o, P._startAt);
    }
  });
}

function stop(){
  var o = P.opts;
  if(!App.isTizen()) exitFs();
  var closePos = (P.active && P.engine && P.started) ? curTime() : 0, closeDur = P.dur || 0;
  if(P.active) saveNow();
  clearTimers();
  closeEngine();
  clearSleep();
  closeRecap(true);
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
  emitState();
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

  // Tarjeta "resumen de la temporada anterior": cualquier tecla la salta
  if(P.recap){ closeRecap(false); return true; }

  var vis = osdVisible();

  // PC: Espacio = play/pausa, F = pantalla completa, M (llega como K.MENU) = silencio
  if(!App.isTizen()){
    if(k === 32){ if(P.started) togglePause(); return true; }
    if(k === 70){ toggleFs(); return true; }
    if(k === K.MENU){ toggleMute(); showOsd(); return true; }
  }

  if(k === K.STOP){ stop(); return true; }
  if(App.isBack(k)){ if(vis) hideOsd(); else stop(); return true; }

  // Números (directo)
  var d = App.digit(k);
  if(d >= 0){ if(o.onDigit) o.onDigit(d); showOsd(); return true; }

  if(o.live){
    if(k === K.CHUP || (k === K.UP && o.onChannel && !vis)){ if(o.onChannel) o.onChannel(1); showOsd(); return true; }
    if(k === K.CHDOWN || (k === K.DOWN && o.onChannel)){ if(o.onChannel) o.onChannel(-1); showOsd(); return true; }
  }

  switch(k){
    case K.OK:
      if(P.skipCur && (!vis || !P.barTouched) && doSkip()) return true;
      if(!vis || !P.barActive){ enterBar(); return true; }
      if(P.started && barKey(k)) return true;
      togglePause(); return true;
    case K.LEFT: case K.RIGHT:
      if(vis && P.barActive){ if(barKey(k)) return true; }
      seekBy((k === K.LEFT ? -1 : 1) * holdStep()); return true;
    case K.UP: if(vis) hideOsd(); else showOsd(); return true;
    case K.DOWN: enterBar(); return true;
    case K.PLAYPAUSE: togglePause(); return true;
    case K.PLAY: if(P.paused) togglePause(); else showOsd(); return true;
    case K.PAUSE: if(!P.paused) togglePause(); else showOsd(); return true;
    case K.RW: seekBy(-60); return true;
    case K.FF: seekBy(60); return true;
    case K.INFO: infoPanel(); return true;
    case K.NEXT: if(o.next) goNext(); else App.hint(App.t("player.noNext")); return true;
    case K.PREV: if(!o.live && P.started){ P.engine.seek(0); showOsd(); } return true;
    case K.GREEN: subMenu(); return true;
    case K.BLUE: speedMenu(); return true;
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
  current: function(){ return P.active && P.opts ? { key: P.opts.key, meta: P.opts.meta || {}, title: P.opts.title } : null; },
  status: statusObj,
  control: control,
  actions: actions
};

/* ================= Ajustes (grupo Reproducción) ================= */
App.settings.define("playerSpeed", 1);
App.settings.define("resumeRewind", true);
App.settings.define("skipIntroAuto", false);
if(App.settingsUI){
  App.settingsUI.add("settings.group.player", { id: "playerSpeed", type: "menu",
    label: function(){ return App.t("player.set.speed"); }, desc: function(){ return App.t("player.set.speed.desc"); },
    options: function(){ return SPEEDS.map(function(x){ return { label: x + "×", value: x }; }); } });
  App.settingsUI.add("settings.group.player", { id: "resumeRewind", type: "bool",
    label: function(){ return App.t("player.set.rewind"); }, desc: function(){ return App.t("player.set.rewind.desc"); } });
  App.settingsUI.add("settings.group.player", { id: "skipIntroAuto", type: "bool",
    label: function(){ return App.t("player.set.skipAuto"); }, desc: function(){ return App.t("player.set.skipAuto.desc"); } });
}

})();
