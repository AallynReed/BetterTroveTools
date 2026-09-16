/* Kiwi viewer stage tools - the backdrop, the sun and the snapshot button that the
   blueprint viewer, the Blueprint Editor and the assembled-model viewer all want.

   Three jobs, one place so the viewers cannot drift apart:

     * BACKGROUND. The stage used to be a fixed radial gradient baked into each
       viewer's CSS. That gradient is still the default and still looks the same;
       this adds "no background at all", a flat colour, and an image from disk to
       stand the model in front of.

     * LIGHTING. Where the sun sits and how hard it shines. The shading is the
       game's own (voxel_mesh.js), which is worth keeping as the default, but it
       leaves one side of a model in its 30% shadow - so a face you want to look at
       can end up the dark one. Turning the intensity down flattens the shading out
       until, at 0%, the model shows its plain voxel colours with no sun at all.

     * SNAPSHOT. Saves exactly what is on screen as a PNG - backdrop composited
       under the model, at the canvas' real device-pixel size.

   Compositing is why the two live together. A WebGL canvas here is transparent
   (`alpha: true`) and the backdrop is a CSS layer behind it, so reading the GL
   canvas alone would save a model floating on nothing. The snapshot paints the
   same backdrop into a 2D canvas first and draws the GL canvas over it, so the
   backdrop has to be describable in a form both CSS and canvas can draw.

   The DEFAULT backdrop therefore stays a host stylesheet's business - the stage
   is styled before this script has even run, and a viewer that flashed a flat
   panel while the model loaded would be a step backwards - but every host has to
   spell it exactly this way, because `rasterGradient()` below redraws it by hand:

     background: radial-gradient(circle at 50% 40%,
                                 var(--vs-bg-a, #1e1e1e), var(--vs-bg-b, #121212) 78%);

   Only the two stops may vary (the embed's light theme reassigns them), and this
   reads them back off the computed style. Every other mode is an inline
   background, which outranks the host's rule and needs no cooperation from it.

   Usage:
     var tools = window.ViewerStage.attach({
       stage: el, canvas: renderer.domElement,
       render: function () { renderer.render(scene, camera); },
       name: 'Dragon',
     });
     ...
     tools.dispose();

   Optional, so a host that hasn't loaded this script still works - both viewers
   check for `window.ViewerStage` before calling it. */
