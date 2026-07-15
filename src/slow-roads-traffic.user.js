
// ==UserScript==
// @name         Slow Roads Traffic
// @namespace    local.slowroads.traffic
// @version      3.1
// @description  Advanced ambient AI traffic for slowroads.io: realistic traffic, quieter horns, collision shove, police, speed signs, UI settings, and safer nearby-car retention.
// @author       Franco
// @match        https://slowroads.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * KEYS (hold Shift):
 *   Shift+T  toggle traffic on/off
 *   Shift+[  fewer cars     Shift+]  more cars
 *   Shift+-  slower traffic Shift+=  faster traffic
 *   Shift+\  flip driving side (auto-detected from where you drive)
 *
 * v3.0: quieter/configurable audio, smoother path rebuilds, richer driver
 *       variation, player collision shove, pull-over behavior, police chases,
 *       speed limit signs, and an injected Misc settings panel.
 * v2.1: solid vehicles - traffic cars are displaced by contact every frame
 *       (pushed along or sideways), so the player can never occupy their
 *       space; collisions are silent (no crunch/flash/srTrafficHonkV4). Horn logic
 *       reworked with precise signed lane position: oncoming cars only srTrafficHonkV4
 *       when you are genuinely in THEIR lane, close, and closing fast.
 * v2.0: trucks, per-vehicle speed classes, overtaking with turn signals.
 */