(function () {
  'use strict';

  var STORE_KEY = 'kiwi.viewerBg';        // { mode, color } - never the image itself
  var LIGHT_KEY = 'kiwi.viewerLight';     // { intensity, azimuth, elevation }; absent = the host's own
  var GRAD_A = '#1e1e1e', GRAD_B = '#121212';   // fallbacks; the CSS vars are the source
  var _styles = false;

  /* The chosen image lives for the page, not for one attach. The dressing room
     tears the viewer down and rebuilds it on every costume change, and losing your
     backdrop each time you tried a different hat would be absurd. It stays out of
     localStorage though - a photo is megabytes, and that is the user's file to
     keep, not ours to stash. */
  var IMG = { url: '', name: '', el: null };
  var _uid = 0;                             // one counter per page = ids that cannot collide

  function injectStyles() {
    if (_styles) return; _styles = true;
    var css =
      '.vs-tools{position:absolute;top:8px;right:8px;z-index:3;display:flex;gap:6px}' +
      // each button owns the panel that drops out of it
      '.vs-slot{position:relative}' +
      '.vs-tool{position:relative;display:flex;align-items:center;gap:6px;background:var(--bg-panel);' +
        'border:1px solid var(--border-color);color:var(--text-main);border-radius:var(--radius-control);padding:5px 9px;' +
        'font:inherit;font-size:var(--t-fs-label);line-height:1.2;cursor:pointer}' +
      '.vs-tool:hover{border-color:var(--accent-blue);color:var(--text-main)}' +
      '.vs-tool:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}' +
      '.vs-tool[aria-expanded="true"]{border-color:var(--accent-blue);color:var(--text-main)}' +
      '.vs-tool svg{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;' +
        'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
      '.vs-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:4;width:212px;padding:11px;' +
        'background:var(--bg-panel);border:1px solid var(--border-color);border-radius:var(--radius-surface);' +
        'box-shadow:0 14px 34px rgba(0,0,0,.5)}' +
      '.vs-panel[hidden]{display:none}' +
      '.vs-legend{display:block;color:var(--text-muted);font-size:var(--t-fs-label);text-transform:uppercase;' +
        'letter-spacing:.06em;margin:0 0 7px}' +
      '.vs-opts{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}' +
      '.vs-opt{background:transparent;border:1px solid var(--border-color);color:var(--text-muted);border-radius:var(--radius-pill);' +
        'padding:4px 11px;font:inherit;font-size:var(--t-fs-label);cursor:pointer}' +
      '.vs-opt:hover{border-color:var(--accent-blue);color:var(--text-main)}' +
      '.vs-opt:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}' +
      '.vs-opt[aria-pressed="true"]{background:rgba(var(--accent-rgb),.14);border-color:var(--accent-blue);color:var(--text-main)}' +
      '.vs-row{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:var(--t-fs-label)}' +
      '.vs-row[hidden]{display:none}' +
      '.vs-row input[type=color]{width:34px;height:24px;padding:0;background:none;' +
        'border:1px solid var(--border-color);border-radius:var(--radius-control);cursor:pointer}' +
      '.vs-file{color:var(--text-muted);font-size:var(--t-fs-label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.vs-clear{background:none;border:0;color:var(--text-muted);font:inherit;font-size:var(--t-fs-label);' +
        'text-decoration:underline;cursor:pointer;padding:0;margin-left:auto;flex:0 0 auto}' +
      '.vs-clear:hover{color:var(--text-main)}' +
      /* The lighting controls dock along the BOTTOM EDGE of the stage rather than
         dropping out of their button: you are watching the model while you move
         them, and a panel hanging over it is in the way of the one thing it is
         for. It sits outside `.vs-tools` in the DOM for the same reason - that
         toolbar is the containing block its own dropdown is positioned in. */
      '.vs-light-panel{position:absolute;left:10px;right:10px;bottom:10px;z-index:4;' +
        'display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;align-items:center;' +
        'gap:2px 14px;padding:8px 12px;background:var(--bg-panel);border:1px solid var(--border-color);' +
        'border-radius:var(--radius-surface);box-shadow:0 14px 34px rgba(0,0,0,.5)}' +
      '.vs-light-panel[hidden]{display:none}' +
      '.vs-light-panel .vs-clear{margin:0;justify-self:end}' +
      '@media (max-width:620px){.vs-light-panel{grid-template-columns:1fr 1fr}}' +
      '.vs-slide{display:grid;grid-template-columns:1fr auto;align-items:center;gap:1px 8px}' +
      '.vs-slide label{color:var(--text-muted);font-size:var(--t-fs-label)}' +
      '.vs-slide output{color:var(--text-main);font-size:var(--t-fs-label);font-variant-numeric:tabular-nums}' +
      '.vs-slide input{grid-column:1/-1;width:100%;margin:2px 0 0;accent-color:var(--accent-blue);cursor:pointer}' +
      '.vs-slide input:focus-visible{outline:2px solid var(--accent-blue);outline-offset:3px}' +
      // Three buttons don't fit across a phone-width stage. The labels go to
      // screen readers only rather than away, so the buttons keep their names.
      '@media (max-width:560px){.vs-tool span{position:absolute;width:1px;height:1px;' +
        'overflow:hidden;clip-path:inset(50%);white-space:nowrap}.vs-tool{padding:6px}}';
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  function load(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || 'null'); }
    catch (e) { return null; }               // private mode, or someone else's key
  }
  function store(key, v) {                   // null clears it
    try {
      if (v) window.localStorage.setItem(key, JSON.stringify(v));
      else window.localStorage.removeItem(key);
    } catch (e) { /* not worth failing over */ }
  }

  function readBg() {
    var v = load(STORE_KEY);
    return (v && typeof v.mode === 'string') ? v : { mode: 'default', color: '#121212' };
  }

  /* The saved sun, or null for "whatever the host asked for". Nothing is written
     until the control is actually moved, so a viewer nobody has relit keeps its own
     lighting exactly - and a stored setting made on one viewer carries to the next. */
  function readLight() {
    var v = load(LIGHT_KEY), n = function (x) { return typeof x === 'number' && isFinite(x); };
    return (v && n(v.intensity) && n(v.azimuth) && n(v.elevation)) ? v : null;
  }

  function icon(d) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
  }
  var ICON_IMAGE = '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
                   '<circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 3-2 4 4"/>';
  var ICON_SAVE = '<path d="M12 3v11"/><path d="M8 11l4 4 4-4"/><path d="M4 20h16"/>';
  var ICON_LIGHT = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4' +
                   'M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

  /* The three things the sun has. `intensity` is a percentage of the game's own
     lighting - 100% is the shading Trove itself draws, 0% is no sun at all - and the
     other two are where it shines from, in degrees. */
  var SLIDERS = [
    { k: 'intensity', label: 'Intensity', min: 0, max: 100, unit: '%' },
    { k: 'azimuth', label: 'Direction', min: 0, max: 360, unit: '°' },
    { k: 'elevation', label: 'Height', min: -90, max: 90, unit: '°' },
  ];

  /* --- the guide rays -------------------------------------------------------

     Numbers alone make you guess which way you just dragged the sun, so while the
     panel is open five red beams come in from where it is: four parallel ones to
     read the angle off, a fifth down the middle with a head on it for which way it
     travels, and a diamond at the far end marking the source. It is a guide, not
     part of the model - it appears with the panel, is gone the moment that closes,
     and hides itself for a snapshot so it can never end up in a saved PNG.

     Depth testing is off and it draws last, so the beams stay visible when the sun
     is round the back of the model - the case you most need to see. They stop short
     of the model's bounding sphere so nothing is buried inside the voxels, and they
     fade with the intensity, so a sun turned off looks turned off. */
  var GUIDE_SEGMENTS = 11;                 // 5 beams + 2 head barbs + 4 marker sides

  function makeGuide(THREE) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GUIDE_SEGMENTS * 6), 3));
    var lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xff2f2f, transparent: true, opacity: 0.9,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    lines.renderOrder = 999;
    lines.frustumCulled = false;            // the beams reach well outside the model
    return lines;
  }

  function aimGuide(THREE, lines, dir, center, radius, intensity) {
    var d = new THREE.Vector3().fromArray(dir).normalize();
    // any axis that isn't the beam itself, for the plane the four rays spread in
    var up = Math.abs(d.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    var u = new THREE.Vector3().crossVectors(up, d).normalize();
    var v = new THREE.Vector3().crossVectors(d, u);
    var far = radius * 2.4, near = radius * 0.95;
    var off = radius * 0.42, head = radius * 0.16, mark = radius * 0.17;

    var p = lines.geometry.getAttribute('position').array, i = 0;
    var a = new THREE.Vector3(), b = new THREE.Vector3();
    function seg(from, to) {
      p[i++] = from.x; p[i++] = from.y; p[i++] = from.z;
      p[i++] = to.x; p[i++] = to.y; p[i++] = to.z;
    }
    function at(t, ou, ov) {
      return new THREE.Vector3().copy(center).addScaledVector(d, t)
        .addScaledVector(u, ou || 0).addScaledVector(v, ov || 0);
    }

    [[0, 0], [off, 0], [-off, 0], [0, off], [0, -off]].forEach(function (o) {
      seg(at(far, o[0], o[1]), at(near, o[0], o[1]));
    });
    a.copy(at(near));                                     // the head, pointing at the model
    seg(a, b.copy(a).addScaledVector(d, head).addScaledVector(u, head * 0.6));
    seg(a, b.copy(a).addScaledVector(d, head).addScaledVector(v, head * 0.6));
    var m = [at(far, mark, 0), at(far, 0, mark), at(far, -mark, 0), at(far, 0, -mark)];
    for (var k = 0; k < 4; k++) seg(m[k], m[(k + 1) % 4]);

    lines.geometry.getAttribute('position').needsUpdate = true;
    lines.geometry.computeBoundingSphere();
    lines.material.opacity = 0.3 + 0.65 * Math.max(0, Math.min(1, intensity));
  }

  /* The default backdrop, painted into a 2D context. `radial-gradient(circle at
     50% 40%, A, B 78%)` with no explicit size means a farthest-corner circle, so
     the radius is the distance to whichever corner is furthest from the centre
     point, and the 78% stop scales off that. Canvas clamps to the final stop
     past the end radius, which is what CSS does beyond 78% too. */
  function rasterGradient(ctx, w, h, a, b) {
    var cx = w * 0.5, cy = h * 0.4;
    var r = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy),
                     Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) * 0.78;
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, a); g.addColorStop(1, b);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  // `background-size: cover` - scale until both axes are covered, then centre.
  function rasterCover(ctx, img, w, h) {
    var s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function slug(name) {
    return String(name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
  }

  function attach(opts) {
    injectStyles();
    var stage = opts.stage, canvas = opts.canvas, render = opts.render;
    var state = readBg();
    // Only a voxel viewer has a sun to move; a host without the mesher (which owns
    // the shader's uniforms) gets the backdrop and the snapshot and no dead button.
    var lightable = !!(window.VoxelMesh && window.VoxelMesh.setLightControl);

    var tools = document.createElement('div');
    tools.className = 'vs-tools';
    tools.innerHTML =
      (lightable ?
      '<button class="vs-tool vs-light-btn" type="button" aria-expanded="false">' +
        icon(ICON_LIGHT) + '<span>Lighting</span></button>' : '') +
      '<div class="vs-slot">' +
        '<button class="vs-tool vs-bg-btn" type="button" aria-expanded="false">' +
          icon(ICON_IMAGE) + '<span>Background</span></button>' +
        '<div class="vs-panel vs-bg-panel" hidden>' +
          '<span class="vs-legend">Backdrop</span>' +
          '<div class="vs-opts">' +
            '<button class="vs-opt" type="button" data-mode="default" aria-pressed="false">Default</button>' +
            '<button class="vs-opt" type="button" data-mode="none" aria-pressed="false">None</button>' +
            '<button class="vs-opt" type="button" data-mode="color" aria-pressed="false">Color</button>' +
            '<button class="vs-opt" type="button" data-mode="image" aria-pressed="false">Image</button>' +
          '</div>' +
          '<div class="vs-row vs-color-row" hidden>' +
            '<label for="" class="vs-color-label">Color</label>' +
            '<input type="color" class="vs-color">' +
          '</div>' +
          '<div class="vs-row vs-image-row" hidden>' +
            '<button class="vs-opt vs-pick" type="button">Choose file…</button>' +
            '<span class="vs-file"></span>' +
          '</div>' +
          '<input type="file" class="vs-input" accept="image/*" hidden>' +
        '</div>' +
      '</div>' +
      '<button class="vs-tool vs-save-btn" type="button">' +
        icon(ICON_SAVE) + '<span>Save PNG</span></button>';
    stage.appendChild(tools);

    var lightPanel = null;
    if (lightable) {
      lightPanel = document.createElement('div');
      lightPanel.className = 'vs-light-panel';
      lightPanel.hidden = true;
      lightPanel.innerHTML =
        SLIDERS.map(function (s, i) {
          return '<div class="vs-slide">' +
            '<label for="">' + s.label + '</label>' +
            '<output></output>' +
            '<input type="range" data-i="' + i + '" min="' + s.min + '" max="' + s.max + '" step="1">' +
          '</div>';
        }).join('') +
        '<button class="vs-clear vs-light-reset" type="button">Reset</button>';
      stage.appendChild(lightPanel);
    }

    var bgBtn = tools.querySelector('.vs-bg-btn'),
        saveBtn = tools.querySelector('.vs-save-btn'),
        panel = tools.querySelector('.vs-bg-panel'),
        colorRow = tools.querySelector('.vs-color-row'),
        colorIn = tools.querySelector('.vs-color'),
        colorLabel = tools.querySelector('.vs-color-label'),
        imageRow = tools.querySelector('.vs-image-row'),
        pickBtn = tools.querySelector('.vs-pick'),
        fileName = tools.querySelector('.vs-file'),
        fileIn = tools.querySelector('.vs-input');

    var lightBtn = tools.querySelector('.vs-light-btn');
    // every button that opens something, with the thing it opens
    var pairs = [{ btn: bgBtn, el: panel }];
    if (lightPanel) pairs.push({ btn: lightBtn, el: lightPanel });

    // `for` and `aria-controls` need unique ids, and a page can hold more than one viewer
    var uid = String(++_uid);
    colorIn.id = 'vs-c-' + uid; colorLabel.setAttribute('for', colorIn.id);
    panel.id = 'vs-p-' + uid; bgBtn.setAttribute('aria-controls', panel.id);
    colorIn.value = state.color;
    if (lightPanel) {
      lightPanel.id = 'vs-l-' + uid;
      lightBtn.setAttribute('aria-controls', lightPanel.id);
      Array.prototype.forEach.call(lightPanel.querySelectorAll('input'), function (r, i) {
        r.id = 'vs-r' + i + '-' + uid;
        r.parentNode.querySelector('label').setAttribute('for', r.id);
      });
    }

    function apply() {
      var m = state.mode;
      // Default hands the stage back to the host's own stylesheet; every other mode
      // sets an inline background, which outranks it.
      if (m === 'default') stage.style.background = '';
      else if (m === 'color') stage.style.background = state.color;
      else if (m === 'image' && IMG.url) stage.style.background = 'center/cover no-repeat url("' + IMG.url + '")';
      else stage.style.background = 'none';

      Array.prototype.forEach.call(tools.querySelectorAll('.vs-opt[data-mode]'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === m));
      });
      colorRow.hidden = m !== 'color';
      imageRow.hidden = m !== 'image';
      fileName.textContent = IMG.name || 'No file chosen';
    }

    function setMode(m) { state.mode = m; store(STORE_KEY, state); apply(); }

    /* One at a time - the backdrop dropdown would otherwise sit on top of the
       lighting bar. Opening or closing the lighting one is also what puts the
       guide rays in the scene and takes them out again. */
    function openPanel(p, on) {
      pairs.forEach(function (q) {
        var show = q.el === p && on;
        q.el.hidden = !show;
        q.btn.setAttribute('aria-expanded', String(show));
      });
      syncGuide();
    }
    function anyOpen() { return !panel.hidden || !!(lightPanel && !lightPanel.hidden); }
    function closeAll() { openPanel(null, false); }

    function onBgClick() { openPanel(panel, panel.hidden); }
    function onOptClick(e) {
      var b = e.target.closest ? e.target.closest('.vs-opt[data-mode]') : null;
      if (!b) return;
      var m = b.getAttribute('data-mode');
      setMode(m);
      if (m === 'image' && !IMG.el) fileIn.click();
    }
    function onColor() { state.color = colorIn.value; store(STORE_KEY, state); apply(); }
    function onPick() { fileIn.click(); }
    function onFile() {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (IMG.url) URL.revokeObjectURL(IMG.url);
      IMG.url = URL.createObjectURL(f);
      IMG.name = f.name;
      /* Decoded into an <img> as well as handed to CSS: the snapshot needs real
         pixels to draw, and a blob from the user's own disk keeps the export
         canvas untainted - a remote URL would taint it and `toBlob` would throw. */
      IMG.el = new Image();
      IMG.el.onload = function () { apply(); };
      IMG.el.onerror = function () { IMG.el = null; IMG.name = ''; setMode('default'); };
      IMG.el.src = IMG.url;
      fileIn.value = '';                       // so re-picking the same file still fires
      setMode('image');
    }
    /* Escape must close the picker without also closing the viewer's modal, which
       listens for it on `document`. */
    function onKey(e) {
      if (e.key !== 'Escape' || !anyOpen()) return;
      e.stopPropagation();
      var open = panel.hidden ? lightBtn : bgBtn;
      closeAll(); open.focus();
    }
    function onDocDown(e) {
      if (!anyOpen()) return;
      if (tools.contains(e.target) || (lightPanel && lightPanel.contains(e.target))) return;
      closeAll();
    }

    /* --- the sun ------------------------------------------------------------
       `light` is null until someone moves a slider: an untouched viewer keeps the
       lighting its host asked for, rather than one this script decided on. The
       sliders still have to show something, so they open on the settings that
       reproduce that host's own sun. */
    var lightDefaults = lightable ? window.VoxelMesh.lightControlDefaults() : null;
    var light = lightable ? readLight() : null;
    var ranges = lightPanel ? Array.prototype.slice.call(lightPanel.querySelectorAll('input')) : [];

    function lightValues() {
      return light || {
        intensity: Math.round(lightDefaults.intensity * 100),
        azimuth: lightDefaults.azimuth, elevation: lightDefaults.elevation,
      };
    }
    function showLight() {
      var v = lightValues();
      ranges.forEach(function (r) {
        var s = SLIDERS[+r.getAttribute('data-i')];
        r.value = v[s.k];
        r.parentNode.querySelector('output').textContent = v[s.k] + s.unit;
      });
    }
    // Nothing to push while `light` is null - the host's own lighting is already up.
    function applyLight() {
      if (!light) return;
      window.VoxelMesh.setLightControl(window.THREE, {
        intensity: light.intensity / 100, azimuth: light.azimuth, elevation: light.elevation,
      });
      render();
    }
    function onRange(e) {
      var r = e.target, s = SLIDERS[+r.getAttribute('data-i')];
      if (!s) return;
      light = lightValues();
      light[s.k] = +r.value;
      store(LIGHT_KEY, light);
      showLight(); applyLight(); syncGuide();
    }
    function onLightReset() {
      light = null;
      store(LIGHT_KEY, null);
      window.VoxelMesh.setLightControl(window.THREE, null);
      showLight(); syncGuide(); render();
    }

    /* The rays live exactly as long as the panel is open. A host that didn't hand
       over its scene simply doesn't get them - the sliders work the same. */
    var guide = null;
    function dropGuide() {
      if (!guide) return false;
      opts.scene.remove(guide);
      guide.geometry.dispose(); guide.material.dispose();
      guide = null;
      return true;
    }
    function syncGuide() {
      if (!lightPanel || !opts.scene || !opts.focus) return;
      if (lightPanel.hidden) { if (dropGuide()) render(); return; }
      var THREE = window.THREE, f = opts.focus();
      if (!guide) { guide = makeGuide(THREE); opts.scene.add(guide); }
      aimGuide(THREE, guide, window.VoxelMesh.sunDirection(THREE),
               f.center, f.radius || 1, lightValues().intensity / 100);
      render();
    }

    /* The renderer runs without `preserveDrawingBuffer`, so the GL canvas is only
       readable in the same task as the draw that filled it - hence render, then
       composite, with nothing awaited in between. */
    function snapshot() {
      // The guide is UI, not the model - "Save PNG" is reachable with the lighting
      // panel still open, and nobody wants red beams baked into their render.
      var shown = guide && guide.visible;
      if (shown) guide.visible = false;
      render();
      var w = canvas.width, h = canvas.height;
      var out = document.createElement('canvas');
      out.width = w; out.height = h;
      var ctx = out.getContext('2d');
      var cs = window.getComputedStyle(stage);
      if (state.mode === 'default') {
        rasterGradient(ctx, w, h,
          (cs.getPropertyValue('--vs-bg-a') || '').trim() || GRAD_A,
          (cs.getPropertyValue('--vs-bg-b') || '').trim() || GRAD_B);
      } else if (state.mode === 'color') {
        ctx.fillStyle = state.color; ctx.fillRect(0, 0, w, h);
      } else if (state.mode === 'image' && IMG.el) {
        rasterCover(ctx, IMG.el, w, h);
      }
      ctx.drawImage(canvas, 0, 0, w, h);     // "none" leaves the PNG transparent behind the model
      // the composite is taken, so the beams can come back to the screen
      if (shown) { guide.visible = true; render(); }
      save(out);
    }

    function save(out) {
      var name = slug(opts.name) + '.png';
      if (!out.toBlob) {                     // ancient browser: one big data: URL instead
        return download(out.toDataURL('image/png'), name, false);
      }
      out.toBlob(function (blob) {
        if (!blob) return;
        download(URL.createObjectURL(blob), name, true);
      }, 'image/png');
    }
    function download(href, name, revoke) {
      var a = document.createElement('a');
      a.href = href; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    }

    bgBtn.addEventListener('click', onBgClick);
    saveBtn.addEventListener('click', snapshot);
    panel.addEventListener('click', onOptClick);
    colorIn.addEventListener('input', onColor);
    pickBtn.addEventListener('click', onPick);
    fileIn.addEventListener('change', onFile);
    tools.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocDown);
    if (lightPanel) {
      lightBtn.addEventListener('click', function () { openPanel(lightPanel, lightPanel.hidden); });
      lightPanel.addEventListener('input', onRange);
      lightPanel.addEventListener('keydown', onKey);
      lightPanel.querySelector('.vs-light-reset').addEventListener('click', onLightReset);
      showLight();
      /* Re-applied on every attach, not only when the sliders move: the dressing
         room and the editor rebuild their meshes (and their tools) as you work,
         and each rebuild hands the sun back to the host's default. */
      applyLight();
    }

    apply();

    return {
      snapshot: snapshot,
      dispose: function () {
        document.removeEventListener('mousedown', onDocDown);
        if (lightPanel) { dropGuide(); lightPanel.remove(); }   // no redraw: the host is going away
        // IMG is deliberately left alone - see the note on its declaration.
        stage.style.background = '';
        if (tools.parentNode) tools.parentNode.removeChild(tools);
      },
    };
  }

  window.ViewerStage = { attach: attach };
})();