(function () {
  'use strict';
  if (window.__slowRoadsTrafficAdvancedV3Running) return;
  window.__slowRoadsTrafficAdvancedV3Running = true;

  // ---------------------------------------------------------------- capture
  var srTrafficCapturedV4 = [];
  try {
    Object.defineProperty(Object.prototype, 'isMesh', {
      configurable: true,
      set(v) {
        Object.defineProperty(this, 'isMesh', { value: v, writable: true, configurable: true, enumerable: false });
        if (v === true && this && typeof this === 'object') {
          srTrafficCapturedV4.push(this);
          if (srTrafficCapturedV4.length > 40) srTrafficCapturedV4.shift();
        }
      },
      get() { return undefined; }
    });
  } catch (e) { /* trap failed; mod won't start */ }

  // ---------------------------------------------------------------- state
  var srTrafficStateV4 = {
    scene: null, three: null, path: null, cars: [], signs: [], player: null,
    playerV: 0, playerDir: 1, prevPlayerS: null, pv: { x: 0, z: 0, t: 0 },
    lastPathBuild: 0, started: false, hud: null, hudTimer: 0,
    audio: null, siren: null, ui: null, uiTimer: 0, lastSignBuild: 0, signLimit: null, signBase: null, signSpacing: null,
    nextSpawnAt: 0,
    chase: { active: false, coolT: 0, sirenT: 0, pullT: 0 },
  };

  var srTrafficCfgKeyV4 = 'x-traffic-mod-cfg';
  var srTrafficCfgV4 = Object.assign(
    {
      enabled: true,
      count: 12,
      speedKmh: 60,
      sideSign: 0,
      laneOffset: 1.62,
      hornVolume: 0.42,
      advancedAI: true,
      collisionAssist: true,
      policeEnabled: true,
      speedSignsEnabled: true,
      speedZonesEnabled: true,
      adaptTrafficToLimit: true,
      speedLimitKmh: 80,
      sirenVolume: 0.22,
      uiButton: true
    },
    (() => { try { return JSON.parse(localStorage.getItem(srTrafficCfgKeyV4)) || {}; } catch (e) { return {}; } })()
  );
  var srTrafficSaveCfgV4 = () => { try { localStorage.setItem(srTrafficCfgKeyV4, JSON.stringify(srTrafficCfgV4)); } catch (e) {} };

  var srTrafficCarColorsV4 = [0xb8433a, 0x3a5fb8, 0x3d3d42, 0xd8d3c8, 0x8a9a5b, 0x7a4a8a, 0xc47f2e, 0x2e6e5e];
  var srTrafficCabColorsV4 = [0xb8433a, 0x3a5fb8, 0x2e6e5e, 0xc47f2e, 0x3d3d42];
  var srTrafficClampV4 = (v, a, b) => Math.max(a, Math.min(b, v));
  var srTrafficLerpV4 = (a, b, t) => a + (b - a) * t;
  var srTrafficSmooth01V4 = t => { t = srTrafficClampV4(t, 0, 1); return t * t * (3 - 2 * t); };

  // speed classes: multiplier of srTrafficCfgV4.speedKmh
  var srTrafficClassesV4 = [
    { name: 'truck',  p: 0.22, mul: [0.55, 0.75], truck: true,  overtakes: false },
    { name: 'slow',   p: 0.22, mul: [0.70, 0.88], truck: false, overtakes: false },
    { name: 'normal', p: 0.36, mul: [0.88, 1.08], truck: false, overtakes: true  },
    { name: 'fast',   p: 0.20, mul: [1.10, 1.40], truck: false, overtakes: true  },
  ];
  function srTrafficPickClassV4() {
    var r = Math.random();
    for (var c of srTrafficClassesV4) { if (r < c.p) return c; r -= c.p; }
    return srTrafficClassesV4[2];
  }

  var srTrafficSpeedLimitsV4 = [60, 80, 100, 110, 130, 80, 100, 60, 110, 130];
  function srTrafficHash01V4(n) {
    var x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }
  function srTrafficZoneLimitAtV4(s) {
    if (!srTrafficCfgV4.speedZonesEnabled) return srTrafficCfgV4.speedLimitKmh;
    var srTrafficZoneLen = 620;
    var srTrafficZoneIdx = Math.max(0, Math.floor(s / srTrafficZoneLen));
    var srTrafficZoneOffset = Math.floor(srTrafficHash01V4(srTrafficZoneIdx + 31) * srTrafficSpeedLimitsV4.length);
    var srTrafficLimit = srTrafficSpeedLimitsV4[(srTrafficZoneIdx * 3 + srTrafficZoneOffset) % srTrafficSpeedLimitsV4.length];
    if (srTrafficZoneIdx > 0) {
      var srTrafficPrevOffset = Math.floor(srTrafficHash01V4(srTrafficZoneIdx + 30) * srTrafficSpeedLimitsV4.length);
      var srTrafficPrev = srTrafficSpeedLimitsV4[((srTrafficZoneIdx - 1) * 3 + srTrafficPrevOffset) % srTrafficSpeedLimitsV4.length];
      if (srTrafficLimit === srTrafficPrev) srTrafficLimit = srTrafficSpeedLimitsV4[(srTrafficZoneIdx * 5 + 2) % srTrafficSpeedLimitsV4.length];
    }
    return srTrafficLimit;
  }
  function srTrafficActiveLimitKmhV4(s) {
    return srTrafficCfgV4.speedZonesEnabled ? srTrafficZoneLimitAtV4(s) : srTrafficCfgV4.speedLimitKmh;
  }
  function srTrafficBaseSpeedKmhV4(s) {
    return srTrafficCfgV4.adaptTrafficToLimit ? srTrafficActiveLimitKmhV4(s) : srTrafficCfgV4.speedKmh;
  }

  // ---------------------------------------------------------------- harvest
  function srTrafficFindSceneV4() {
    for (var i = srTrafficCapturedV4.length - 1; i >= 0; i--) {
      var p = srTrafficCapturedV4[i], hops = 0;
      while (p && p.parent && hops++ < 60) p = p.parent;
      if (p && p.type === 'Scene') return p;
    }
    return null;
  }

  function srTrafficHarvestThreeV4(scene) {
    var t = {};
    var roadMesh = null, basicMatMesh = null;
    scene.traverse(o => {
      if (!roadMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.paintSolid) roadMesh = o;
      if (!basicMatMesh && o.material && o.material.type === 'MeshBasicMaterial') basicMatMesh = o;
    });
    if (!roadMesh || !basicMatMesh) return null;
    t.Mesh = roadMesh.constructor;
    t.BufferGeometry = roadMesh.geometry.constructor;
    t.BufferAttribute = roadMesh.geometry.attributes.position.constructor;
    t.Vector3 = roadMesh.position.constructor;
    t.MeshBasicMaterial = basicMatMesh.material.constructor;
    return t;
  }

  // ---------------------------------------------------------------- road path
  function srTrafficBuildPathV4(scene) {
    var segs = [];
    scene.traverse(o => {
      if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.paintSolid || !o.visible) return;
      var p = o.geometry.attributes.position;
      var ox = o.position.x, oy = o.position.y, oz = o.position.z;
      var rows = [];
      for (var i = 0; i < p.count / 2; i++) {
        var lx = p.getX(i * 2), ly = p.getY(i * 2), lz = p.getZ(i * 2);
        var rx = p.getX(i * 2 + 1), ry = p.getY(i * 2 + 1), rz = p.getZ(i * 2 + 1);
        if (lx === 0 && ly === 0 && lz === 0 && rx === 0 && ry === 0 && rz === 0) continue;
        var cx = (lx + rx) / 2 + ox, cy = (ly + ry) / 2 + oy, cz = (lz + rz) / 2 + oz;
        var w = Math.hypot(rx - lx, rz - lz);
        if (w < 3 || w > 25) continue;
        if (rows.length) {
          var pr = rows[rows.length - 1];
          var d = Math.hypot(cx - pr.x, cz - pr.z);
          if (d < 0.3) continue;
          if (d > 60) { segs.push(rows); rows = []; }
        }
        rows.push({ x: cx, y: cy, z: cz, w });
      }
      if (rows.length > 1) segs.push(rows);
    });
    if (!segs.length) return null;

    var D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    var used = new Array(segs.length).fill(false);
    var bi = 0; segs.forEach((s, i) => { if (s.length > segs[bi].length) bi = i; });
    var chain = segs[bi].slice(); used[bi] = true;
    var extended = true;
    while (extended) {
      extended = false;
      for (var i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        var seg = segs[i];
        var chainHead = chain[0];
        var chainTail = chain[chain.length - 1];
        var segHead = seg[0];
        var segTail = seg[seg.length - 1];
        var TH = 40;
        if (D(chainTail, segHead) < TH) { chain = chain.concat(seg); used[i] = true; extended = true; }
        else if (D(chainTail, segTail) < TH) { chain = chain.concat(seg.slice().reverse()); used[i] = true; extended = true; }
        else if (D(chainHead, segTail) < TH) { chain = seg.concat(chain); used[i] = true; extended = true; }
        else if (D(chainHead, segHead) < TH) { chain = seg.slice().reverse().concat(chain); used[i] = true; extended = true; }
      }
    }

    var pts = chain, n = pts.length;
    if (n < 10) return null;
    var sArr = new Float64Array(n);
    for (var i = 1; i < n; i++) sArr[i] = sArr[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return {
      pts, s: sArr, total: sArr[n - 1],
      reverse() {
        pts.reverse();
        sArr[0] = 0;
        for (var i = 1; i < n; i++) sArr[i] = sArr[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        this.total = sArr[n - 1];
      },
      sample(sv) {
        sv = Math.max(0, Math.min(this.total, sv));
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; (sArr[m] <= sv) ? lo = m : hi = m; }
        var t = (sv - sArr[lo]) / Math.max(1e-6, sArr[hi] - sArr[lo]);
        var a = pts[lo], b = pts[hi];
        var x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
        var i0 = Math.max(0, lo - 1), i1 = Math.min(n - 1, hi + 1);
        var tx = pts[i1].x - pts[i0].x, tz = pts[i1].z - pts[i0].z;
        var ty = pts[i1].y - pts[i0].y;
        var len = Math.hypot(tx, tz) || 1;
        var ds = Math.max(1e-6, sArr[i1] - sArr[i0]);
        return { x, y, z, tx: tx / len, tz: tz / len, slope: ty / ds, w: a.w };
      },
      project(x, z) {
        var best = Infinity, bIdx = 0;
        var srTrafficStepV4 = Math.max(1, Math.floor(n / 800));
        for (var i = 0; i < n; i += srTrafficStepV4) { var d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2; if (d < best) { best = d; bIdx = i; } }
        for (var i = Math.max(0, bIdx - srTrafficStepV4); i <= Math.min(n - 1, bIdx + srTrafficStepV4); i++) { var d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2; if (d < best) { best = d; bIdx = i; } }
        return { s: sArr[bIdx], dist: Math.sqrt(best) };
      }
    };
  }

  function srTrafficCurvatureAtV4(path, s) {
    var a = path.sample(Math.max(0, s - 8)), b = path.sample(s), c = path.sample(Math.min(path.total, s + 8));
    var v1x = b.x - a.x, v1z = b.z - a.z, v2x = c.x - b.x, v2z = c.z - b.z;
    var l1 = Math.hypot(v1x, v1z), l2 = Math.hypot(v2x, v2z);
    if (l1 < 1e-3 || l2 < 1e-3) return 0;
    return Math.abs(v1x * v2z - v1z * v2x) / (l1 * l2) / ((l1 + l2) / 2);
  }
  function srTrafficMaxCurvatureV4(path, s0, s1) {
    var m = 0;
    var srTrafficStepV4 = 20 * Math.sign(s1 - s0 || 1);
    for (var s = s0; (srTrafficStepV4 > 0 ? s <= s1 : s >= s1); s += srTrafficStepV4) m = Math.max(m, srTrafficCurvatureAtV4(path, s));
    return m;
  }

  function srTrafficLateralSignV4(path, x, z, s) {
    var smp = path.sample(s);
    var rx = -smp.tz, rz = smp.tx;
    return ((x - smp.x) * rx + (z - smp.z) * rz) >= 0 ? 1 : -1;
  }

  // precise projection: refines the coarse nearest-point s along the local
  // tangent, then measures signed lateral offset (meters, + = right of +s).
  // The coarse project() quantizes to path points (up to ~2.5m error on low
  // LOD chunks), which is what caused false "wrong lane" readings.
  function srTrafficProjectFineV4(path, x, z) {
    var s = path.project(x, z).s;
    for (var k = 0; k < 2; k++) {
      var sm = path.sample(s);
      s = Math.max(0, Math.min(path.total, s + (x - sm.x) * sm.tx + (z - sm.z) * sm.tz));
    }
    var sm = path.sample(s);
    var lat = (x - sm.x) * (-sm.tz) + (z - sm.z) * sm.tx;
    return { s, lat, dist: Math.hypot(x - sm.x, z - sm.z), w: sm.w };
  }

  function srTrafficProjectWorldV4(path, x, z) {
    var s = path.project(x, z).s;
    for (var k = 0; k < 2; k++) {
      var sm = path.sample(s);
      s = srTrafficClampV4(s + (x - sm.x) * sm.tx + (z - sm.z) * sm.tz, 0, path.total);
    }
    var sm = path.sample(s);
    return { s, dist: Math.hypot(x - sm.x, z - sm.z) };
  }

  function srTrafficProjectNearV4(path, x, z, oldS) {
    var coarse = path.project(x, z);
    if (!Number.isFinite(oldS)) return coarse;
    var bestS = srTrafficClampV4(oldS, 0, path.total);
    var bestD = Infinity;
    for (var ds = -34; ds <= 34; ds += 4) {
      var sv = srTrafficClampV4(oldS + ds, 0, path.total);
      var sm = path.sample(sv);
      var d = (sm.x - x) ** 2 + (sm.z - z) ** 2;
      if (d < bestD) { bestD = d; bestS = sv; }
    }
    var near = { s: bestS, dist: Math.sqrt(bestD) };
    return near.dist < coarse.dist + 2.5 ? near : coarse;
  }

  // ---------------------------------------------------------------- audio
  function srTrafficAudioCtxV4() {
    if (!srTrafficStateV4.audio) { try { srTrafficStateV4.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (srTrafficStateV4.audio && srTrafficStateV4.audio.state === 'suspended') { srTrafficStateV4.audio.resume().catch(() => {}); }
    return srTrafficStateV4.audio;
  }
  function srTrafficHonkV4(isTruck, dist, double) {
    var ctx = srTrafficAudioCtxV4(); if (!ctx || ctx.state !== 'running') return;
    var vol = Math.min(0.16, 7 / Math.max(18, dist)) * (isTruck ? 1.15 : 1) * srTrafficCfgV4.hornVolume;
    var freqs = isTruck ? [175, 220] : [349, 440];
    var beep = (t0, dur) => {
      var g = ctx.createGain(); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.setValueAtTime(vol, t0 + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      for (var f of freqs) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f;
        o.connect(g); o.start(t0); o.stop(t0 + dur);
      }
    };
    var t = ctx.currentTime;
    if (double) { beep(t, 0.18); beep(t + 0.26, 0.3); }
    else beep(t, isTruck ? 0.7 : 0.4);
  }
  function srTrafficSetSirenV4(active, intensity = 1) {
    var ctx = srTrafficAudioCtxV4();
    if (!active || !ctx || ctx.state !== 'running' || srTrafficCfgV4.sirenVolume <= 0) {
      if (srTrafficStateV4.siren) {
        try { srTrafficStateV4.siren.gain.gain.cancelScheduledValues(ctx ? ctx.currentTime : 0); srTrafficStateV4.siren.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08); } catch (e) {}
      }
      return;
    }
    if (!srTrafficStateV4.siren) {
      var gain = ctx.createGain();
      var oscA = ctx.createOscillator();
      var oscB = ctx.createOscillator();
      oscA.type = 'sine'; oscB.type = 'triangle';
      oscA.frequency.value = 610; oscB.frequency.value = 820;
      oscA.connect(gain); oscB.connect(gain); gain.connect(ctx.destination);
      gain.gain.value = 0.0001;
      oscA.start(); oscB.start();
      srTrafficStateV4.siren = { gain, oscA, oscB };
    }
    var t = ctx.currentTime;
    var wail = (Math.sin(t * 7.2) + 1) / 2;
    srTrafficStateV4.siren.oscA.frequency.setTargetAtTime(560 + wail * 220, t, 0.05);
    srTrafficStateV4.siren.oscB.frequency.setTargetAtTime(780 - wail * 160, t, 0.05);
    srTrafficStateV4.siren.gain.gain.setTargetAtTime(srTrafficClampV4(srTrafficCfgV4.sirenVolume * intensity, 0, 0.14), t, 0.08);
  }
  // resume audio on first real user gesture
  for (var ev of ['pointerdown', 'keydown']) {
    window.addEventListener(ev, () => { if (srTrafficStateV4.audio && srTrafficStateV4.audio.state === 'suspended') srTrafficStateV4.audio.resume().catch(() => {}); }, { capture: true, passive: true });
  }

  // ---------------------------------------------------------------- vehicle visuals
  // material array indices: 0 body, 1 dark, 2 window, 3 head, 4 tail, 5 blinkL, 6 blinkR, 7 trailer
  var srTrafficMatsV4 = { body: {} };
  var srTrafficCarGeoV4 = null, srTrafficTruckGeoV4 = null, srTrafficSignGeoV4 = null;

  function srTrafficBuildGeoV4(boxes) {
    var t = srTrafficStateV4.three;
    var pos = [], groups = [];
    var cursor = 0;
    boxes.sort((a, b) => a.g - b.g);
    var curG = -1, start = 0;
    for (var b of boxes) {
      if (b.g !== curG) { if (curG >= 0) groups.push({ start, count: cursor - start, materialIndex: curG }); curG = b.g; start = cursor; }
      var { cx, cy, cz, w, h, d } = b;
      var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      var q = (a, b2, c2, d2) => { pos.push(...a, ...b2, ...c2, ...a, ...c2, ...d2); cursor += 6; };
      q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
      q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
      q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
      q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
      q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    }
    groups.push({ start, count: cursor - start, materialIndex: curG });
    var geo = new t.BufferGeometry();
    geo.setAttribute('position', new t.BufferAttribute(new Float32Array(pos), 3));
    groups.forEach(g => geo.addGroup(g.start, g.count, g.materialIndex));
    geo.computeBoundingSphere();
    return geo;
  }

  function srTrafficBuildSignGeoV4(limit = 80) {
    var pos = [], groups = [];
    var cursor = 0, curG = -1, start = 0;
    var begin = g => {
      if (g === curG) return;
      if (curG >= 0) groups.push({ start, count: cursor - start, materialIndex: curG });
      curG = g; start = cursor;
    };
    var tri = (g, a, b, c) => { begin(g); pos.push(...a, ...b, ...c); cursor += 3; };
    var box = (g, cx, cy, cz, w, h, d) => {
      begin(g);
      var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      var q = (a, b, c, d2) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d2); cursor += 6; };
      q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
      q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
      q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
      q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
      q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    };
    var disk = (g, r, z, y = 2.75) => {
      var n = 36;
      for (var i = 0; i < n; i++) {
        var a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        tri(g, [0, y, z], [Math.cos(a0) * r, y + Math.sin(a0) * r, z], [Math.cos(a1) * r, y + Math.sin(a1) * r, z]);
      }
    };
    box(2, 0, 1.35, 0, 0.08, 2.7, 0.08);       // post
    disk(1, 0.68, 0.065);                       // red ring
    disk(0, 0.50, 0.095);                       // white center, slightly in front
    // Seven-segment speed numerals; avoids relying on unavailable font/text classes.
    var digits = String(srTrafficClampV4(Math.round(limit / 5) * 5, 30, 130));
    var maps = {
      0: 'abcfed', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
      5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd'
    };
    var width = digits.length === 3 ? 0.24 : 0.34;
    var gap = digits.length === 3 ? 0.03 : 0.06;
    var total = digits.length * width + (digits.length - 1) * gap;
    var seg = (x, y, w, h) => box(3, x, y, 0.145, w, h, 0.075);
    for (var i = 0; i < digits.length; i++) {
      var x = -total / 2 + width / 2 + i * (width + gap);
      var on = maps[digits[i]] || maps[0];
      var hw = width * 0.62, vx = width * 0.42, th = 0.045;
      if (on.includes('a')) seg(x, 2.99, hw, th);
      if (on.includes('g')) seg(x, 2.75, hw, th);
      if (on.includes('d')) seg(x, 2.51, hw, th);
      if (on.includes('f')) seg(x - vx, 2.87, th, 0.22);
      if (on.includes('b')) seg(x + vx, 2.87, th, 0.22);
      if (on.includes('e')) seg(x - vx, 2.63, th, 0.22);
      if (on.includes('c')) seg(x + vx, 2.63, th, 0.22);
    }
    if (curG >= 0) groups.push({ start, count: cursor - start, materialIndex: curG });
    var geo = new srTrafficStateV4.three.BufferGeometry();
    geo.setAttribute('position', new srTrafficStateV4.three.BufferAttribute(new Float32Array(pos), 3));
    groups.forEach(g => geo.addGroup(g.start, g.count, g.materialIndex));
    geo.computeBoundingSphere();
    return geo;
  }

  function srTrafficInitVisualsV4() {
    var t = srTrafficStateV4.three;
    srTrafficMatsV4.dark = new t.MeshBasicMaterial({ color: 0x141416 });
    srTrafficMatsV4.win = new t.MeshBasicMaterial({ color: 0x2a3340 });
    srTrafficMatsV4.head = new t.MeshBasicMaterial({ color: 0xfff6d8, fog: false });
    srTrafficMatsV4.tail = new t.MeshBasicMaterial({ color: 0x6e1414, fog: false });
    srTrafficMatsV4.tailBright = new t.MeshBasicMaterial({ color: 0xff2020, fog: false });
    srTrafficMatsV4.amberDim = new t.MeshBasicMaterial({ color: 0x7a5210, fog: false });
    srTrafficMatsV4.amberOn = new t.MeshBasicMaterial({ color: 0xffb020, fog: false });
    srTrafficMatsV4.trailer = new t.MeshBasicMaterial({ color: 0xcfcdc6 });
    srTrafficMatsV4.policeWhite = new t.MeshBasicMaterial({ color: 0xf2f4f7 });
    srTrafficMatsV4.policeDark = new t.MeshBasicMaterial({ color: 0x111217 });
    srTrafficMatsV4.policeBlue = new t.MeshBasicMaterial({ color: 0x205cff, fog: false });
    srTrafficMatsV4.policeRed = new t.MeshBasicMaterial({ color: 0xff2020, fog: false });
    srTrafficMatsV4.signWhite = new t.MeshBasicMaterial({ color: 0xf4f4ee, fog: false, side: 2 });
    srTrafficMatsV4.signRed = new t.MeshBasicMaterial({ color: 0xb51d22, fog: false, side: 2 });
    srTrafficMatsV4.signPost = new t.MeshBasicMaterial({ color: 0x707070 });
    srTrafficMatsV4.signBlack = new t.MeshBasicMaterial({ color: 0x111111, fog: false, side: 2 });

    // ---- car (front = +Z, left = +X) ----
    var car = [];
    var B = (g, cx, cy, cz, w, h, d) => car.push({ g, cx, cy, cz, w, h, d });
    B(0, 0, 0.55, 0.1, 1.74, 0.5, 4.15);
    B(0, 0, 0.92, -0.35, 1.56, 0.3, 2.4);
    B(1, -0.72, 0.3, 1.32, 0.24, 0.6, 0.62);
    B(1, 0.72, 0.3, 1.32, 0.24, 0.6, 0.62);
    B(1, -0.72, 0.3, -1.32, 0.24, 0.6, 0.62);
    B(1, 0.72, 0.3, -1.32, 0.24, 0.6, 0.62);
    B(2, 0, 1.22, -0.4, 1.46, 0.36, 2.05);
    B(3, -0.45, 0.62, 2.09, 0.3, 0.14, 0.08);
    B(3, 0.45, 0.62, 2.09, 0.3, 0.14, 0.08);
    B(4, -0.45, 0.62, -2.09, 0.3, 0.14, 0.08);
    B(4, 0.45, 0.62, -2.09, 0.3, 0.14, 0.08);
    B(5, 0.76, 0.62, 1.98, 0.14, 0.12, 0.3);   // blinker left front (+X)
    B(5, 0.76, 0.62, -1.98, 0.14, 0.12, 0.3);  // blinker left rear
    B(6, -0.76, 0.62, 1.98, 0.14, 0.12, 0.3);  // blinker right front (-X)
    B(6, -0.76, 0.62, -1.98, 0.14, 0.12, 0.3); // blinker right rear
    srTrafficCarGeoV4 = srTrafficBuildGeoV4(car);

    // ---- truck: cab + box trailer, total ~9.6m (front = +Z) ----
    var tr = [];
    var TB = (g, cx, cy, cz, w, h, d) => tr.push({ g, cx, cy, cz, w, h, d });
    TB(0, 0, 1.05, 3.55, 2.1, 1.5, 2.1);        // cab
    TB(2, 0, 1.62, 3.85, 1.9, 0.55, 1.0);       // cab glass
    TB(7, 0, 1.55, -1.15, 2.3, 2.5, 6.9);       // trailer box
    TB(1, -0.85, 0.42, 3.6, 0.3, 0.84, 0.84);   // wheels
    TB(1, 0.85, 0.42, 3.6, 0.3, 0.84, 0.84);
    TB(1, -0.85, 0.42, -2.6, 0.3, 0.84, 0.84);
    TB(1, 0.85, 0.42, -2.6, 0.3, 0.84, 0.84);
    TB(1, -0.85, 0.42, -3.6, 0.3, 0.84, 0.84);
    TB(1, 0.85, 0.42, -3.6, 0.3, 0.84, 0.84);
    TB(3, -0.6, 0.85, 4.62, 0.36, 0.16, 0.08);  // headlights
    TB(3, 0.6, 0.85, 4.62, 0.36, 0.16, 0.08);
    TB(4, -0.7, 0.7, -4.62, 0.4, 0.16, 0.08);   // taillights
    TB(4, 0.7, 0.7, -4.62, 0.4, 0.16, 0.08);
    TB(5, 0.98, 0.85, 4.5, 0.14, 0.14, 0.3);    // blinkers L
    TB(5, 1.12, 0.7, -4.5, 0.14, 0.14, 0.3);
    TB(6, -0.98, 0.85, 4.5, 0.14, 0.14, 0.3);   // blinkers R
    TB(6, -1.12, 0.7, -4.5, 0.14, 0.14, 0.3);
    srTrafficTruckGeoV4 = srTrafficBuildGeoV4(tr);
    srTrafficSignGeoV4 = srTrafficBuildSignGeoV4(srTrafficCfgV4.speedLimitKmh);
  }

  var srTrafficBodyMatV4 = c => srTrafficMatsV4.body[c] || (srTrafficMatsV4.body[c] = new srTrafficStateV4.three.MeshBasicMaterial({ color: c }));
  function srTrafficMakeVehicleMeshV4(isTruck, isPolice) {
    if (isPolice) {
      return new srTrafficStateV4.three.Mesh(srTrafficCarGeoV4, [srTrafficMatsV4.policeWhite, srTrafficMatsV4.policeDark, srTrafficMatsV4.win, srTrafficMatsV4.head, srTrafficMatsV4.tail, srTrafficMatsV4.policeBlue, srTrafficMatsV4.policeRed, srTrafficMatsV4.trailer]);
    }
    var color = isTruck ? srTrafficCabColorsV4[Math.floor(Math.random() * srTrafficCabColorsV4.length)]
                          : srTrafficCarColorsV4[Math.floor(Math.random() * srTrafficCarColorsV4.length)];
    var matArr = [srTrafficBodyMatV4(color), srTrafficMatsV4.dark, srTrafficMatsV4.win, srTrafficMatsV4.head, srTrafficMatsV4.tail, srTrafficMatsV4.amberDim, srTrafficMatsV4.amberDim, srTrafficMatsV4.trailer];
    return new srTrafficStateV4.three.Mesh(isTruck ? srTrafficTruckGeoV4 : srTrafficCarGeoV4, matArr);
  }

  // ---------------------------------------------------------------- traffic core
  function srTrafficSpawnVehicleV4(s, dir, klass) {
    var base = srTrafficBaseSpeedKmhV4(s) / 3.6;
    var mul = klass.mul[0] + Math.random() * (klass.mul[1] - klass.mul[0]);
    var isPolice = !!klass.police;
    var car = {
      s, dir,
      v: base * mul, vBase: base * mul, speedMul: mul,
      klass, isTruck: klass.truck, police: isPolice,
      len: klass.truck ? 9.6 : 4.15,
      halfW: klass.truck ? 1.15 : 0.87,
      mesh: srTrafficMakeVehicleMeshV4(klass.truck, isPolice),
      x: 0, y: null, z: 0, yaw: 0,
      laneCur: 1, laneTarget: 1,          // +1 own lane, -1 opposite lane
      phase: 'cruise',                    // cruise | signal | pass | return
      phaseT: 0, cooldown: Math.random() * 5,
      blinker: 0,                         // 0 none, +1 left, -1 right, 2 hazards
      blinkPhase: Math.random() * 10,
      bumpT: 0, honkT: 0, passTarget: null,
      jolt: 0, joltDir: 1,
      aggression: isPolice ? 0.95 : (0.25 + Math.random() * 0.75),
      reaction: isPolice ? 0.28 : (0.45 + Math.random() * 0.85),
      gapMul: isPolice ? 0.75 : (0.9 + Math.random() * 0.7),
      speedBiasT: Math.random() * 20,
      pullOverT: 0,
      chaseT: 0,
      dismissAfterPass: false,
      lostPathT: 0,
      retireT: 0,
    };
    srTrafficStateV4.scene.add(car.mesh);
    srTrafficStateV4.cars.push(car);
    if (srTrafficStateV4.path) srTrafficUpdateCarTransformV4(car, srTrafficStateV4.path, performance.now()); // init world pos so rebuilds don't cull it
    return car;
  }

  function srTrafficLaneWorldOffsetV4(car, smp) {
    var side = srTrafficCfgV4.sideSign * car.dir;             // own-lane side relative to +s right vector
    var off = Math.min(srTrafficCfgV4.laneOffset, Math.max(1.1, smp.w / 4));
    return off * side * car.laneCur + car.jolt * car.joltDir;
  }

  function srTrafficUpdateCarTransformV4(car, path, now) {
    if (car.lockUntil && now < car.lockUntil) {
      car.mesh.position.set(car.x, car.y || car.mesh.position.y || 0, car.z);
      car.mesh.rotation.order = 'YXZ';
      car.mesh.rotation.y = car.yaw || car.mesh.rotation.y || 0;
      return;
    }
    car.lockUntil = 0;
    var smp = path.sample(car.s);
    var rx = -smp.tz, rz = smp.tx;
    var off = srTrafficLaneWorldOffsetV4(car, smp);
    car.x = smp.x + rx * off; car.z = smp.z + rz * off;
    var yA = path.sample(srTrafficClampV4(car.s - 3, 0, path.total)).y;
    var yB = smp.y;
    var yC = path.sample(srTrafficClampV4(car.s + 3, 0, path.total)).y;
    var lowY = Math.min(yA, yB, yC);
    var highY = Math.max(yA, yB, yC);
    var roadY = yA + yB + yC - lowY - highY; // median filters one bad chunk sample
    if (!Number.isFinite(roadY)) roadY = smp.y;
    car.y = roadY + 0.05;
    car.mesh.position.set(car.x, car.y, car.z);
    car.mesh.rotation.order = 'YXZ';
    // heading with a slight yaw during lane changes for realism
    var hx = smp.tx * car.dir, hz = smp.tz * car.dir;
    if (Math.abs(car.laneTarget - car.laneCur) > 0.05) {
      var latVel = (car.laneTarget - car.laneCur) * 1.2 * srTrafficCfgV4.sideSign * car.dir; // world-lateral speed sign
      var k = Math.min(0.25, Math.abs(latVel) * 0.15) * Math.sign(latVel);
      hx += rx * k * car.dir; hz += rz * k * car.dir;
      var n = Math.hypot(hx, hz) || 1; hx /= n; hz /= n;
    }
    car.yaw = Math.atan2(hx, hz);
    car.mesh.rotation.y = car.yaw;
    car.mesh.rotation.x = -Math.atan(smp.slope * car.dir);
    // blinkers / police lights
    var blinkOn = ((now * 0.0025 + car.blinkPhase) % 1) < 0.5;
    var m = car.mesh.material;
    if (car.police && car.chaseT > 0) {
      var swap = ((now * 0.008 + car.blinkPhase) % 1) < 0.5;
      m[5] = swap ? srTrafficMatsV4.policeBlue : srTrafficMatsV4.policeRed;
      m[6] = swap ? srTrafficMatsV4.policeRed : srTrafficMatsV4.policeBlue;
    } else if (car.blinker === 2) { m[5] = blinkOn ? srTrafficMatsV4.amberOn : srTrafficMatsV4.amberDim; m[6] = m[5]; }
    else if (car.blinker === 1) { m[5] = blinkOn ? srTrafficMatsV4.amberOn : srTrafficMatsV4.amberDim; m[6] = srTrafficMatsV4.amberDim; }
    else if (car.blinker === -1) { m[6] = blinkOn ? srTrafficMatsV4.amberOn : srTrafficMatsV4.amberDim; m[5] = srTrafficMatsV4.amberDim; }
    else if (!car.police) { m[5] = srTrafficMatsV4.amberDim; m[6] = srTrafficMatsV4.amberDim; }
    else { m[5] = srTrafficMatsV4.policeBlue; m[6] = srTrafficMatsV4.policeRed; }
  }
  var setBrakeLight = (car, on) => { car.mesh.material[4] = on ? srTrafficMatsV4.tailBright : srTrafficMatsV4.tail; };

  // lane bucket helpers: physical lane = own(+1)/opposite(-1) relative to THIS car's dir
  var srTrafficInOwnLaneV4 = c => c.laneCur > 0.4;
  var srTrafficInOppLaneV4 = c => c.laneCur < -0.4;

  function srTrafficStepV4(dt, path, playerS, playerLatSign, playerPos, now) {
    for (var car of srTrafficStateV4.cars) {
      car.phaseT += dt; car.cooldown -= dt; car.bumpT -= dt; car.honkT -= dt;
      car.pullOverT -= dt; car.chaseT -= dt;
      car.speedBiasT += dt;
      car.jolt *= Math.pow(0.05, dt); // decay sideswipe jolt
      if (car.lockUntil && now < car.lockUntil) continue;
      car.lockUntil = 0;
      if (!car.police && car.pullOverT <= 0) {
        var zoneBase = srTrafficBaseSpeedKmhV4(car.s) / 3.6;
        car.vBase = srTrafficLerpV4(car.vBase, zoneBase * (car.speedMul || 1), srTrafficClampV4(dt * 0.18, 0, 1));
      }

      // --- curvature limit
      var lookS = car.s + car.dir * Math.min(40, car.v * 2.5);
      var curv = Math.max(srTrafficCurvatureAtV4(path, car.s), srTrafficCurvatureAtV4(path, lookS));
      var vCurve = Math.sqrt(2.8 / Math.max(curv, 1e-4));
      var trafficBreathing = srTrafficCfgV4.advancedAI && !car.police ? 1 + Math.sin(car.speedBiasT * 0.23 + car.blinkPhase) * 0.045 : 1;
      var vTarget = Math.min(car.vBase * trafficBreathing, vCurve);
      if (car.police && srTrafficStateV4.chase.active) {
        car.chaseT = 1;
        var base = srTrafficBaseSpeedKmhV4(playerS) / 3.6;
        vTarget = Math.min(Math.max(base * 1.25, srTrafficStateV4.playerV + 5), base * 1.9);
        var policeGap = (playerS - car.s) * car.dir;
        car.phase = 'cruise';
        car.laneTarget = 1;
        car.passTarget = null;
        if (policeGap < 16) {
          car.s = playerS - car.dir * 16;
          car.v = Math.min(car.v, Math.max(0, srTrafficStateV4.playerV));
          vTarget = Math.max(0, srTrafficStateV4.playerV);
        } else if (policeGap < 32) {
          vTarget = Math.min(vTarget, Math.max(0, srTrafficStateV4.playerV + (policeGap - 18) * 0.25));
        }
      }
      if (car.bumpT > 0) vTarget = Math.min(car.vBase * 1.25, vTarget + 6); // escape burst after being hit
      if (car.pullOverT > 0) {
        car.phase = 'cruise';
        car.laneTarget = 1.62;
        car.blinker = 2;
        vTarget = Math.min(vTarget, Math.max(0, car.vBase * 0.22 - car.phaseT * 0.15));
      }

      // --- find leader in my current physical lane (same-direction cars)
      var gap = Infinity, leaderV = 0, leader = null;
      for (var o of srTrafficStateV4.cars) {
        if (o === car || o.dir !== car.dir) continue;
        var sameLane = (srTrafficInOwnLaneV4(car) && srTrafficInOwnLaneV4(o)) || (srTrafficInOppLaneV4(car) && srTrafficInOppLaneV4(o)) ||
                         (!srTrafficInOwnLaneV4(car) && !srTrafficInOppLaneV4(car)); // mid-change: consider all
        if (!sameLane) continue;
        var d = (o.s - car.s) * car.dir - (o.len + car.len) / 2;
        // include overlapping vehicles (d <= 0) so cars separate instead of merging
        if ((o.s - car.s) * car.dir > 0 && d < gap) { gap = d; leaderV = o.v; leader = o; }
      }
      // player as leader (same travel direction, same physical lane)
      var myLaneSign = srTrafficCfgV4.sideSign * car.dir * (srTrafficInOppLaneV4(car) ? -1 : 1);
      var pd = (playerS - car.s) * car.dir - (car.len / 2 + 2);
      var playerInMyLane = playerLatSign === myLaneSign;
      var leaderIsPlayer = false;
      if (srTrafficStateV4.playerDir === car.dir && pd > 0.5 && pd < gap && playerInMyLane) {
        gap = pd; leaderV = srTrafficStateV4.playerV; leader = null; leaderIsPlayer = true;
      }
      var playerBeside = Math.abs((playerS - car.s) * car.dir) < (car.len / 2 + 8);
      var targetLaneSign = srTrafficCfgV4.sideSign * car.dir * (car.laneTarget < 0 ? -1 : 1);
      if (!car.police && playerBeside && playerLatSign === targetLaneSign && Math.abs(playerPos.x - car.x) + Math.abs(playerPos.z - car.z) < 18) {
        car.phase = 'return';
        car.laneTarget = 1;
        car.blinker = (srTrafficCfgV4.sideSign === -1) ? 1 : -1;
        vTarget = Math.min(vTarget, Math.max(0, srTrafficStateV4.playerV - 1.5));
      }

      // --- overtake state machine
      if (car.phase === 'cruise') {
        var passLook = srTrafficCfgV4.advancedAI ? srTrafficLerpV4(1.45, 2.15, car.aggression) : 1.8;
        var behindTruck = leader && leader.isTruck;
        var passMargin = behindTruck ? -0.8 : (srTrafficCfgV4.advancedAI ? srTrafficLerpV4(4.5, 2.0, car.aggression) : 3);
        var passGap = behindTruck ? Math.max(38, car.v * 2.7) : Math.max(25, car.v * passLook);
        var wantsPass = !car.police && car.klass.overtakes && car.cooldown <= 0 && srTrafficInOwnLaneV4(car) && car.pullOverT <= 0 &&
          gap < passGap && leaderV < car.vBase - passMargin && (leader || leaderIsPlayer);
        if (wantsPass && srTrafficOvertakeSafeV4(car, path, playerS, playerLatSign, leaderV, gap, behindTruck)) {
          car.phase = 'signal'; car.phaseT = 0;
          car.blinker = (srTrafficCfgV4.sideSign === -1) ? -1 : 1; // toward road center
          car.passTarget = leaderIsPlayer ? 'player' : leader;
        }
      } else if (car.phase === 'signal') {
        if (car.phaseT > 1.1) { car.phase = 'pass'; car.phaseT = 0; car.laneTarget = -1; }
      } else if (car.phase === 'pass') {
        var truckPass = car.passTarget && car.passTarget !== 'player' && car.passTarget.isTruck;
        vTarget = Math.min(car.vBase * (truckPass ? 1.32 : 1.18), vCurve);
        // abort if oncoming danger appears
        if (!srTrafficOncomingClearV4(car, path, playerS, playerLatSign, 4.5)) {
          car.phase = 'return'; car.phaseT = 0; car.laneTarget = 1;
          car.blinker = (srTrafficCfgV4.sideSign === -1) ? 1 : -1;
          vTarget = Math.min(vTarget, leaderV - 1); // tuck back in
        } else {
          var tS = car.passTarget === 'player' ? playerS : (car.passTarget && car.passTarget.s);
          var tLen = car.passTarget === 'player' ? 3 : (car.passTarget ? car.passTarget.len : 4);
          var passed = tS === undefined || car.passTarget === null ? true :
            (car.s - tS) * car.dir > (car.len + tLen) / 2 + 10;
          if (passed) { car.phase = 'return'; car.phaseT = 0; car.laneTarget = 1; car.blinker = (srTrafficCfgV4.sideSign === -1) ? 1 : -1; }
        }
      } else if (car.phase === 'return') {
        if (Math.abs(car.laneCur - 1) < 0.08) { car.phase = 'cruise'; car.blinker = 0; car.cooldown = 8 + Math.random() * 8; car.passTarget = null; }
      }
      if (car.bumpT > 0 || car.pullOverT > 0) car.blinker = 2; // hazards while rattled / yielding
      else if (car.phase === 'cruise' && car.blinker === 2) car.blinker = 0;

      // lane srTrafficLerpV4
      var lr = 1.4 * dt;
      car.laneCur += Math.max(-lr, Math.min(lr, car.laneTarget - car.laneCur));

      // --- following
      var desiredGap = (4 + car.v * (srTrafficCfgV4.advancedAI ? srTrafficLerpV4(1.25, 1.95, car.reaction) : 1.5)) * (srTrafficCfgV4.advancedAI ? car.gapMul : 1);
      if (gap < desiredGap && car.phase !== 'pass') {
        var brakeGain = srTrafficCfgV4.advancedAI ? srTrafficLerpV4(0.34, 0.62, car.reaction) : 0.45;
        vTarget = Math.min(vTarget, Math.max(0, leaderV + (gap - desiredGap) * brakeGain));
      }
      // while in opposite lane, oncoming cars are handled by abort logic; also never stop dead there
      if (srTrafficInOppLaneV4(car)) vTarget = Math.max(vTarget, (srTrafficBaseSpeedKmhV4(car.s) / 3.6) * 0.5);

      setBrakeLight(car, vTarget < car.v - 0.4 || car.v < 0.5);
      var accel = vTarget > car.v ? (srTrafficCfgV4.advancedAI ? srTrafficLerpV4(1.7, 3.0, car.aggression) : 2.4) : (srTrafficCfgV4.advancedAI ? srTrafficLerpV4(5.5, 9.2, car.reaction) : 7.5);
      car.v += Math.max(-accel * dt, Math.min(accel * dt, vTarget - car.v));
      if (car.v < 0) car.v = 0;
      car.s += car.dir * car.v * dt;
    }
  }

  // is the opposite lane clear far enough ahead to overtake?
  function srTrafficOvertakeSafeV4(car, path, playerS, playerLatSign, leaderV, gap, truckPass = false) {
    // sight line: no blind curve within passing distance
    var passMul = truckPass ? 1.32 : 1.18;
    var dv = Math.max(truckPass ? 3.5 : 2, car.vBase * passMul - leaderV);
    var passDist = (gap + car.len + (truckPass ? 20 : 14)) * (car.vBase * passMul) / dv;      // distance I travel in opp lane
    if (passDist > (truckPass ? 320 : 260)) return false;                                     // too long a maneuver
    var sEnd = car.s + car.dir * Math.min(passDist + 40, 300);
    if (srTrafficMaxCurvatureV4(path, car.s, sEnd) > 0.012) return false;            // blind corner
    return srTrafficOncomingClearV4(car, path, playerS, playerLatSign, passDist / Math.max(6, car.vBase));
  }
  function srTrafficOncomingClearV4(car, path, playerS, playerLatSign, tNeed) {
    // any oncoming vehicle reaching me within tNeed seconds?
    for (var o of srTrafficStateV4.cars) {
      if (o.dir === car.dir) continue;
      var d = (o.s - car.s) * car.dir;
      if (d < -10) continue;
      if (d / Math.max(1, car.v + o.v) < tNeed + 1.2) return false;
    }
    // player driving toward me in that lane?
    if (srTrafficStateV4.playerDir !== car.dir) {
      var d = (playerS - car.s) * car.dir;
      var oppLaneSign = -srTrafficCfgV4.sideSign * car.dir;
      if (d > -10 && playerLatSign === oppLaneSign && d / Math.max(1, car.v + srTrafficStateV4.playerV) < tNeed + 1.2) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- player interaction: honks & solid contact
  function srTrafficNudgePlayerV4(playerPos, wx, wz, amount) {
    if (!srTrafficCfgV4.collisionAssist || !playerPos || typeof playerPos.x !== 'number') return;
    var n = Math.hypot(wx, wz) || 1;
    var push = srTrafficClampV4(amount, 0, 1.25);
    playerPos.x += (wx / n) * push;
    playerPos.z += (wz / n) * push;
  }

  // playerLat = precise signed lateral offset of the player from the road
  // centerline in meters (from srTrafficProjectFineV4), + = right of the +s direction.
  function srTrafficPlayerInteractionsV4(path, playerS, playerLat, playerPos, dt, now) {
    var px = playerPos.x, pz = playerPos.z;
    var playerOnRoad = Math.abs(playerLat) < 6;
    for (var car of srTrafficStateV4.cars) {
      var dx = px - car.x, dz = pz - car.z;
      var dist = Math.hypot(dx, dz);
      if (dist > 60) continue;
      if (car.police) continue;

      // --- srTrafficHonkV4: only when the player is genuinely IN this car's lane,
      // oncoming, close, and closing fast. Requires being at least 0.6m past
      // the centerline into their lane, so own-lane driving never triggers it.
      if (car.honkT <= 0 && dist < 45 && dist > 10 && playerOnRoad) {
        var myLaneSign = srTrafficCfgV4.sideSign * car.dir * (srTrafficInOppLaneV4(car) ? -1 : 1);
        var oncomingPlayer = srTrafficStateV4.playerDir !== car.dir;
        var intrusion = playerLat * myLaneSign; // meters INTO this car's lane
        var closing = car.v + srTrafficStateV4.playerV;
        if (oncomingPlayer && intrusion > 0.6 && closing > 12 && srTrafficStateV4.playerV > 3) {
          var dAlong = (playerS - car.s) * car.dir;
          if (dAlong > 8 && dAlong < 45) {
            srTrafficHonkV4(car.isTruck, dist, true);   // double angry beep
            car.honkT = 4;
          }
        }
      }

      // --- solid contact: the game's own vehicle physics can't be blocked
      // from outside, so solidity is enforced on OUR side - every frame the
      // traffic car is displaced out of the player's space (pushed along its
      // axis or sideways). Nothing ever interpenetrates. Silent by design.
      if (dist < car.len / 2 + 4.5) {
        var cy = Math.cos(-car.yaw), sy = Math.sin(-car.yaw);
        var lx = dx * cy - dz * sy;   // player in car frame: X (left +)
        var lz = dx * sy + dz * cy;   // Z (front +)
        var EXP_W = car.halfW + 0.58; // player half-width allowance; kept tight to avoid adjacent-lane shoves
        var EXP_L = car.len / 2 + 1.5;
        if (Math.abs(lx) < EXP_W && Math.abs(lz) < EXP_L) {
          var pushX = EXP_W - Math.abs(lx);
          var pushZ = EXP_L - Math.abs(lz);
          if (pushZ <= pushX) {
            // longitudinal contact: shove the car away along its heading
            var fwd = lz < 0 ? 1 : -1;          // player at rear -> push car forward
            var localPushZ = lz < 0 ? -1 : 1;   // player is pushed away from the traffic car
            var wx = localPushZ * sy;
            var wz = localPushZ * cy;
            srTrafficNudgePlayerV4(playerPos, wx, wz, pushZ * (lz < 0 ? 0.55 : 0.7));
            car.s += car.dir * fwd * pushZ;
            if (fwd > 0) {
              // being pushed from behind: match/beat player speed briefly
              car.v = Math.max(car.v, Math.min(srTrafficStateV4.playerV * 1.02, srTrafficBaseSpeedKmhV4(car.s) / 3.6 * 1.5));
              car.bumpT = 2; // hazards + escape burst (silent)
              car.pullOverT = Math.max(car.pullOverT, 8);
              car.phaseT = 0;
            } else {
              car.v = Math.max(0, car.v - 8 * dt); // head-on press: car yields, slows
              var shoulder = playerLat >= 0 ? 1 : -1;
              srTrafficNudgePlayerV4(playerPos, shoulder * 0.55, 1, pushZ * 0.45);
              car.pullOverT = Math.max(car.pullOverT, 5);
            }
          } else {
            // lateral contact: slide the car sideways away from the player.
            // car local +X (its left) in world = -dir * (right-of-+s vector),
            // so pushing away from a player at +lx means off += pushX * dir.
            car.joltDir = (lx > 0 ? 1 : -1) * car.dir;
            car.jolt = Math.min(1.35, car.jolt + pushX * 0.75);
            var localPushX = lx > 0 ? 1 : -1;
            srTrafficNudgePlayerV4(playerPos, localPushX * cy, -localPushX * sy, pushX * 0.22);
            car.bumpT = Math.max(car.bumpT, 1);    // brief hazards
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- spawn management
  function srTrafficManageSpawnsV4(path, playerS, playerPos) {
    var cars = srTrafficStateV4.cars;
    for (var i = cars.length - 1; i >= 0; i--) {
      var c = cars[i];
      if (c.police && srTrafficStateV4.chase.active) {
        c.retireT = 0;
        continue;
      }
      if (srTrafficCarProtectedFromRemovalV4(c, playerS, playerPos)) {
        c.retireT = 0;
        continue;
      }
      var rel = c.s - playerS;
      var retiring = c.s <= 2 || c.s >= path.total - 2 || Math.abs(rel) > 2600;
      c.retireT = retiring ? (c.retireT || 0) + 1 : 0;
      if (c.retireT > 180) {
        srTrafficStateV4.scene.remove(c.mesh); cars.splice(i, 1);
        srTrafficStateV4.nextSpawnAt = Math.max(srTrafficStateV4.nextSpawnAt || 0, performance.now() + 3500);
      }
    }
    if (path.total < 300) return;
    var pDir = srTrafficStateV4.playerDir || 1;
    var minGapOncoming = Math.max(120, srTrafficStateV4.playerV * 4);
    var minGapSame = Math.max(90, srTrafficStateV4.playerV * 3);
    var guard = 0;
    var retiringCount = cars.reduce((n, c) => n + ((c.retireT || 0) > 0 ? 1 : 0), 0);
    var spawnTarget = Math.max(0, srTrafficCfgV4.count - retiringCount);
    var spawnNow = performance.now();
    if (cars.length >= Math.min(4, srTrafficCfgV4.count) && srTrafficStateV4.nextSpawnAt && spawnNow < srTrafficStateV4.nextSpawnAt) return;
    var spawnLimit = cars.length < Math.min(4, srTrafficCfgV4.count) ? 4 : 1;
    var spawned = 0;
    while (cars.length < spawnTarget && spawned < spawnLimit && guard++ < 30) {
      var klass = srTrafficPickClassV4();
      var sameDir = Math.random() < 0.5;
      var dir = sameDir ? pDir : -pDir;
      var rel;
      if (!sameDir) rel = pDir * (minGapOncoming + Math.random() * 500);
      else if (Math.random() < 0.65) rel = pDir * (minGapSame + Math.random() * 300);
      else rel = -pDir * (minGapSame + Math.random() * 250);
      var s = playerS + rel;
      if (s < 30 || s > path.total - 30) continue;
      if (Math.abs(s - playerS) < Math.min(minGapSame, minGapOncoming)) continue;
      var ok = true;
      for (var o of cars) if (!o.dismissAfterPass && o.dir === dir && Math.abs(o.s - s) < 60) { ok = false; break; }
      if (!ok) continue;
      // same-direction-ahead vehicles skew slower so the player meets them
      if (sameDir && (s - playerS) * pDir > 0 && !klass.truck) {
        var slowKlass = Math.random() < 0.5 ? srTrafficClassesV4[1] : klass;
        srTrafficUpdateCarTransformV4(srTrafficSpawnVehicleV4(s, dir, slowKlass), path, performance.now());
      } else {
        srTrafficUpdateCarTransformV4(srTrafficSpawnVehicleV4(s, dir, klass), path, performance.now());
      }
      spawned++;
      srTrafficStateV4.nextSpawnAt = performance.now() + 1200;
    }
  }

  function srTrafficClearSignsV4() {
    for (var s of srTrafficStateV4.signs) srTrafficStateV4.scene && srTrafficStateV4.scene.remove(s.mesh);
    srTrafficStateV4.signs = [];
    srTrafficStateV4.signBase = null;
    srTrafficStateV4.signSpacing = null;
  }

  function srTrafficMakeSpeedSignV4(sv, dir, path) {
    var geo = srTrafficBuildSignGeoV4(srTrafficActiveLimitKmhV4(sv));
    var smp = path.sample(sv);
    var mesh = new srTrafficStateV4.three.Mesh(geo, [srTrafficMatsV4.signWhite, srTrafficMatsV4.signRed, srTrafficMatsV4.signPost, srTrafficMatsV4.signBlack]);
    var side = srTrafficCfgV4.sideSign || -1;
    var shoulder = Math.max(3.4, smp.w / 2 + 1.1);
    var rx = -smp.tz, rz = smp.tx;
    mesh.position.set(smp.x + rx * shoulder * side, smp.y + 0.05, smp.z + rz * shoulder * side);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Math.atan2(-smp.tx * dir, -smp.tz * dir);
    srTrafficStateV4.scene.add(mesh);
    return { s: sv, mesh };
  }

  function srTrafficManageSpeedSignsV4(path, playerS, now) {
    if (!srTrafficCfgV4.speedSignsEnabled || !srTrafficStateV4.scene) { if (srTrafficStateV4.signs.length) srTrafficClearSignsV4(); return; }
    var spacing = srTrafficCfgV4.speedZonesEnabled ? 560 : 260;
    var base = Math.floor(playerS / spacing) * spacing;
    if (srTrafficStateV4.signs.length && srTrafficStateV4.signBase === base && srTrafficStateV4.signSpacing === spacing) return;
    srTrafficClearSignsV4();
    for (var i = -1; i <= 4; i++) {
      var sv = base + i * spacing + 36;
      if (sv > 30 && sv < path.total - 30) {
        var sign = srTrafficMakeSpeedSignV4(sv, srTrafficStateV4.playerDir || 1, path);
        if (sign) srTrafficStateV4.signs.push(sign);
      }
      if (srTrafficCfgV4.speedZonesEnabled) {
        var repeat = sv + spacing * 0.48;
        if (repeat > 30 && repeat < path.total - 30) {
          var sign = srTrafficMakeSpeedSignV4(repeat, srTrafficStateV4.playerDir || 1, path);
          if (sign) srTrafficStateV4.signs.push(sign);
        }
      }
    }
    srTrafficStateV4.signBase = base;
    srTrafficStateV4.signSpacing = spacing;
    srTrafficStateV4.lastSignBuild = now;
  }

  function srTrafficSpawnPoliceV4(path, playerS) {
    var pDir = srTrafficStateV4.playerDir || 1;
    var s = srTrafficClampV4(playerS - pDir * 120, 35, path.total - 35);
    var policeKlass = { name: 'police', p: 0, mul: [1.28, 1.55], truck: false, overtakes: true, police: true };
    var car = srTrafficSpawnVehicleV4(s, pDir, policeKlass);
    car.chaseT = 1;
    car.blinker = 0;
    srTrafficUpdateCarTransformV4(car, path, performance.now());
    return car;
  }

  function srTrafficManagePoliceV4(path, playerS, playerLat, now) {
    var srTrafficPoliceCars = srTrafficStateV4.cars.filter(c => c.police);
    if (!srTrafficCfgV4.policeEnabled) {
      srTrafficSetSirenV4(false);
      for (var i = srTrafficStateV4.cars.length - 1; i >= 0; i--) {
        if (srTrafficStateV4.cars[i].police) { srTrafficStateV4.scene.remove(srTrafficStateV4.cars[i].mesh); srTrafficStateV4.cars.splice(i, 1); }
      }
      srTrafficStateV4.chase.active = false;
      return;
    }

    srTrafficStateV4.chase.coolT -= 0.016;
    var srTrafficPolicePlayerKmh = srTrafficStateV4.playerV * 3.6;
    var srTrafficPoliceLimit = srTrafficActiveLimitKmhV4(playerS);
    var srTrafficStoppedCopAhead = srTrafficStateV4.cars.some(c => c.police && c.dismissAfterPass && (c.s - playerS) * (srTrafficStateV4.playerDir || 1) > -20);
    var srTrafficPoliceSpeeding = !srTrafficStoppedCopAhead && srTrafficPolicePlayerKmh > srTrafficPoliceLimit + 8 && Math.abs(playerLat) < 4.5;
    var srTrafficPullCandidate = srTrafficStateV4.chase.active && srTrafficPolicePlayerKmh < 8 && Math.abs(playerLat) > srTrafficCfgV4.laneOffset * 2.15;
    srTrafficStateV4.chase.pullT = srTrafficPullCandidate ? srTrafficStateV4.chase.pullT + 0.016 : 0;
    var srTrafficPolicePulledOver = srTrafficStateV4.chase.pullT > 1.1;

    if (srTrafficPoliceSpeeding && !srTrafficStateV4.chase.active && srTrafficStateV4.chase.coolT <= 0) {
      srTrafficStateV4.chase.active = true;
      srTrafficStateV4.chase.sirenT = 0;
      if (!srTrafficPoliceCars.length) srTrafficSpawnPoliceV4(path, playerS);
      srTrafficHudMsgV4(`police: slow down or pull over | limit ${srTrafficPoliceLimit} km/h`, 3500);
    }

    if (srTrafficPolicePulledOver) {
      srTrafficStateV4.chase.active = false;
      srTrafficStateV4.chase.coolT = 20;
      srTrafficStateV4.chase.pullT = 0;
      for (var cop of srTrafficStateV4.cars.filter(c => c.police)) {
        cop.s = srTrafficClampV4(playerS + (srTrafficStateV4.playerDir || 1) * 16, 35, path.total - 35);
        cop.dir = srTrafficStateV4.playerDir || 1;
        cop.v = 0;
        cop.vBase = 0;
        cop.chaseT = 0;
        cop.pullOverT = 12;
        cop.laneTarget = 1.62;
        cop.blinker = 2;
        cop.dismissAfterPass = true;
      }
      srTrafficSetSirenV4(false);
      srTrafficHudMsgV4('police: stopped', 2500);
      return;
    }

    if (srTrafficStateV4.chase.active) {
      var nearest = Infinity;
      if (!srTrafficStateV4.cars.some(c => c.police)) srTrafficSpawnPoliceV4(path, playerS);
      for (var cop of srTrafficStateV4.cars.filter(c => c.police)) {
        cop.dir = srTrafficStateV4.playerDir || cop.dir;
        cop.chaseT = 1;
        cop.phase = 'cruise';
        cop.laneTarget = 1;
        cop.dismissAfterPass = false;
        if (cop.vBase <= 0) cop.vBase = Math.max(srTrafficBaseSpeedKmhV4(playerS), srTrafficActiveLimitKmhV4(playerS)) / 3.6 * 1.35;
        var behind = (playerS - cop.s) * cop.dir;
        if (behind < -20) cop.s = srTrafficClampV4(playerS - cop.dir * 100, 35, path.total - 35);
        nearest = Math.min(nearest, Math.abs(playerS - cop.s));
      }
      srTrafficSetSirenV4(true, srTrafficClampV4(1 - nearest / 420, 0.25, 1));
    } else {
      srTrafficStateV4.chase.pullT = 0;
      srTrafficSetSirenV4(false);
    }
  }

  // ---------------------------------------------------------------- player detection
  function srTrafficDetectPlayerV4(scene, path) {
    if (srTrafficStateV4.player && srTrafficStateV4.player.parent) return srTrafficStateV4.player;
    srTrafficStateV4.player = null;
    var ours = new Set(srTrafficStateV4.cars.map(c => c.mesh));
    for (var c of scene.children) {
      if (ours.has(c) || !c.children || c.children.length < 1) continue;
      if (c.type && /light/i.test(c.type)) continue;
      if (!path) { if (c.type && c.type !== 'Object3D' && c.type !== 'Scene') { srTrafficStateV4.player = c; break; } continue; }
      var pr = path.project(c.position.x, c.position.z);
      if (pr.dist < 8 && (Math.abs(c.position.x) > 1 || Math.abs(c.position.z) > 1)) { srTrafficStateV4.player = c; break; }
    }
    return srTrafficStateV4.player;
  }

  // ---------------------------------------------------------------- HUD + keys
  function srTrafficHudMsgV4(text, ms = 2500) {
    if (!document.body) return;
    if (!srTrafficStateV4.hud) {
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:rgba(20,20,24,.82);color:#eee;font:12px/1.5 monospace;padding:8px 12px;border-radius:8px;pointer-events:none;transition:opacity .4s;opacity:0;';
      document.body.appendChild(el);
      srTrafficStateV4.hud = el;
    }
    srTrafficStateV4.hud.textContent = text;
    srTrafficStateV4.hud.style.opacity = '1';
    clearTimeout(srTrafficStateV4.hudTimer);
    srTrafficStateV4.hudTimer = setTimeout(() => { if (srTrafficStateV4.hud) srTrafficStateV4.hud.style.opacity = '0'; }, ms);
  }
  var srTrafficHudStatusV4 = () => srTrafficHudMsgV4(`traffic ${srTrafficCfgV4.enabled ? 'ON' : 'OFF'} | vehicles: ${srTrafficCfgV4.count} | ~${srTrafficCfgV4.speedKmh} km/h | side: ${srTrafficCfgV4.sideSign === 0 ? 'auto' : (srTrafficCfgV4.sideSign === -1 ? 'left' : 'right')}`);
  function srTrafficClearCarsV4() { for (var c of srTrafficStateV4.cars) srTrafficStateV4.scene && srTrafficStateV4.scene.remove(c.mesh); srTrafficStateV4.cars = []; }
  function srTrafficCarProtectedFromRemovalV4(car, playerS, playerPos) {
    if (playerPos && Number.isFinite(playerPos.x) && Number.isFinite(playerPos.z)) {
      var worldDist = Math.hypot((car.x || car.mesh.position.x) - playerPos.x, (car.z || car.mesh.position.z) - playerPos.z);
      if (worldDist < 520) return true;
    }
    if (!Number.isFinite(playerS)) return true;
    var rel = car.s - playerS;
    var dir = srTrafficStateV4.playerDir || 1;
    // Protect anything plausibly visible: nearby, ahead, or only recently passed.
    return Math.abs(rel) < 2400 && rel * dir > -260;
  }
  function srTrafficMoveModObjectsToSceneV4(scene) {
    if (!scene) return;
    for (var c of srTrafficStateV4.cars) {
      try {
        if (c.mesh.parent !== scene) {
          c.mesh.parent && c.mesh.parent.remove(c.mesh);
          scene.add(c.mesh);
        }
      } catch (e) {}
    }
    for (var s of srTrafficStateV4.signs) {
      try {
        if (s.mesh.parent !== scene) {
          s.mesh.parent && s.mesh.parent.remove(s.mesh);
          scene.add(s.mesh);
        }
      } catch (e) {}
    }
  }

  function srTrafficBuildSettingsUIV4() {
    if (!document.body || srTrafficStateV4.ui) return;
    var root = document.createElement('div');
    root.id = 'sr-traffic-misc';
    root.style.cssText = 'position:fixed;right:14px;top:72px;z-index:999999;color:#eee;font:12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;';
    var btn = document.createElement('button');
    btn.textContent = 'Misc';
    btn.style.cssText = 'display:block;margin-left:auto;background:rgba(18,18,22,.82);color:#eee;border:1px solid rgba(255,255,255,.24);border-radius:8px;padding:7px 10px;cursor:pointer;';
    var panel = document.createElement('div');
    panel.style.cssText = 'display:none;width:260px;margin-top:8px;background:rgba(16,16,20,.92);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.32);backdrop-filter:blur(8px);';
    panel.innerHTML = '<div style="font-weight:700;margin-bottom:8px;">Slow Roads Traffic</div>';
    var addCheck = (key, label, onChange) => {
      var wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;';
      wrap.innerHTML = `<span>${label}</span>`;
      var input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!srTrafficCfgV4[key];
      input.addEventListener('change', () => { srTrafficCfgV4[key] = input.checked; srTrafficSaveCfgV4(); if (onChange) onChange(); });
      wrap.appendChild(input); panel.appendChild(wrap);
      return input;
    };
    var addRange = (key, label, min, max, srTrafficStepV4, suffix, onChange) => {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin:9px 0;';
      var top = document.createElement('div');
      top.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin-bottom:4px;';
      var name = document.createElement('span');
      var value = document.createElement('span');
      name.textContent = label;
      var input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.srTrafficStepV4 = srTrafficStepV4; input.value = srTrafficCfgV4[key];
      input.style.cssText = 'width:100%;';
      var render = () => { value.textContent = `${srTrafficCfgV4[key]}${suffix || ''}`; };
      input.addEventListener('input', () => {
        srTrafficCfgV4[key] = srTrafficStepV4 < 1 ? Number(input.value) : Math.round(Number(input.value));
        render(); srTrafficSaveCfgV4(); if (onChange) onChange();
      });
      render();
      top.appendChild(name); top.appendChild(value); wrap.appendChild(top); wrap.appendChild(input); panel.appendChild(wrap);
      return input;
    };
    addCheck('enabled', 'Traffic', () => { if (!srTrafficCfgV4.enabled) srTrafficClearCarsV4(); });
    addCheck('advancedAI', 'Advanced traffic');
    addCheck('collisionAssist', 'Collision bump assist');
    addRange('count', 'Vehicles', 0, 30, 1, '', () => { if (srTrafficCfgV4.count === 0) srTrafficClearCarsV4(); });
    addRange('speedKmh', 'Traffic pace', 20, 140, 5, ' km/h', srTrafficRetuneV4);
    addRange('hornVolume', 'Horn volume', 0, 1, 0.05, '');
    addCheck('policeEnabled', 'Police');
    addCheck('speedSignsEnabled', 'Speed signs', () => { if (!srTrafficCfgV4.speedSignsEnabled) srTrafficClearSignsV4(); });
    addCheck('speedZonesEnabled', 'Speed limit zones', () => { srTrafficClearSignsV4(); srTrafficRetuneV4(); });
    addCheck('adaptTrafficToLimit', 'Traffic follows limit', srTrafficRetuneV4);
    addRange('speedLimitKmh', 'Fixed speed limit', 30, 130, 5, ' km/h', () => { srTrafficClearSignsV4(); srTrafficRetuneV4(); });
    addRange('sirenVolume', 'Siren volume', 0, 1, 0.05, '');
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    var side = document.createElement('button');
    side.textContent = srTrafficCfgV4.sideSign === -1 ? 'Drive left' : (srTrafficCfgV4.sideSign === 1 ? 'Drive right' : 'Auto side');
    side.style.cssText = 'flex:1;background:#2b2b31;color:#eee;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:6px;cursor:pointer;';
    side.addEventListener('click', () => {
      srTrafficCfgV4.sideSign = srTrafficCfgV4.sideSign === 0 ? -1 : (srTrafficCfgV4.sideSign === -1 ? 1 : 0);
      side.textContent = srTrafficCfgV4.sideSign === -1 ? 'Drive left' : (srTrafficCfgV4.sideSign === 1 ? 'Drive right' : 'Auto side');
      srTrafficSaveCfgV4(); srTrafficHudStatusV4();
    });
    row.appendChild(side); panel.appendChild(row);
    btn.addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; });
    root.appendChild(btn); root.appendChild(panel); document.body.appendChild(root);
    srTrafficStateV4.ui = { root, btn, panel };
  }

  function srTrafficTryAttachMiscToGameSettingsV4() {
    if (!srTrafficStateV4.ui || !srTrafficCfgV4.uiButton) return;
    var nodes = Array.from(document.querySelectorAll('div,section,aside,nav'));
    var host = nodes.find(el => {
      var r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (!r || r.width < 180 || r.height < 120 || r.width > window.innerWidth * 0.95) return false;
      var txt = (el.textContent || '').toLowerCase();
      return txt.includes('settings') || txt.includes('controls') || txt.includes('graphics') || txt.includes('audio');
    });
    if (!host) {
      if (srTrafficStateV4.ui.root.parentElement !== document.body) document.body.appendChild(srTrafficStateV4.ui.root);
      srTrafficStateV4.ui.root.style.position = 'fixed';
      srTrafficStateV4.ui.root.style.right = '14px';
      srTrafficStateV4.ui.root.style.top = '72px';
      return;
    }
    if (host.contains(srTrafficStateV4.ui.root)) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    srTrafficStateV4.ui.root.style.position = 'absolute';
    srTrafficStateV4.ui.root.style.right = '12px';
    srTrafficStateV4.ui.root.style.top = '12px';
    host.appendChild(srTrafficStateV4.ui.root);
  }

  window.addEventListener('keydown', e => {
    if (!e.shiftKey || e.repeat) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.code) {
      case 'KeyT': srTrafficCfgV4.enabled = !srTrafficCfgV4.enabled; if (!srTrafficCfgV4.enabled) srTrafficClearCarsV4(); srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
      case 'BracketLeft': srTrafficCfgV4.count = Math.max(0, srTrafficCfgV4.count - 2); srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
      case 'BracketRight': srTrafficCfgV4.count = Math.min(30, srTrafficCfgV4.count + 2); srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
      case 'Minus': srTrafficCfgV4.speedKmh = Math.max(20, srTrafficCfgV4.speedKmh - 10); srTrafficRetuneV4(); srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
      case 'Equal': srTrafficCfgV4.speedKmh = Math.min(140, srTrafficCfgV4.speedKmh + 10); srTrafficRetuneV4(); srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
      case 'Backslash': srTrafficCfgV4.sideSign = (srTrafficCfgV4.sideSign === 0 ? -1 : srTrafficCfgV4.sideSign) * -1; srTrafficSaveCfgV4(); srTrafficHudStatusV4(); break;
    }
  }, true);
  function srTrafficRetuneV4() {
    for (var c of srTrafficStateV4.cars) {
      var mul = c.klass.mul[0] + Math.random() * (c.klass.mul[1] - c.klass.mul[0]);
      c.speedMul = mul;
      c.vBase = (srTrafficBaseSpeedKmhV4(c.s) / 3.6) * mul;
    }
  }

  // ---------------------------------------------------------------- main srTrafficLoopV4
  var srTrafficLastTV4 = performance.now();
  function srTrafficLoopV4() {
    requestAnimationFrame(srTrafficLoopV4);
    var now = performance.now();
    var dt = (now - srTrafficLastTV4) / 1000; srTrafficLastTV4 = now;
    if (dt > 0.1) dt = 0.1;
    if (!srTrafficStateV4.ui && document.body) srTrafficBuildSettingsUIV4();
    if (srTrafficStateV4.ui && now - srTrafficStateV4.uiTimer > 1200) { srTrafficStateV4.uiTimer = now; srTrafficTryAttachMiscToGameSettingsV4(); }

    if (!srTrafficStateV4.started) {
      if (!srTrafficStateV4.scene) srTrafficStateV4.scene = srTrafficFindSceneV4();
      if (!srTrafficStateV4.scene) return;
      if (!srTrafficStateV4.three) {
        srTrafficStateV4.three = srTrafficHarvestThreeV4(srTrafficStateV4.scene);
        if (!srTrafficStateV4.three) { srTrafficStateV4.scene = srTrafficFindSceneV4() || srTrafficStateV4.scene; return; }
        srTrafficInitVisualsV4();
        srTrafficStateV4.started = true;
        srTrafficHudMsgV4('traffic mod v3 ready - open Misc for settings, Shift+T toggles traffic', 6000);
      }
      return;
    }

    if (!srTrafficCfgV4.enabled) return;
    if (now - srTrafficStateV4.lastPathBuild > 1500 || !srTrafficStateV4.path) {
      // only swap scenes if the current one truly lost its road (avoid flapping
      // between the game's multiple Scene objects, which would clear traffic)
      var p = srTrafficBuildPathV4(srTrafficStateV4.scene);
      if (!p) {
        var freshScene = srTrafficFindSceneV4();
        if (freshScene && freshScene !== srTrafficStateV4.scene) {
          var p2 = srTrafficBuildPathV4(freshScene);
          if (p2) {
            srTrafficStateV4.scene = freshScene;
            srTrafficMoveModObjectsToSceneV4(srTrafficStateV4.scene);
            srTrafficStateV4.player = null;
            p = p2;
          }
        }
      }
      if (p) {
        // keep +s direction consistent with the previous path (otherwise every
        // rebuild may randomly flip the road direction and scramble traffic)
        if (srTrafficStateV4.path && srTrafficStateV4.player && srTrafficStateV4.player.parent) {
          var px = srTrafficStateV4.player.position.x, pz = srTrafficStateV4.player.position.z;
          var sN = p.sample(p.project(px, pz).s);
          var sO = srTrafficStateV4.path.sample(srTrafficStateV4.path.project(px, pz).s);
          if (sN.tx * sO.tx + sN.tz * sO.tz < 0) p.reverse();
        }
        srTrafficStateV4.path = p;
        var rebuildPlayerPos = srTrafficStateV4.player && srTrafficStateV4.player.parent ? srTrafficStateV4.player.position : null;
        for (var c of srTrafficStateV4.cars) {
          var worldPr = srTrafficProjectWorldV4(p, c.x, c.z);
          var nearPlayer = rebuildPlayerPos && Math.hypot(c.x - rebuildPlayerPos.x, c.z - rebuildPlayerPos.z) < 520;
          if (worldPr.dist < 18 || (worldPr.dist < 45 && !nearPlayer)) {
            c.s = worldPr.s;
            c.lockUntil = 0;
            c.lostPathT = 0;
          } else if (nearPlayer) {
            // Slow Roads rebuilds/recycles road chunks. If a rebuilt path cannot
            // confidently project a car that is near the camera, keep it at its
            // current world transform briefly instead of snapping/removing it.
            c.lockUntil = Math.max(c.lockUntil || 0, now + 1800);
            c.lostPathT = 0;
          } else {
            var pr = srTrafficProjectNearV4(p, c.x, c.z, c.s);
            if (pr.dist < 45) {
              c.s = srTrafficLerpV4(c.s, pr.s, pr.dist < 4 ? 0.18 : 0.55);
              c.lostPathT = 0;
            } else {
              c.lostPathT = (c.lostPathT || 0) + 1;
              c.s = srTrafficClampV4(c.s + c.dir * c.v * 0.15, 5, p.total - 5);
            }
          }
        }
      }
      srTrafficStateV4.lastPathBuild = now;
    }
    if (!srTrafficStateV4.path) return;

    var player = srTrafficDetectPlayerV4(srTrafficStateV4.scene, srTrafficStateV4.path);
    if (!player) return;

    if (now - srTrafficStateV4.pv.t > 150) {
      var pdt = (now - srTrafficStateV4.pv.t) / 1000;
      var d = Math.hypot(player.position.x - srTrafficStateV4.pv.x, player.position.z - srTrafficStateV4.pv.z);
      if (srTrafficStateV4.pv.t) srTrafficStateV4.playerV = srTrafficStateV4.playerV * 0.6 + (d / pdt) * 0.4;
      srTrafficStateV4.pv.x = player.position.x; srTrafficStateV4.pv.z = player.position.z; srTrafficStateV4.pv.t = now;
    }
    var proj = srTrafficProjectFineV4(srTrafficStateV4.path, player.position.x, player.position.z);
    var playerS = proj.s;
    if (srTrafficStateV4.prevPlayerS !== null) {
      var dS = playerS - srTrafficStateV4.prevPlayerS;
      if (Math.abs(dS) > 0.05 && Math.abs(dS) < 50) srTrafficStateV4.playerDir = dS > 0 ? 1 : -1;
    }
    srTrafficStateV4.prevPlayerS = playerS;
    if (srTrafficCfgV4.sideSign === 0 && proj.dist < 4 && srTrafficStateV4.playerV > 2) {
      srTrafficCfgV4.sideSign = proj.lat >= 0 ? 1 : -1;
      srTrafficHudStatusV4();
    }
    if (srTrafficCfgV4.sideSign === 0) srTrafficCfgV4.sideSign = -1;
    var playerLatSign = proj.lat >= 0 ? 1 : -1;

    srTrafficManageSpeedSignsV4(srTrafficStateV4.path, playerS, now);
    srTrafficManagePoliceV4(srTrafficStateV4.path, playerS, proj.lat, now);
    srTrafficStepV4(dt, srTrafficStateV4.path, playerS, playerLatSign, player.position, now);
    srTrafficPlayerInteractionsV4(srTrafficStateV4.path, playerS, proj.lat, player.position, dt, now);
    for (var c of srTrafficStateV4.cars) srTrafficUpdateCarTransformV4(c, srTrafficStateV4.path, now);
    srTrafficManageSpawnsV4(srTrafficStateV4.path, playerS, player.position);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(srTrafficLoopV4));
  } else {
    requestAnimationFrame(srTrafficLoopV4);
  }
})();
