/* Blueprint Editor - recolour and re-material a Trove .blueprint in the browser.

   The file never leaves the visitor's control for longer than a request: it is posted
   to be decoded, held in this tab while it is edited, and posted back with the edit
   list to be written. Nothing is stored server-side, so the original bytes have to
   stay here - `state.file` is the same File object the visitor picked.

   The model is held as the inspect payload's parallel arrays and edited in place. Two
   extra arrays make that work: `live`, so an erase can drop a voxel without renumbering
   every row after it, and `origin`, mapping each row back to its index in the file (-1
   for one the user placed). The save payload is then DERIVED by diffing against the
   pristine copy rather than journalled as it goes - so a voxel painted back to how it
   started stops counting as an edit, with nothing to keep in sync.

   Voxels the server marked `edit: 0` are Trove's own - deco placeholders, terrain,
   anything the material palette can't safely reinterpret. They are rendered, they can
   be inspected, and they are refused as material targets rather than being converted
   into plain blocks behind the user's back. Erasing one is allowed: deleting a voxel
   is not the same as claiming to know what it was. */
(function () {
  'use strict';

  /* The site's /site/* data plane is served locally under /api/* (backend/modder_tools/blueprint_editor.py). */
  function apiUrl(path) {
    return typeof path === 'string' && path.indexOf('/site/') === 0 ? '/api/' + path.slice(6) : path;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var U = {
    getJSON: function (u) {
      return fetch(apiUrl(u), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
    },
    fetchJSON: function (u) {
      return fetch(apiUrl(u), { headers: { Accept: 'application/json' } }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (body) {
          if (!r.ok) throw new Error((body && body.detail) || ('HTTP ' + r.status));
          return body;
        });
      });
    },
    debounce: function (fn, ms) {
      var t = 0;
      return function () {
        var a = arguments;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(null, a); }, ms);
      };
    },
  };

  var state = {
    file: null,          // the File the visitor opened; posted back on save
    data: null,          // inspect payload (arrays are the render source of truth)
    base: null,          // pristine rgb/type/w, straight from the file
    origin: [],          // row -> index in the file, or -1 if the user placed it
    history: [],         // one array of before-states per action, for undo
    redo: [],            // undone actions, same shape, waiting to be put back
    scene: null,
    selection: -1,
    index: null,         // "x,y,z" -> row, live rows only
    paint: { rgb: 0xff6b6b, type: 21, w: 0 },
    tool: 'paint',       // paint | add | erase
    mode: 'both',        // what a paint click applies: colour, material, or both
    scope: 'voxel',      // one voxel, or every voxel sharing its material
    kind: 'other',       // creation type the checks are run against
    docs: [],            // the stack, bottom to top; each is its own blueprint
    active: 0,           // which one the tools edit
    anchor: 0,           // which one everything else is positioned against
    docSeq: 1,
    project: null,       // a whole model open at once: the archive + its rig
    ask: -1,             // a part just added that nobody has placed yet
    drawn: {},           // doc id -> its geometry is currently in the scene as a layer
    moveAccum: [0, 0, 0],   // sub-voxel remainder of a part drag
    moveStroke: null,       // one drag of the Move tool = one entry in the model's undo
    partPrefix: 0,          // chars of creature-name prefix every part shares (see partLabel)
    // Animation preview: the shared bar + player (anim_clips.js), rebuilt per model.
    anim: { on: false, prog: null, want: null, raf: 0, loaded: {}, kit: null, bar: null },
    isolate: false,      // show only the layer being edited
    stroke: null,        // in-progress drag-edit: one batch, one undo entry
    strokeNormal: null,  // the face an 'add' stroke started on
    // Slice view: show one layer of the part being edited, so its inside can be
    // reached. A VIEW, never an edit - nothing here changes a voxel.
    slice: { on: false, axis: 'y', at: 0 },
    // The Box tool's drag: the two corners, which axis the rectangle is flat against,
    // and where a fill lands relative to it (off the face, or in the slice).
    box: { fill: true, from: null, to: null, plane: null, lift: [0, 0, 0] },
    report: null,        // last check result
    showAttach: true,
    swatches: [],        // saved colours, browser-local (see loadSwatches)
    sessionId: '',       // this open model's row in the local autosave store
    restoring: false,    // replaying a saved session; don't autosave over it
    openWith: null,      // how this model was opened, so it can be opened again
    sel: null,           // Set of rows the tools are confined to, or null for all
    selOut: false,       // true = work on everything EXCEPT the selection
    grab: 'connected',   // what a Select click gathers
    nav: 'magicavoxel',  // which mouse gestures drive the camera (see NAV_INFO)
  };

  var ATTACH_COLOUR = 0xff3fd5;   // the pink Trove modders mark attachment points in
  var FINDING_COLOUR = { error: 0xff5555, warning: 0xffc857, info: 0x58a6ff };
  // A model's parts each get a box, the one being edited gets a brighter one - which is
  // the only thing telling you where the leg ends and the foot begins.
  var PART_BOX = 0x8b95a5, ACTIVE_BOX = 0x58a6ff, PART_BOX_OPACITY = 0.3;

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var el = $('bpe-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'bpe-status' + (kind ? ' bpe-' + kind : '');
    el.hidden = !msg;
  }

  function hex(rgb) {
    return '#' + ('000000' + (rgb >>> 0).toString(16)).slice(-6);
  }
  function unhex(s) {
    return parseInt(String(s || '').replace('#', ''), 16) & 0xFFFFFF;
  }

  // ---- opening ------------------------------------------------------------ //

  /* `note` survives the open: a .qb import has something to say about the conversion,
     and loading the result would otherwise clear the status line out from under it. */
  function openFile(file, note, done, fail) {
    if (!file) return;
    if (!/\.blueprint$/i.test(file.name)) {
      setStatus('That isn’t a .blueprint file.', 'error');
      return;
    }
    state.openWith = { kind: 'file', file: file };
    setStatus('Opening ' + file.name + '…');
    var fd = new FormData();
    fd.append('file', file, file.name);
    fetch(apiUrl('/site/blueprint-editor/inspect'), { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.detail) || 'That blueprint couldn’t be opened.');
          return body;
        });
      })
      .then(function (payload) { loaded(file, payload, note); if (done) done(); })
      .catch(function (err) {
        if (fail) fail(err); else setStatus(err.message || String(err), 'error');
      });
  }

  /* Opening a file starts a FRESH stack with it at the bottom. Everything a document
     needs in order to be edited independently - its pristine copy, its live flags, its
     own undo stack - is built by makeDoc and swapped in by setActive. */
  function loaded(file, payload, note) {
    state.project = null;
    state.docs = [makeDoc(file, payload)];
    state.active = 0;
    state.anchor = 0;
    mount(note);
  }

  /* Everything that has to happen once a fresh set of documents is in place, however
     they got there - one opened file, or a whole model's worth of parts. */
  function mount(note) {
    // A fresh open is a fresh row; a restore keeps the row it came from (set after).
    if (!state.restoring) state.sessionId = 'S' + Date.now() + '-' + (state.docSeq);
    state.isolate = false;
    state.report = null;
    state.drawn = {};            // a fresh scene holds none of the old geometry
    $('bpe-report').hidden = true;
    $('bpe-empty').hidden = true;
    $('bpe-workspace').hidden = false;
    $('bpe-page').classList.toggle('bpe-project-mode', !!state.project);
    // The hero introduces the page to somebody who has just arrived. Once a model is
    // open it is a title and a paragraph between you and the thing you came to edit,
    // so the workspace takes the space back.
    $('bpe-page').classList.add('bpe-working');

    var d0 = state.docs[state.active];
    state.file = d0.file;
    state.data = d0.payload;
    state.base = d0.base;
    state.origin = d0.origin;
    state.history = d0.history;
    state.redo = d0.redo;
    state.selection = -1;
    // Rows are indices into THIS document's arrays; carried into another file they
    // would silently name different voxels.
    state.sel = null;
    // A slice index describes one model's grid, so a fresh open starts unsliced.
    state.slice.on = false;
    state.slice.at = 0;
    cancelBox();
    rebuildIndex();

    renderSlice();
    renderMode();
    renderKinds();
    renderTransforms();
    renderToolHint();
    renderPalette();
    renderMaterialList();
    renderMeta();
    renderSelection();
    renderLayers();
    updateDirty();
    setStatus(note || '', note ? 'ok' : '');

    if (state.scene) { state.scene.dispose(); state.scene = null; }
    // Whose geometry the scene is about to be built with. `create` is async - it
    // loads three.js - and the active part can move before it resolves.
    var seededId = d0.id;
    window.VoxelScene.create({
      stage: $('bpe-stage'),
      data: liveView(),
      name: d0.payload.name,
      /* The specular atlas. Without it every solid shades as rough, so metal, water,
         iridescent, waxy and wave all look identical and the Finish control appears
         to do nothing. Loaded through an <img>, which the global fetch rewriter never
         sees, so it asks apiUrl itself. */
      brdfUrl: apiUrl('/site/render/brdf-map.png'),
      onPick: onPick,
      onHover: onHover,
      onDrag: function (dx, dy, dz) { nudgeActive(dx, dy, dz); },
      // A part is moved in ITS OWN frame, which the bone has rotated, so the editor
      // takes the raw world-space drag and quantises it there (see dragPart).
      onDragWorld: inProject() ? dragPart : null,
      onStroke: onStroke,
      onRect: onRect,
    }).then(function (scene) {
      state.scene = scene;
      scene.setDragMode(dragModeFor(state.tool));
      scene.setNavScheme(state.nav);
      /* `data` above was snapshotted from the part that was active when mount() ran.
         Anything that selects another part before this promise resolves - a restored
         session picks its own the moment the model is open - gets no re-mesh from
         setActive, because setActive skips its scene work while there is no scene
         yet. The stage would then draw part 0's voxels at the selected part's socket,
         with the picker, the parts list and the outline all naming the right part and
         only the geometry wrong - until you clicked something else and it rebuilt. */
      var now = active();
      if (now && now.id !== seededId) scene.rebuild(viewOf(now));
      drawStack();
      drawAttachment();
      drawSelection();
      // A creature opens on the creature, not on whichever part happens to be first.
      if (state.project) scene.frameAll();
    }).catch(function (err) {
      setStatus(err.message || 'The 3D view could not start.', 'error');
    });
  }

  // ---- the live model ----------------------------------------------------- //

  /* The mesher wants dense arrays, and erased voxels are still sitting in ours, so
     compact them out on the way through. One O(n) pass per rebuild, which the re-mesh
     costs anyway. */
  function liveView() {
    var d = state.data;
    var s = state.slice;
    var v = { count: 0, size: d.size, x: [], y: [], z: [], rgb: [],
              kind: [], level: [], spec: [] };
    for (var i = 0; i < d.count; i++) {
      if (!d.live[i]) continue;
      // The slice filters what is DRAWN, and so also what a raycast can hit - which is
      // the whole point: with the shell out of the way the cursor reaches the inside.
      if (s.on && d[s.axis][i] !== s.at) continue;
      v.x.push(d.x[i]); v.y.push(d.y[i]); v.z.push(d.z[i]); v.rgb.push(d.rgb[i]);
      v.kind.push(d.kind[i]); v.level.push(d.level[i]); v.spec.push(d.spec[i]);
      v.count++;
    }
    return v;
  }

  /* How far the slice can travel: the part's own bounding box on that axis. Read off
     `size` rather than the voxels, so an empty layer in the middle of a model is still
     a layer you can step onto and build into. */
  function sliceMax() {
    var d = state.data;
    if (!d || !d.size) return 0;
    return Math.max(0, d.size[{ x: 0, y: 1, z: 2 }[state.slice.axis]] - 1);
  }

  function setSlice(next) {
    var s = state.slice;
    var axisChanged = next.axis !== undefined && next.axis !== s.axis;
    var turnedOn = next.on === true && !s.on;
    if (next.axis !== undefined) s.axis = next.axis;
    if (next.on !== undefined) s.on = next.on;
    // Land MID-MODEL when the slice is switched on or moved to another axis: the old
    // index means nothing on a new axis, and layer 0 is the outer face - the one thing
    // you could already see without slicing at all.
    if (axisChanged || turnedOn) s.at = Math.floor(sliceMax() / 2);
    if (next.at !== undefined) s.at = next.at;
    s.at = Math.max(0, Math.min(s.at, sliceMax()));
    cancelBox();
    renderSlice();
    if (state.scene) state.scene.rebuild(liveView());
    drawStack();
  }

  function renderSlice() {
    var s = state.slice, max = sliceMax();
    /* The empty cells of the layer have to be clickable or you could clear a slice and
       never fill it back in - an empty cell has no geometry to raycast. Synced here
       rather than in setSlice so every path that changes the slice (a fresh open, a
       switch of part) keeps the scene in step with the panel. */
    if (state.scene) state.scene.setPickPlane(s.on ? { axis: s.axis, at: s.at } : null);
    Array.prototype.forEach.call($('bpe-slice-axes').children, function (b) {
      b.setAttribute('aria-pressed',
        String(s.on ? b.dataset.slice === s.axis : b.dataset.slice === 'off'));
    });
    $('bpe-slicebar').hidden = !s.on;
    $('bpe-slicehint').hidden = !s.on;
    var at = $('bpe-slice-at');
    at.max = String(max);
    at.value = String(s.at);
    $('bpe-slice-read').textContent = s.at + ' / ' + max;
  }

  function rebuildIndex() {
    var d = state.data;
    state.index = new Map();
    for (var i = 0; i < d.count; i++) {
      if (d.live[i]) state.index.set(d.x[i] + ',' + d.y[i] + ',' + d.z[i], i);
    }
  }

  function liveCount() {
    var d = state.data, n = 0;
    for (var i = 0; i < d.count; i++) if (d.live[i]) n++;
    return n;
  }

  /* The save payload, derived rather than journalled: every row is compared with the
     file it came from. An original voxel that changed emits an edit, one that was
     erased emits a delete, and a row the user placed emits an add. Nothing to keep in
     sync, and painting a voxel back to its starting colour simply stops appearing. */
  function editList() { return editListOf(state.docs[state.active]); }

  function editListOf(docu) {
    var d = docu.payload, b = docu.base, out = [];
    for (var i = 0; i < d.count; i++) {
      var orig = docu.origin[i];
      if (orig < 0) {
        if (d.live[i]) {
          out.push({ add: [d.x[i], d.y[i], d.z[i]],
                     type: d.type[i], w: d.w[i], rgb: d.rgb[i] });
        }
        continue;
      }
      if (!d.live[i]) { out.push({ i: orig, del: true }); continue; }
      var e = null;
      if (d.type[i] !== b.type[orig] || d.w[i] !== b.w[orig]) {
        e = { i: orig, type: d.type[i], w: d.w[i] };
      }
      if (d.rgb[i] !== b.rgb[orig]) {
        e = e || { i: orig };
        e.rgb = d.rgb[i];
      }
      if (e) out.push(e);
    }
    return out;
  }

  // ---- selection + masking ------------------------------------------------ //

  /* A selection is a MASK: the set of voxels the tools are allowed to touch (or,
     inverted, the only ones they must leave alone). It is deliberately a different idea
     from `scope`, which is how far one click SPREADS - you can select the left wing and
     still say "every voxel of that colour", and get every voxel of that colour *in the
     wing*.

     The reason to have it at all is that a bulk edit was a leap of faith: "every voxel
     of that material" on a typical model means almost the whole thing, and you found
     out which voxels that meant by doing it and looking. Now you point at them first
     and they light up. */

  var GRABS = [
    { id: 'voxel', label: 'Just that voxel' },
    { id: 'connected', label: 'Everything joined to it' },
    { id: 'colour', label: 'Every voxel of that colour' },
    { id: 'colour-connected', label: 'That colour, joined up' },
    { id: 'material', label: 'Every voxel of that material' },
  ];

  var SELECT_COLOUR = 0x58a6ff;
  // Not the selection's blue: a box preview and a selection can be on screen together,
  // and two blue wireframes over each other say nothing about which is which.
  var BOX_COLOUR = 0x6ee7a8;

  function renderGrabs() {
    var el = $('bpe-grabs');
    if (!el) return;
    el.innerHTML = GRABS.map(function (g) {
      return '<button type="button" data-grab="' + g.id + '"'
        + ' aria-pressed="' + (state.grab === g.id) + '">' + esc(g.label) + '</button>';
    }).join('');
  }

  /* Face-connected flood fill from `i`. `same` decides what counts as joined, which is
     the whole difference between "this shape" and "this shape in this colour". Uses the
     live index, so an erased voxel breaks the connection exactly as a gap does. */
  function flood(i, same) {
    var d = state.data, out = new Set([i]);
    var queue = [i];
    while (queue.length) {
      var c = queue.pop();
      var x = d.x[c], y = d.y[c], z = d.z[c];
      var nb = [[x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]];
      for (var n = 0; n < 6; n++) {
        var j = state.index.get(nb[n][0] + ',' + nb[n][1] + ',' + nb[n][2]);
        if (j === undefined || out.has(j) || !d.live[j]) continue;
        if (!same(j, i)) continue;
        out.add(j);
        queue.push(j);
      }
    }
    return out;
  }

  function grabFrom(i) {
    var d = state.data, out;
    if (state.grab === 'voxel') return new Set([i]);
    if (state.grab === 'connected') return flood(i, function () { return true; });
    if (state.grab === 'colour-connected') {
      return flood(i, function (j) { return d.rgb[j] === d.rgb[i]; });
    }
    out = new Set();
    if (state.grab === 'colour') {
      for (var j = 0; j < d.count; j++) if (d.live[j] && d.rgb[j] === d.rgb[i]) out.add(j);
      return out;
    }
    for (var k = 0; k < d.count; k++) {
      if (d.live[k] && d.type[k] === d.type[i] && d.w[k] === d.w[i]) out.add(k);
    }
    return out;
  }

  /* The one question every edit asks. With no selection everything is fair game, which
     is what makes this safe to call from every path rather than only the new ones. */
  function allowed(i) {
    if (!state.sel || !state.sel.size) return true;
    return state.selOut ? !state.sel.has(i) : state.sel.has(i);
  }

  function selectAt(i, additive) {
    var got = grabFrom(i);
    if (additive && state.sel) got.forEach(function (j) { state.sel.add(j); });
    else state.sel = got;
    afterSelection();
  }

  function clearSelection() {
    state.sel = null;
    // The invert is only meaningful against a selection. Carrying it into the next
    // one means the first click after a Clear does the opposite of what the panel
    // no longer says.
    state.selOut = false;
    afterSelection();
  }

  function afterSelection() {
    drawSelection();
    renderSelectionBar();
    renderToolHint();
  }

  function drawSelection() {
    if (!state.scene) return;
    var d = state.data;
    if (!state.sel || !state.sel.size || !d) {
      state.scene.setOverlay('sel', [], SELECT_COLOUR, 1.04);
      return;
    }
    var pts = [];
    state.sel.forEach(function (i) {
      if (d.live[i]) pts.push([d.x[i], d.y[i], d.z[i]]);
    });
    state.scene.setOverlay('sel', pts, SELECT_COLOUR, 1.04);
  }

  /* Erased rows stay in the arrays, so a selection can outlive the voxels in it. Drop
     them rather than reporting a count that includes holes. */
  function pruneSelection() {
    if (!state.sel) return;
    var d = state.data, dead = [];
    state.sel.forEach(function (i) { if (!d.live[i]) dead.push(i); });
    dead.forEach(function (i) { state.sel.delete(i); });
    if (!state.sel.size) state.sel = null;
  }

  function renderSelectionBar() {
    var n = state.sel ? state.sel.size : 0;
    var bar = $('bpe-selbar');
    if (!bar) return;
    bar.hidden = !n;
    if (!n) return;
    $('bpe-selcount').textContent = n.toLocaleString()
      + (n === 1 ? ' voxel selected' : ' voxels selected');
    var out = $('bpe-selout');
    out.setAttribute('aria-pressed', String(state.selOut));
    out.textContent = state.selOut ? 'Working outside it' : 'Working inside it';
  }

  /* Move or copy the selection by a whole voxel. Both are ordinary edits - a copy is
     adds, a move is adds plus deletes - so they undo in one step and save through the
     same protocol as everything else. Rotation is deliberately not here: the model-wide
     Turn it carries the attachment point and the placed decos with it, and a selection
     rotate that quietly left those behind would be the wrong kind of easy. */
  function shiftSelection(dx, dy, dz, copy) {
    if (!state.data || !state.sel || !state.sel.size) return;
    var d = state.data, batch = [], rows = [];
    state.sel.forEach(function (i) { if (d.live[i]) rows.push(i); });
    if (!rows.length) return;

    var moving = new Set(rows.map(function (i) {
      return (d.x[i] + dx) + ',' + (d.y[i] + dy) + ',' + (d.z[i] + dz);
    }));
    var carried = rows.map(function (i) {
      return { x: d.x[i] + dx, y: d.y[i] + dy, z: d.z[i] + dz,
               rgb: d.rgb[i], type: d.type[i], w: d.w[i] };
    });

    if (!copy) {
      // Vacate first, but only the cells nothing is landing on - erasing a cell that
      // the shape is about to occupy would punch a hole through its own middle.
      rows.forEach(function (i) {
        if (!moving.has(d.x[i] + ',' + d.y[i] + ',' + d.z[i])) eraseVoxel(i, batch);
      });
    }
    var next = new Set();
    carried.forEach(function (v) {
      var j = addVoxelAt(v, batch);
      if (j >= 0) next.add(j);
    });
    state.sel = next;
    commit(batch, 0);
    afterSelection();
    setStatus((copy ? 'Copied ' : 'Moved ') + carried.length.toLocaleString()
      + ' voxel' + (carried.length === 1 ? '' : 's') + '.', 'ok');
  }

  // ---- attachment point + check highlights -------------------------------- //

  function drawAttachment() {
    if (!state.scene) return;
    var a = state.data && state.data.attachment;
    state.scene.setOverlay('attach',
      (a && state.showAttach) ? [a] : [], ATTACH_COLOUR, 1.25);
  }

  function highlightFinding(finding) {
    if (!state.scene || !state.data) return;
    var d = state.data;
    var pts = (finding && finding.voxels || []).map(function (i) {
      return [d.x[i], d.y[i], d.z[i]];
    });
    state.scene.setOverlay('lint', pts, FINDING_COLOUR[finding && finding.level] || 0xff5555, 1.1);
  }

  function runCheck() {
    if (!state.file) return;
    var list = editList();
    var btn = $('bpe-check');
    btn.disabled = true;
    setStatus('Checking…');
    var fd = new FormData();
    anchorParts(fd);
    fd.append('kind', state.kind);
    stackParts(fd);
    fetch(apiUrl('/site/blueprint-editor/check'), { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error((b && b.detail) || 'The check couldn’t run.');
          return b;
        });
      })
      .then(function (report) {
        state.report = report;
        renderReport();
        setStatus('');
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); })
      .finally(function () { btn.disabled = false; });
  }

  /* An edit invalidates the last check. Rather than silently leaving a stale verdict
     on screen - the one thing a checker must never do - drop it and say why. */
  function staleReport() {
    if (!state.report) return;
    state.report = null;
    if (state.scene) state.scene.clearOverlay('lint');
    var box = $('bpe-report');
    box.hidden = false;
    box.innerHTML = '<p class="bpe-hint">You’ve changed the model since the last check. '
      + 'Run it again to see where it stands.</p>';
  }

  function renderReport() {
    var box = $('bpe-report');
    var r = state.report;
    if (!r) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    var c = r.counts;
    var head = c.error
      ? '<strong class="bpe-r-error">' + c.error + ' to fix</strong>'
      : '<strong class="bpe-r-ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Nothing blocking</strong>';
    if (c.warning) head += '<span>' + c.warning + ' to look at</span>';

    var items = r.findings.map(function (f, i) {
      return '<li class="bpe-finding bpe-f-' + f.level + '">'
        + '<div class="bpe-f-head"><span class="bpe-f-dot"></span><strong>' + esc(f.title) + '</strong>'
        + (f.voxels.length
            ? '<button type="button" class="bpe-f-show" data-finding="' + i + '">Show '
              + f.voxels.length.toLocaleString() + '</button>'
            : '')
        + '</div><p>' + esc(f.body) + '</p></li>';
    }).join('');

    box.innerHTML = '<div class="bpe-r-head">' + head + '</div>'
      + (items ? '<ul class="bpe-findings">' + items + '</ul>' : '')
      + '<ul class="bpe-satisfied">'
      + r.satisfied.map(function (s) {
          return '<li><i class="fa-solid fa-check" aria-hidden="true"></i> ' + esc(s) + '</li>';
        }).join('')
      + '</ul>'
      + '<p class="bpe-hint">These are the Trove Creations submission guidelines. '
      + 'Plenty of official game items bend them — they describe what gets accepted, '
      + 'not what the game can load.</p>';
  }

  // ---- editing ------------------------------------------------------------ //

  /* Recompute the render arrays for one voxel from its current (type, w, rgb).
     This mirrors `material_for` on the server: the viewer needs to know a voxel is
     glass at 50% before the file is ever saved, or the preview would lie. */
  function reshade(i, payload) {
    var d = payload || state.data;
    var t = d.type[i], w = d.w[i];
    var glass = (t === 18 || t === 54 || t === 56);
    var glow = (t === 55 || t === 56);
    d.kind[i] = glow ? (glass ? 3 : 2) : (glass ? 1 : 0);
    d.level[i] = glass ? (16 + 32 * Math.max(0, Math.min(w, 7))) : 255;
    d.spec[i] = (d.kind[i] === 0) ? Math.max(0, Math.min(w, 7)) : 0;
  }

  /* Apply a change to one voxel, recording what it was so undo can put it back.
     Returns false when nothing could be applied.

     Two independent permissions, matching the server exactly: `edit` governs the
     MATERIAL (the palette must not reinterpret a voxel whose meaning we don't know)
     and `paint` governs the COLOUR (a procedural voxel is tinted by the game, so a
     colour written there would change the file and nothing in game). A voxel can
     allow one and refuse the other, so a click that does both applies the half it
     is allowed to. */
  function applyTo(i, change, batch) {
    var d = state.data;
    var wantsColour = change.rgb !== undefined;
    var wantsMaterial = change.type !== undefined;
    var canColour = wantsColour && d.paint[i];
    var canMaterial = wantsMaterial && d.edit[i];
    if (!canColour && !canMaterial) return false;

    batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
    if (canColour) d.rgb[i] = change.rgb;
    if (canMaterial) { d.type[i] = change.type; d.w[i] = change.w; }
    reshade(i);
    return true;
  }

  /* Erase: the row stays put and stops being live, which keeps every other index
     stable. Nothing is refused here - a placeholder or a terrain voxel may be deleted
     outright; what the editor won't do is reinterpret one as something else. */
  function eraseVoxel(i, batch) {
    var d = state.data;
    if (!d.live[i]) return false;
    batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: 1 });
    d.live[i] = 0;
    return true;
  }

  /* Add: a new row appended with origin -1, or an erased row at that cell brought back
     to life. Re-using the row matters - two live rows on one cell would draw twice and
     save twice. */
  function addVoxel(x, y, z, batch) {
    var d = state.data;
    for (var i = 0; i < d.count; i++) {
      if (d.x[i] === x && d.y[i] === y && d.z[i] === z) {
        batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
        d.live[i] = 1;
        d.rgb[i] = state.paint.rgb;
        d.type[i] = state.paint.type;
        d.w[i] = state.paint.w;
        reshade(i);
        return true;
      }
    }
    var n = d.count;
    d.x.push(x); d.y.push(y); d.z.push(z);
    d.rgb.push(state.paint.rgb);
    d.type.push(state.paint.type); d.w.push(state.paint.w);
    d.kind.push(0); d.level.push(255); d.spec.push(0);
    d.edit.push(1); d.paint.push(1);      // a voxel the user placed is always theirs
    d.live.push(1);
    state.origin.push(-1);
    d.count = n + 1;
    reshade(n);
    batch.push({ index: n, added: true });
    return true;
  }

  /* `addVoxel` with the material carried in rather than taken from the paint controls,
     and an O(1) occupancy test - a selection copy places thousands of voxels at once and
     the linear scan above is fine for one click and quadratic for that. Returns the row.
     Reviving an erased row rather than appending a duplicate is deliberate: the cell
     already has an identity, and two rows on one cell is what v5 silently collapses. */
  function addVoxelAt(v, batch) {
    var d = state.data;
    var key = v.x + ',' + v.y + ',' + v.z;
    var i = state.index.get(key);
    if (i !== undefined) {
      batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
      d.live[i] = 1; d.rgb[i] = v.rgb; d.type[i] = v.type; d.w[i] = v.w;
      reshade(i);
      return i;
    }
    var n = d.count;
    d.x.push(v.x); d.y.push(v.y); d.z.push(v.z);
    d.rgb.push(v.rgb); d.type.push(v.type); d.w.push(v.w);
    d.kind.push(0); d.level.push(255); d.spec.push(0);
    d.edit.push(1); d.paint.push(1);
    d.live.push(1);
    state.origin.push(-1);
    d.count = n + 1;
    reshade(n);
    state.index.set(key, n);          // kept live for the rest of this batch
    batch.push({ index: n, added: true });
    return n;
  }

  function commit(batch, refused) {
    if (batch.length) {
      rebuildIndex();
      if (state.scene) state.scene.rebuild(liveView());
      if (state.stroke) {
        // Mid-drag: fold into the stroke's single undo entry and skip the panel work
        // until it ends - re-rendering the material list per voxel would crawl.
        state.stroke.push.apply(state.stroke, batch);
      } else {
        state.history.push(batch);
        state.redo.length = 0;      // a fresh action forks the timeline
        clearThumb(active());
        noteEditInModelView();
        renderMaterialList();
        renderMeta();
        renderLayers();
        updateDirty();
        staleReport();
      }
    }
    if (refused) {
      setStatus(refused + (refused === 1 ? ' voxel is' : ' voxels are')
        + ' controlled by the game — a deco placeholder, terrain that’s coloured'
        + ' in-game, or a material outside the modding palette — so they were left'
        + ' as they are.', 'warn');
    } else if (batch.length) {
      setStatus('');
    }
  }

  function change() {
    var c = {};
    if (state.mode === 'colour' || state.mode === 'both') c.rgb = state.paint.rgb;
    if (state.mode === 'material' || state.mode === 'both') {
      c.type = state.paint.type; c.w = state.paint.w;
    }
    return c;
  }

  /* Which rows a click acts on.

     `material` matches (type, w) - which on a typical model is nearly every voxel,
     because most of a model is plain solid rough. That was the only bulk option, and
     it made "everything like it" mean "almost everything". `colour` matches the exact
     stored RGB, which is what you want when the intent is "recolour all the grey". */
  function targetsFor(i) {
    var d = state.data;
    if (state.scope === 'voxel') return [i];
    var out = [];
    if (state.scope === 'colour') {
      var rgb = d.rgb[i];
      for (var j = 0; j < d.count; j++) if (d.live[j] && d.rgb[j] === rgb) out.push(j);
      return out;
    }
    var t = d.type[i], w = d.w[i];
    for (var k = 0; k < d.count; k++) {
      if (d.live[k] && d.type[k] === t && d.w[k] === w) out.push(k);
    }
    return out;
  }

  /* ---- the Box tool ---------------------------------------------------------

     Drag out a rectangle and fill or clear it in one action, instead of one click per
     voxel. Two endpoints in 3D from a 2D drag is ambiguous, so the rectangle is pinned
     to the PLANE OF THE FACE THE DRAG STARTED ON - the same trick the Add tool already
     uses to stop a stroke climbing its own output. Every later hit on that plane just
     moves the far corner.

     Sliced, this is the Qubicle gesture: the visible faces of a slice all point at the
     camera, so the plane is the slice and the rectangle is drawn across it. */

  var AXES = ['x', 'y', 'z'];

  function normalAxis(hit) {
    return hit.nx ? 'x' : (hit.ny ? 'y' : 'z');
  }

  function inGrid(c) {
    var s = state.data.size;
    return c.x >= 0 && c.y >= 0 && c.z >= 0
        && c.x < s[0] && c.y < s[1] && c.z < s[2];
  }

  // The two axes the fixed one leaves free - the rectangle's own two dimensions.
  function planeAxes(fixed) {
    return AXES.filter(function (a) { return a !== fixed; });
  }

  function boxCells() {
    var b = state.box;
    if (!b.from || !b.to) return [];
    var free = planeAxes(b.plane);
    var a0 = free[0], a1 = free[1];
    /* CLAMPED to the grid. Dragging past the edge of the model means "out to the edge",
       not "and a hundred cells into thin air" - and on an empty slice the far corner is
       a point on a bare plane, which has no edges of its own to stop at. */
    var lo0 = Math.min(b.from[a0], b.to[a0]), hi0 = Math.max(b.from[a0], b.to[a0]);
    var lo1 = Math.min(b.from[a1], b.to[a1]), hi1 = Math.max(b.from[a1], b.to[a1]);
    var lim = { x: state.data.size[0] - 1, y: state.data.size[1] - 1, z: state.data.size[2] - 1 };
    lo0 = Math.max(0, lo0); hi0 = Math.min(lim[a0], hi0);
    lo1 = Math.max(0, lo1); hi1 = Math.min(lim[a1], hi1);
    var out = [];
    for (var p = lo0; p <= hi0; p++) {
      for (var q = lo1; q <= hi1; q++) {
        var cell = { x: b.from.x, y: b.from.y, z: b.from.z };
        cell[a0] = p; cell[a1] = q;
        out.push(cell);
      }
    }
    return out;
  }

  /* Preview. Unsliced, fill draws where the voxels will LAND - one step off the face,
     which is where they go - so the outline is never mistaken for the row it rests on.
     In a slice they land in the slice, so `lift` is zero and it draws on the cells. */
  function drawBox() {
    if (!state.scene) return;
    var b = state.box;
    if (!b.from || !b.to) { state.scene.setOverlay('box', [], BOX_COLOUR, 1.02); return; }
    var n = b.fill ? b.lift : [0, 0, 0];
    var pts = boxCells().map(function (c) {
      return [c.x + n[0], c.y + n[1], c.z + n[2]];
    });
    state.scene.setOverlay('box', pts, BOX_COLOUR, b.fill && b.lift[0] + b.lift[1] + b.lift[2] ? 1.02 : 1.08);
  }

  function cancelBox() {
    state.box.from = state.box.to = state.box.plane = null;
    state.box.lift = [0, 0, 0];
    drawBox();
  }

  /* Apply on release, as ONE batch: a box over four hundred cells is one thing you did
     and has to be one thing you undo. */
  function commitBox() {
    var b = state.box;
    if (!b.from || !b.to) return;
    var cells = boxCells();
    var n = b.lift;
    var batch = [], refused = 0, done = 0;
    cells.forEach(function (c) {
      if (b.fill) {
        var v = { x: c.x + n[0], y: c.y + n[1], z: c.z + n[2],
                  rgb: state.paint.rgb, type: state.paint.type, w: state.paint.w };
        // Outside the grid an add would have to shift every voxel and the attachment
        // point with it; that is the transform endpoint's job, not a brush stroke's.
        if (v.x < 0 || v.y < 0 || v.z < 0) { refused++; return; }
        addVoxelAt(v, batch);
        done++;
      } else {
        var i = state.index.get(c.x + ',' + c.y + ',' + c.z);
        if (i === undefined) return;
        if (!allowed(i)) { refused++; return; }
        if (eraseVoxel(i, batch)) done++;
      }
    });
    cancelBox();
    if (!batch.length) {
      setStatus(b.fill ? 'Nothing could be placed there.'
                       : 'No voxels of this part in that box.', 'warn');
      return;
    }
    commit(batch, 0);
    pruneSelection();
    afterSelection();
    setStatus(done.toLocaleString() + ' voxel' + (done === 1 ? '' : 's')
      + (b.fill ? ' placed' : ' cleared')
      + (refused ? ' · ' + refused + ' skipped (outside the selection or the grid)' : '')
      + '.', 'ok');
  }

  function onPick(hit, ev) {
    if (!hit || !state.data || state.anim.on) return;

    /* Box records the drag and paints nothing until it ends. The anchor is the first
       hit; every later one on the same face moves the far corner and a hit on a
       different face is ignored, exactly as an Add stroke ignores it. */
    if (state.tool === 'box') {
      var b = state.box;
      /* SLICED, the plane is the slice, not the face under the cursor. A slice of a
         hollow model is a RING of separate cubes and each presents whichever face
         happens to point at you, so locking to the first one would reject almost every
         later hit and the rectangle would never grow past its own corner. Every hit is
         in the slice by construction, so there is nothing left to check - and a fill
         lands IN the layer you are looking at rather than one step out of it, which is
         what filling a slice means. */
      if (state.slice.on) {
        b.plane = state.slice.axis;
        b.lift = [0, 0, 0];
      } else if (!b.plane) {
        b.plane = normalAxis(hit);
        b.lift = [hit.nx, hit.ny, hit.nz];
      } else if (b.plane !== normalAxis(hit)
                 || b.lift[0] !== hit.nx || b.lift[1] !== hit.ny || b.lift[2] !== hit.nz) {
        // Unsliced there is no plane but the face you started on, so a hit on another
        // one is ignored - the same rule an Add stroke follows.
        return;
      }
      if (!b.from) b.from = { x: hit.x, y: hit.y, z: hit.z };
      b.to = { x: hit.x, y: hit.y, z: hit.z };
      drawBox();
      return;
    }

    /* A hit on the bare slice plane names an EMPTY cell, so there is no row to look up
       and nothing but Add has anything to do with it. Add builds right there - the cell
       IS the gap you clicked - rather than one step off a face that isn't there. */
    if (hit.onPlane) {
      if (state.tool !== 'add') return;
      /* The plane is infinite where the model is not. Adding against a FACE can only
         ever land one cell beyond an existing voxel, but a click far out on the plane
         would drag the bounding box out with it - so the grid is the limit here. */
      if (!inGrid(hit)) return;
      var planeBatch = [];
      addVoxel(hit.x, hit.y, hit.z, planeBatch);
      commit(planeBatch, 0);
      state.selection = state.index.get(hit.x + ',' + hit.y + ',' + hit.z);
      if (state.selection === undefined) state.selection = -1;
      renderSelection();
      return;
    }

    var i = state.index.get(hit.x + ',' + hit.y + ',' + hit.z);
    if (i === undefined) return;
    var batch = [], refused = 0;

    // Eyedropper: take the colour AND the material, so the next paint reproduces the
    // voxel you sampled rather than half of it. Alt-click does it from any tool, which
    // is the gesture every other editor uses.
    if (state.tool === 'pick' || (ev && ev.altKey)) {
      state.paint.rgb = state.data.rgb[i];
      if (state.data.edit[i]) {
        state.paint.type = state.data.type[i];
        state.paint.w = state.data.w[i];
      }
      state.selection = i;
      syncPaintUI();
      renderSelection();
      setStatus('Picked up ' + hex(state.paint.rgb).toUpperCase()
        + (state.data.edit[i] ? ' · ' + label(i) : '')
        + (state.data.edit[i] ? '' : ' (its material is one the game manages, so only the colour was taken)'),
        'ok');
      return;
    }

    if (state.tool === 'select') {
      selectAt(i, !!(ev && ev.shiftKey));
      state.selection = i;
      renderSelection();
      return;
    }

    if (state.tool === 'add') {
      /* The face normal says which side was clicked, so the new voxel goes on the
         outside of it - the gesture every voxel editor uses.

         Across a DRAG the normal is locked to the face the stroke began on. Without
         that, each voxel added becomes new geometry for the next raycast to hit, and
         the stroke climbs its own output into a wall coming at the camera instead of
         running along the surface you were tracing. */
      if (state.stroke) {
        if (!state.strokeNormal) state.strokeNormal = [hit.nx, hit.ny, hit.nz];
        var n = state.strokeNormal;
        if (n[0] !== hit.nx || n[1] !== hit.ny || n[2] !== hit.nz) return;
      }
      /* Sliced, the faces pointing at you are the ones ALONG the slice axis, so the
         obvious click would drop the voxel into the next layer - off screen, and
         apparently nowhere. Refuse it and say so rather than build somewhere invisible;
         in-plane faces still work, which is how you fill a slice out. */
      if (state.slice.on && normalAxis(hit) === state.slice.axis) {
        setStatus('That face points out of the slice, so a voxel there would land in '
          + 'the layer behind it. Step the slice, or build from a side face.', 'warn');
        return;
      }
      addVoxel(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz, batch);
      commit(batch, 0);
      state.selection = state.index.get(
        (hit.x + hit.nx) + ',' + (hit.y + hit.ny) + ',' + (hit.z + hit.nz));
      if (state.selection === undefined) state.selection = -1;
      renderSelection();
      return;
    }

    var targets = targetsFor(i).filter(allowed);
    // Clicking outside the mask is not a silent no-op: say so, or the tool just
    // looks broken until you remember there is a selection.
    if (!targets.length) {
      if (state.sel && state.sel.size) {
        setStatus('That voxel is outside the selection. Clear it, or invert it with '
          + '“Working inside it”.', 'warn');
      }
      return;
    }

    if (state.tool === 'erase') {
      targets.forEach(function (j) { eraseVoxel(j, batch); });
      commit(batch, 0);
      pruneSelection();
      afterSelection();
      state.selection = -1;
      renderSelection();
      return;
    }

    state.selection = i;
    renderSelection();

    var c = change();
    if (!Object.keys(c).length) return;

    targets.forEach(function (j) { if (!applyTo(j, c, batch)) refused++; });
    commit(batch, refused);
    renderSelection();
  }

  /* The readout is hidden outright when the cursor isn't over a voxel, rather than
     blanked - an empty chip floating on the model reads as a rendering glitch. */
  function onHover(hit) {
    var el = $('bpe-hover');
    if (!el) return;
    if (state.anim.on) { el.hidden = true; return; }
    var i = (hit && state.data)
      ? state.index.get(hit.x + ',' + hit.y + ',' + hit.z)
      : undefined;
    if (i === undefined) {
      /* An empty cell of the slice still has a coordinate, and while you are building
         into a cleared layer that coordinate is the only thing on screen telling you
         where the cursor is. */
      // The plane runs on past the model, and a coordinate you cannot build on is worse
      // than none - the box clamps to the grid, so read out only what it would keep.
      if (hit && hit.onPlane && state.data && inGrid(hit)) {
        var where = hit.x + ', ' + hit.y + ', ' + hit.z + ' · empty';
        if (el.textContent !== where) el.textContent = where;
        el.hidden = false;
        return;
      }
      if (!el.hidden) { el.hidden = true; el.textContent = ''; }
      return;
    }
    var text = hit.x + ', ' + hit.y + ', ' + hit.z + ' · ' + label(i);
    if (el.textContent !== text) el.textContent = text;
    el.hidden = false;
  }

  function undo() {
    // In the model view Ctrl-Z belongs to the model - see undoModel.
    if (inModelView()) { undoModel(); } else { undoDoc(active()); }
    // An undo can bring rows back or take them away, so the mask may now name
    // voxels that aren't there - reconcile rather than draw a stale outline.
    pruneSelection();
    afterSelection();
  }

  function redo() {
    if (inModelView()) { redoModel(); } else { redoDoc(active()); }
    pruneSelection();
    afterSelection();
  }

  /* What the rows a batch touches look like RIGHT NOW - the exact inverse of applying
     that batch, so undo and redo are the same operation pointed opposite ways. Taken
     before anything is restored, so every record for a given row holds the same values
     and the backwards walk below is order-independent for them.

     `added` needs no counterpart: the row is never spliced out, so once it exists the
     plain (rgb, type, w, live) form describes both its presence and its absence. */
  function snapshot(docu, batch) {
    var d = docu.payload;
    return batch.map(function (rec) {
      var i = rec.index;
      return { index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] };
    });
  }

  /* Take back one action on ONE part - the active one, or any other, since the model
     view can undo an edit made on a part you have since switched away from. */
  function undoDoc(docu) {
    if (!docu) return;
    var batch = docu.history.pop();
    if (!batch) return;
    docu.redo.push(snapshot(docu, batch));
    applyBatch(docu, batch);
  }

  // The mirror image: put back the last thing undone, and make it undoable again.
  function redoDoc(docu) {
    if (!docu) return;
    var batch = docu.redo.pop();
    if (!batch) return;
    docu.history.push(snapshot(docu, batch));
    applyBatch(docu, batch);
  }

  function applyBatch(docu, batch) {
    var d = docu.payload;
    /* BACKWARDS. A stroke can touch the same voxel more than once - a drag across a
       corner crosses two of its faces, and an add can place a cell and then paint it -
       so a batch may hold several records for one row, each holding the state at the
       moment it was touched. Replaying forwards leaves the LAST one applied, which is a
       mid-stroke state, not the original: the undo appears to do nothing and the model
       stays dirty with no history left to fix it. Going backwards ends on the earliest
       record, which is the one that was true before the stroke began. */
    for (var k = batch.length - 1; k >= 0; k--) {
      var rec = batch[k];
      var i = rec.index;
      if (rec.added) {
        // A row the user placed is retired rather than spliced out: removing it would
        // renumber every row after it, and a dead row costs nothing.
        d.live[i] = 0;
        continue;
      }
      d.rgb[i] = rec.rgb; d.type[i] = rec.type; d.w[i] = rec.w; d.live[i] = rec.live;
      reshade(i, d);
    }
    clearThumb(docu);
    // Undoing a part you are not looking at still has to redraw it - it is on screen as
    // a layer, and its cached geometry is now a frame out of date.
    if (docu !== active()) {
      docu.dirtyMesh = true;
      renderLayers();
      drawStack();
      updateDirty();
      return;
    }
    rebuildIndex();
    if (state.scene) state.scene.rebuild(liveView());
    renderMaterialList();
    renderMeta();
    renderSelection();
    renderLayers();
    updateDirty();
    setStatus('');
  }

  function revertAll() {
    var d = state.data, b = state.base;
    for (var i = 0; i < d.count; i++) {
      var orig = state.origin[i];
      if (orig < 0) { d.live[i] = 0; continue; }     // drop everything user-placed
      d.rgb[i] = b.rgb[orig]; d.type[i] = b.type[orig]; d.w[i] = b.w[orig];
      d.live[i] = 1;
      reshade(i);
    }
    // In place: the document owns these arrays and `state` only aliases them, so
    // reassigning here would leave the part holding the stack we just threw away.
    state.history.length = 0;
    state.redo.length = 0;
    clearThumb(active());
    rebuildIndex();
    if (state.scene) state.scene.rebuild(liveView());
    renderMaterialList();
    renderMeta();
    renderSelection();
    updateDirty();
    setStatus('');
  }

  // ---- saving ------------------------------------------------------------- //

  function save() {
    if (!state.file) return;
    var list = editList();
    setStatus('Saving…');
    var fd = new FormData();
    anchorParts(fd);
    stackParts(fd);
    fetch(apiUrl('/site/blueprint-editor/save'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'The blueprint couldn’t be saved.');
          });
        }
        var ignored = parseInt(res.headers.get('X-Kiwi-Ignored') || '0', 10);
        return res.blob().then(function (blob) { return { blob: blob, ignored: ignored }; });
      })
      .then(function (out) {
        return download(out.blob, state.file.name).then(function (path) {
          if (!path) { setStatus(''); return; }
          setStatus(out.ignored
            ? 'Saved to ' + path + '. ' + out.ignored + ' protected voxels were left untouched.'
            : 'Saved to ' + path + '.', 'ok');
        });
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  // ---- transforms --------------------------------------------------------- //

  /* A rotation renumbers every voxel, so it can't be an entry in the edit map the way a
     recolour is. It goes to the server, comes back as a new blueprint, and the page
     reopens it - which also folds in whatever was pending, so nothing is lost. */
  function runTransform(op) {
    if (!state.file) return;
    var list = editList();
    setStatus('Turning the model…');
    var fd = new FormData();
    fd.append('file', state.file, state.file.name);
    fd.append('edits', JSON.stringify(list));
    fd.append('ops', JSON.stringify([op]));
    fetch(apiUrl('/site/blueprint-editor/transform'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'The model couldn’t be turned.');
          });
        }
        var summary = {};
        try { summary = JSON.parse(res.headers.get('X-Kiwi-Summary') || '{}'); } catch (e) { /* optional */ }
        return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
      })
      .then(function (out) {
        var s = out.summary;
        var label = (state.data.transforms || []).reduce(function (acc, t) {
          return t.op === op ? t.label : acc;
        }, op);
        var bits = [label.toLowerCase()];
        if (s.size_before && s.size_after && s.size_before.join() !== s.size_after.join()) {
          bits.push('now ' + s.size_after.join('×'));
        }
        if (s.attachment) bits.push('attachment point moved with it');
        if (s.entities) bits.push(s.entities.toLocaleString() + ' placed object'
          + (s.entities === 1 ? '' : 's') + ' moved too');
        var file = new File([out.blob], state.file.name);
        var note = 'Applied ' + bits.join(' · ') + '.';
        // In a project only THIS part turned; reopening would throw the model away.
        if (inProject()) replaceActive(file, note);
        else openFile(file, note);
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  /* Swap the part being edited for a new version of itself - what a rotation produces,
     since a transform renumbers every voxel and no edit index survives it. The part
     keeps its place on the rig, and is marked as carrying its own bytes so the save
     posts them: the archive's copy is the un-rotated one. */
  function replaceActive(file, note) {
    var old = active();
    var fd = new FormData();
    fd.append('file', file, file.name);
    fetch(apiUrl('/site/blueprint-editor/inspect'), { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error((b && b.detail) || 'That part couldn’t be reopened.');
          return b;
        });
      })
      .then(function (payload) {
        state.docs[state.active] = makeDoc(file, payload, {
          path: old.path, ap: old.ap, added: old.added, row: old.row, replaced: true,
        });
        if (state.scene) state.scene.clearLayer(old.id);
        setActive(state.active);
        setStatus(note || '', note ? 'ok' : '');
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  /* Two labelled rows of three axis buttons rather than six buttons carrying their full
     names. The full name is still the tooltip and the accessible name - "Flip left-right"
     says what happens where "Flip X" makes you work it out - but six long chips took four
     rows of a panel this now sits at the top of, which is what kept the palette on screen
     when turning was folded away at the bottom. Grouped off the op prefix, so the server
     stays the one place the operation list is defined. */
  function renderTransforms() {
    var ops = state.data.transforms || [];
    var groups = [{ key: 'rotate_', caption: 'Rotate' }, { key: 'mirror_', caption: 'Flip' }];
    $('bpe-transforms').innerHTML = groups.map(function (g) {
      var row = ops.filter(function (t) { return t.op.indexOf(g.key) === 0; });
      if (!row.length) return '';
      return '<span class="bpe-xform-cap">' + esc(g.caption) + '</span>'
        + row.map(function (t) {
          return '<button type="button" class="bpe-xform" data-op="' + t.op + '"'
            + ' title="' + esc(t.label) + '" aria-label="' + esc(t.label) + '">'
            + t.op.slice(-1).toUpperCase() + '</button>';
        }).join('');
    }).join('');
  }

  // ---- the layer stack ------------------------------------------------------ //

  /* Every layer is its own blueprint, with its own voxels, its own edits and its own
     position. One of them is ACTIVE: that is the one you paint, add to and erase from,
     and the only one a click can hit. The rest are drawn alongside it so you can line
     things up against them.

     Layering is NON-DESTRUCTIVE. A layer sitting over another hides what is underneath
     rather than replacing it, so sliding it back off brings the covered voxels straight
     back. The stack is resolved only when something is OUTPUT - download, the checks,
     the .qb export - and that is where the order decides which voxel wins a shared
     cell: the topmost layer that has one. Index 0 is the bottom of the stack.

     The alignment maths is mirrored from merge.py so the live preview and the server
     agree on where a layer sits; merge.py is the authority. */

  function doc(i) { return state.docs[i] || null; }
  function active() { return state.docs[state.active] || null; }

  function anchorDoc() { return state.docs[state.anchor] || null; }

  function alignOffset(d, mode) {
    var b = anchorDoc();
    if (!b || !d || d === b) return [0, 0, 0];
    if (mode === 'corner') return [0, 0, 0];
    if (mode === 'centre') {
      return [0, 1, 2].map(function (i) {
        return Math.round((b.payload.size[i] - 1) / 2 - (d.payload.size[i] - 1) / 2);
      });
    }
    if (!b.payload.attachment || !d.payload.attachment) return null;
    return [0, 1, 2].map(function (i) {
      return b.payload.attachment[i] - d.payload.attachment[i];
    });
  }

  /* Where a layer's grid sits in the stack's shared space. The bottom layer defines
     that space, so it is always at zero. */
  function placement(d) {
    if (!d || d === anchorDoc()) return [0, 0, 0];
    var base = alignOffset(d, d.mode);
    if (!base) return null;
    return [base[0] + d.offset[0], base[1] + d.offset[1], base[2] + d.offset[2]];
  }

  /* Compact a document's live voxels for the mesher. */
  function viewOf(d) {
    var p = d.payload;
    var v = { count: 0, size: p.size, x: [], y: [], z: [], rgb: [],
              kind: [], level: [], spec: [] };
    for (var i = 0; i < p.count; i++) {
      if (!p.live[i]) continue;
      v.x.push(p.x[i]); v.y.push(p.y[i]); v.z.push(p.z[i]); v.rgb.push(p.rgb[i]);
      v.kind.push(p.kind[i]); v.level.push(p.level[i]); v.spec.push(p.spec[i]);
      v.count++;
    }
    return v;
  }

  /* Draw the stack: the active document as the main (pickable) model at its own
     offset, every other visible one as a layer beside it. Isolate hides the rest
     without changing what any of them are - overlapping voxels make a model
     impossible to read, and this is how you get at the one you mean. */
  function drawStack() {
    if (!state.scene || !state.docs.length) return;
    if (inProject()) return drawProject();
    var a = active();
    var at = placement(a) || [0, 0, 0];
    state.scene.setModelOffset(at[0], at[1], at[2]);
    state.scene.clearLayers();
    state.docs.forEach(function (d, i) {
      if (i === state.active) return;
      if (!d.visible || state.isolate) return;
      var t = placement(d);
      if (!t) return;
      state.scene.setLayer(d.id, viewOf(d), 0x6e7785);
      state.scene.moveLayer(d.id, t[0], t[1], t[2]);
    });
  }

  /* What the flattened output would contain, so the numbers are honest before anything
     is downloaded. Bottom to top, last writer wins - the rule the server applies. */
  function stackStats() {
    var cells = new Set();
    var hidden = 0;
    state.docs.forEach(function (d) {
      var t = placement(d);
      if (!t) return;
      var p = d.payload;
      for (var i = 0; i < p.count; i++) {
        if (!p.live[i]) continue;
        var k = (p.x[i] + t[0]) + ',' + (p.y[i] + t[1]) + ',' + (p.z[i] + t[2]);
        if (cells.has(k)) hidden++;
        cells.add(k);
      }
    });
    return { total: cells.size, hidden: hidden };
  }

  function makeDoc(file, payload, extra) {
    payload.live = [];
    var origin = [];
    for (var i = 0; i < payload.count; i++) { payload.live.push(1); origin.push(i); }
    var d = {
      id: 'D' + (state.docSeq++),
      file: file,
      payload: payload,
      base: { rgb: payload.rgb.slice(), type: payload.type.slice(), w: payload.w.slice() },
      origin: origin,
      history: [],
      redo: [],
      mode: 'attachment',
      offset: [0, 0, 0],
      visible: true,
      // Model projects: where this part lives in the mod, which bone it hangs off, how
      // far it has been slid along that bone, and where it sits in the row when it
      // hangs off no bone at all.
      path: '',
      ap: null,
      added: false,
      locked: false,
      move: [0, 0, 0],
      row: [0, 0, 0],
    };
    return Object.assign(d, extra || {});
  }

  /* Switching which document is being edited swaps the whole working set - the arrays
     the tools read, the pristine copy the save diff is taken against, and the undo
     stack, which belongs to the document rather than to the session. */
  function setActive(i) {
    if (i < 0 || i >= state.docs.length) return;
    // Whatever we're leaving may have been painted on, so its cached layer geometry is
    // stale from here on. One re-mesh on the way out; nothing else is touched.
    if (state.docs[state.active]) state.docs[state.active].dirtyMesh = true;
    state.active = i;
    var d = state.docs[i];
    state.file = d.file;
    state.data = d.payload;
    state.base = d.base;
    state.origin = d.origin;
    state.history = d.history;
    state.redo = d.redo;
    state.selection = -1;
    state.sel = null;   // see openPayload: rows belong to one document
    // Parts differ in size, so the layer you were on may not exist on this one. The
    // axis is kept - you are still slicing the same way - and the index is clamped.
    state.slice.at = Math.min(state.slice.at, sliceMax());
    cancelBox();
    rebuildIndex();
    renderSlice();
    renderKinds();
    renderTransforms();
    renderPalette();
    renderMaterialList();
    renderMeta();
    renderSelection();
    renderLayers();
    updateDirty();
    if (state.scene) {
      state.scene.rebuild(liveView());   // liveView, not viewOf: it applies the slice
      drawStack();
      drawAttachment();
      // Working on one part at a time, switching to another has to bring it into view -
      // the last one framed the camera, and the new one can be anywhere on the creature.
      if (inProject() && state.isolate) state.scene.frameAll();
    }
  }

  function addLayer(file) {
    if (!file) return;
    if (state.docs.length >= 8) {
      setStatus('That is as many layers as one stack takes.', 'error');
      return;
    }
    setStatus('Reading ' + file.name + '...');
    var fd = new FormData();
    fd.append('file', file, file.name);
    fetch(apiUrl('/site/blueprint-editor/inspect'), { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error((b && b.detail) || 'That blueprint could not be opened.');
          return b;
        });
      })
      .then(function (payload) {
        var d = makeDoc(file, payload);
        // Line the grips up by default; fall back when one side hasn't got one.
        var anc = anchorDoc();
        d.mode = (anc && anc.payload.attachment && payload.attachment)
          ? 'attachment' : 'centre';
        state.docs.push(d);
        setActive(state.docs.length - 1);
        setStatus('Layered in ' + payload.name
          + '. It is the layer you are editing - use Move to drag it about.', 'ok');
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  function removeLayer(i) {
    if (!state.docs[i] || state.docs.length < 2) return;
    if (i === state.anchor) {
      setStatus('That layer is the anchor everything else is placed against. Make '
        + 'another layer the anchor first.', 'error');
      return;
    }
    if (state.scene) state.scene.clearLayer(state.docs[i].id);
    state.docs.splice(i, 1);
    if (state.anchor > i) state.anchor--;
    setActive(Math.min(state.active, state.docs.length - 1));
  }

  /* Reordering only changes who wins a shared cell. The anchor is a separate idea, so
     it follows its document rather than staying at an index. */
  function reorderLayer(i, dir) {
    var j = i + dir;
    if (i < 0 || j < 0 || i >= state.docs.length || j >= state.docs.length) return;
    var tmp = state.docs[i];
    state.docs[i] = state.docs[j];
    state.docs[j] = tmp;
    if (state.anchor === i) state.anchor = j;
    else if (state.anchor === j) state.anchor = i;
    setActive(state.active === i ? j : (state.active === j ? i : state.active));
  }

  /* Make a layer the frame. Everything else keeps the position it is SHOWN at, so
     changing the anchor re-describes the arrangement rather than rearranging it -
     otherwise picking a new anchor would scatter the models you had just lined up. */
  function setAnchor(i) {
    if (!state.docs[i] || i === state.anchor) return;
    var world = state.docs.map(placement);
    state.anchor = i;
    state.docs.forEach(function (d, k) {
      if (k === i) { d.offset = [0, 0, 0]; return; }
      var here = world[k], there = world[i];
      if (!here || !there) { d.offset = [0, 0, 0]; return; }
      var base = alignOffset(d, d.mode) || [0, 0, 0];
      d.offset = [here[0] - there[0] - base[0],
                  here[1] - there[1] - base[1],
                  here[2] - there[2] - base[2]];
    });
    renderLayers();
    drawStack();
  }

  function nudgeActive(dx, dy, dz) {
    var d = active();
    if (!d) return;
    // In a model the same buttons slide the part along its bone instead of moving a
    // layer around a shared grid - a different thing to store, the same gesture.
    if (inProject()) return movePart(d, [dx, dy, dz]);
    if (d === anchorDoc()) return;
    d.offset = [d.offset[0] + dx, d.offset[1] + dy, d.offset[2] + dz];
    renderLayers();
    drawStack();
  }

  /* The parts of a model. One LINE each - a creature has twenty of them, and a row that
     carries its own dropdown is a panel you scroll past rather than read. The socket
     picker is a single control below the list, for the part that's selected. */
  function renderParts() {
    var r = rig();
    computePartPrefix();
    var rows = state.docs.map(function (d, i) {
      var placed = placedOn(d);
      var moved = d.move[0] || d.move[1] || d.move[2];
      var where = placed ? d.ap.replace(/_/g, ' ')
        : (r ? 'not placed' : liveCountOf(d).toLocaleString() + ' voxels');
      var thumb = partThumb(d);
      return '<li class="bpe-partrow' + (i === state.active ? ' active' : '')
        + (state.ask === i && !placed ? ' asking' : '') + (placed ? '' : ' unplaced') + '">'
        + '<button type="button" class="bpe-layerpick" data-pick="' + i + '">'
        + (thumb ? '<img class="bpe-partthumb" alt="" src="' + thumb + '">'
                 : '<span class="bpe-partthumb"></span>')
        + (placed ? '' : '<i class="fa-solid fa-circle-question bpe-unplacedmark"'
                       + ' aria-hidden="true"></i>')
        + '<strong>' + esc(partLabel(d)) + '</strong>'
        + '<span class="bpe-partap">' + esc(where)
        + (d.added ? ' · new' : '') + (moved ? ' · moved' : '') + '</span></button>'
        + '<button type="button" class="bpe-layerbtn bpe-lockbtn' + (d.locked ? ' on' : '')
        + '" data-lock="' + i + '" aria-pressed="' + !!d.locked
        + '" aria-label="' + (d.locked ? 'Unlock ' : 'Lock ') + esc(d.payload.name)
        + '" title="' + (d.locked ? 'Locked in place — click to allow moving it'
                                  : 'Can be moved — click to lock it')
        + '"><i class="fa-solid fa-lock' + (d.locked ? '' : '-open')
        + '" aria-hidden="true"></i></button>'
        + '<button type="button" class="bpe-layerbtn" data-vis="' + i
        + '" aria-label="Show or hide ' + esc(d.payload.name) + '" aria-pressed="'
        + (!d.visible) + '" title="Show or hide"><i class="fa-solid fa-eye'
        + (d.visible ? '' : '-slash') + '" aria-hidden="true"></i></button>'
        + '<button type="button" class="bpe-layerbtn" data-drop="' + i
        + '" aria-label="Remove ' + esc(d.payload.name) + '" title="Remove this part"'
        + (state.docs.length < 2 ? ' disabled' : '')
        + '><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>'
        + '</li>';
    });
    $('bpe-layerlist').innerHTML = rows.join('');
    // A model's parts are not a layer stack - they sit on bones and are saved apart -
    // so union has nothing to mean here and goes rather than sitting dead.
    $('bpe-unionblock').hidden = true;
    $('bpe-flatten').disabled = true;
    // The nudge buttons stay - they slide the part along its bone here - but there is
    // nothing to align against, so the alignment picker goes.
    var a = active();
    // The nudge control folds away with the rest of the occasional ones; a part is
    // locked on arrival, so it is not the first thing anybody reaches for.
    $('bpe-movefold').hidden = false;
    $('bpe-movefold-label').textContent = 'Move on the rig';
    $('bpe-layerctl').classList.add('bpe-noalign');
    if (a) renderMoveNudge(a);
    renderApPicker();
    renderStageBar();

    var unplaced = state.docs.filter(function (d) { return !placedOn(d); }).length;
    var p = state.project;
    $('bpe-layerinfo').textContent = r
      ? (state.docs.length + ' parts on the ' + r.name.replace(/_/g, ' ') + ' rig'
         + (unplaced ? ' · ' + unplaced + ' to place' : '')
         + (p.extras ? ' · ' + p.extras + ' other file'
            + (p.extras === 1 ? '' : 's') + ' kept' : ''))
      : ('No matching creature in the game data, so the parts are laid out side by '
         + 'side. They still save back exactly where they came from.');
    renderToolHint();
  }

  /* Where the selected part attaches. One control, always in the same place, so it is
     both the answer to "what is this part" and the question asked of a part just added. */
  function renderApPicker() {
    var box = $('bpe-apctl'), sel = $('bpe-apsel'), d = active();
    var opts = sockets();
    box.hidden = !d;
    if (!d) return;
    var asking = state.ask === state.active && !placedOn(d);
    box.classList.toggle('asking', asking);
    $('bpe-aplabel').textContent = asking ? 'Where does ' + partLabel(d) + ' go?'
                                          : 'Attaches at';
    var want = d.id + ':' + opts.length;
    if (sel.dataset.built !== want) {
      sel.dataset.built = want;
      sel.innerHTML = '<option value="">'
        + (opts.length ? 'Not placed' : 'No rig for this model') + '</option>'
        + opts.map(function (k) {
            return '<option value="' + esc(k) + '">' + esc(k.replace(/_/g, ' ')) + '</option>';
          }).join('');
      sel.disabled = !opts.length;
    }
    if (sel.value !== (d.ap || '')) {
      sel.value = d.ap || '';
      syncDropdown(sel);
    }
    /* Focus the question rather than only colouring it - and on a timeout, aimed at the
       TRIGGER: the site's shared dropdown swaps every <select> for a button from a
       MutationObserver, so focusing the select we just wrote would lose the focus the
       moment it is hidden behind one. */
    if (asking && opts.length) {
      setTimeout(function () {
        var dd = sel.closest('.btt-dd');
        var target = dd ? dd.querySelector('.btt-dd-trigger') : sel;
        if (target) target.focus();
      }, 0);
    }
  }

  /* The stage's own controls: which part, whether the rest of the model is showing, and
     whether it is animating. They belong here rather than in a panel because they are
     what you reach for WHILE looking at the model. */
  function renderStageBar() {
    var on = inProject();
    var pick = $('bpe-stagepart');
    pick.hidden = !on;
    $('bpe-filename').hidden = on;
    if (on) {
      var want = state.docs.map(function (d) { return d.id; }).join(',');
      if (pick.dataset.built !== want) {
        pick.dataset.built = want;
        pick.innerHTML = state.docs.map(function (d, i) {
          return '<option value="' + i + '">' + esc(partLabel(d))
            + (placedOn(d) ? ' — ' + esc(d.ap.replace(/_/g, ' ')) : '') + '</option>';
        }).join('');
      }
      if (pick.value !== String(state.active)) {
        pick.value = String(state.active);
        syncDropdown(pick);
      }
    }
    var iso = $('bpe-isolate');
    iso.disabled = !on || state.docs.length < 2 || state.anim.on;
    iso.setAttribute('aria-pressed', String(!!state.isolate));
    $('bpe-isolate-label').textContent = state.isolate ? 'Show the whole model'
                                                       : 'This part only';
    iso.querySelector('i').className = state.isolate
      ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
    var play = $('bpe-animate');
    play.setAttribute('aria-pressed', String(!!state.anim.on));
    $('bpe-animate-label').textContent = state.anim.on ? 'Back to editing' : 'Animate';
    play.querySelector('i').className = state.anim.on
      ? 'fa-solid fa-pen' : 'fa-solid fa-play';
  }

  function renderLayers() {
    if (!state.docs.length) return;
    if (inProject()) return renderParts();
    var multi = state.docs.length > 1;
    // Kept on screen with one layer, disabled: that is how somebody finds out union is
    // there before they have a second layer to use it on.
    $('bpe-unionblock').hidden = false;
    $('bpe-flatten').disabled = !multi;
    $('bpe-isolate').disabled = !multi;
    $('bpe-isolate').setAttribute('aria-pressed', String(!!state.isolate));

    // Topmost first, because that is the one that wins.
    var rows = [];
    for (var i = state.docs.length - 1; i >= 0; i--) {
      var d = state.docs[i];
      var t = placement(d);
      var isAnchor = (i === state.anchor);
      rows.push('<li class="bpe-layerrow' + (i === state.active ? ' active' : '')
        + (isAnchor ? ' anchored' : '') + '">'
        + '<button type="button" class="bpe-layerpick" data-pick="' + i + '">'
        + '<strong>' + esc(d.payload.name) + '</strong><span>'
        + liveCountOf(d).toLocaleString() + ' voxels'
        + (isAnchor ? ' - anchor'
                    : (t ? ' at ' + t.join(', ') : ' - cannot line up this way'))
        + '</span></button>'
        + '<button type="button" class="bpe-layerbtn bpe-anchorbtn'
        + (isAnchor ? ' on' : '') + '" data-anchor="' + i + '" aria-pressed="' + isAnchor
        + '" aria-label="Use as the anchor"><i class="fa-solid fa-thumbtack"'
        + ' aria-hidden="true"></i></button>'
        + '<button type="button" class="bpe-layerbtn" data-vis="' + i
        + '" aria-label="Show or hide"' + (isAnchor ? ' disabled' : '')
        + '><i class="fa-solid fa-eye' + (d.visible ? '' : '-slash')
        + '" aria-hidden="true"></i></button>'
        + '<button type="button" class="bpe-layerbtn" data-up="' + i + '" aria-label="Move up"'
        + (i === state.docs.length - 1 ? ' disabled' : '') + '>&uarr;</button>'
        + '<button type="button" class="bpe-layerbtn" data-down="' + i + '" aria-label="Move down"'
        + (i === 0 ? ' disabled' : '') + '>&darr;</button>'
        + '<button type="button" class="bpe-layerbtn" data-drop="' + i
        + '" aria-label="Remove layer"' + (isAnchor ? ' disabled' : '')
        + '><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>'
        + '</li>');
    }
    $('bpe-layerlist').innerHTML = rows.join('');

    var a = active();
    var movable = a && a !== anchorDoc();
    $('bpe-movefold').hidden = !movable;
    $('bpe-movefold-label').textContent = 'Line it up';
    if (movable) { renderAlignModes(a); renderNudge(a); }

    var st = stackStats();
    $('bpe-layerinfo').textContent = multi
      ? ('Flattens to ' + st.total.toLocaleString() + ' voxels'
         + (st.hidden ? ' - ' + st.hidden.toLocaleString()
            + ' hidden underneath, still there until you save' : ''))
      : '';
    renderToolHint();
  }

  function liveCountOf(d) {
    var n = 0;
    for (var i = 0; i < d.payload.count; i++) if (d.payload.live[i]) n++;
    return n;
  }

  function renderAlignModes(d) {
    var modes = (anchorDoc() || state.docs[0]).payload.align_modes || [];
    $('bpe-align').innerHTML = modes.map(function (m) {
      return '<option value="' + m.mode + '"' + (m.mode === d.mode ? ' selected' : '')
        + '>' + esc(m.label) + '</option>';
    }).join('');
  }

  function renderNudge(d) {
    ['x', 'y', 'z'].forEach(function (a, i) {
      var v = d.offset[i];
      $('bpe-nudge-' + a).textContent = (v > 0 ? '+' : '') + v;
    });
  }

  function renderMoveNudge(d) {
    var box = $('bpe-nudge');
    box.classList.toggle('bpe-locked-move', !!d.locked);
    box.querySelectorAll('button').forEach(function (b) { b.disabled = !!d.locked; });
    ['x', 'y', 'z'].forEach(function (a, i) {
      var v = d.move[i];
      $('bpe-nudge-' + a).textContent = (v > 0 ? '+' : '') + v;
    });
  }

  /* The stack as the output endpoints want it: layer 0 is the base file, the rest ride
     as `layers` bottom to top with a spec each - placement AND their own edits, since
     every layer is a blueprint someone may have painted on. */
  function stackParts(fd) {
    // A model's parts aren't a stack - they sit on bones, and every per-part tool
    // (the checks, the .qb export) runs on the one part you're editing.
    if (inProject() || state.docs.length < 2) return;
    var others = state.docs.filter(function (_, i) { return i !== state.anchor; });
    others.forEach(function (d) { fd.append('layers', d.file, d.file.name); });
    fd.append('stack', JSON.stringify(others.map(function (d) {
      return { mode: d.mode, offset: d.offset, edits: editListOf(d) };
    })));
    // Where the anchor sits in the stacking order - separate from being the frame.
    fd.append('anchor_at', String(state.anchor));
  }

  function anchorParts(fd) {
    var a = inProject() ? active() : anchorDoc();
    fd.append('file', a.file, a.file.name);
    fd.append('edits', JSON.stringify(editListOf(a)));
  }

  function flattenStack() {
    if (state.docs.length < 2) return;
    setStatus('Unioning the layers...');
    var fd = new FormData();
    anchorParts(fd);
    stackParts(fd);
    fetch(apiUrl('/site/blueprint-editor/flatten'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'The layers could not be unioned.');
          });
        }
        var summary = {};
        try { summary = JSON.parse(res.headers.get('X-Kiwi-Summary') || '{}'); } catch (e) { /* optional */ }
        return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
      })
      .then(function (out) {
        var s = out.summary;
        var bits = [s.voxels.toLocaleString() + ' voxels from ' + ((s.layers || 0) + 1) + ' models'];
        if (s.hidden) bits.push(s.hidden.toLocaleString() + ' overlapping cell'
          + (s.hidden === 1 ? '' : 's') + ' went to the layer above');
        if (s.entities) bits.push(s.entities);
        var name = anchorDoc().file.name;
        openFile(new File([out.blob], name),
                 'Unioned into one blueprint - ' + bits.join(' - ') + '.');
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  // ---- model projects ----------------------------------------------------- //

  /* A Trove model is not one file. A mount is a head, a jaw, four legs, a body and a
     tail, each its own .blueprint, assembled onto a skeleton by the game. Opening them
     one at a time meant recolouring a dragon sixteen times over without once seeing the
     dragon, so a project opens the whole set.

     Each part is one of the same documents the layer stack uses - its own voxels, its
     own edits, its own undo - and the ONLY difference is how it is placed: by the bone
     it attaches to rather than by a grid offset. `matrixFor` is that difference.

     WHERE A PART GOES IS NEVER GUESSED. The rig and each part's attach point come from
     the game's own prefab bindings, and a part the game doesn't place sits beside the
     model until somebody says where it goes. A part dropped in later is somebody
     saying: they pick the socket, we place it. */

  function b64bytes(s) {
    var bin = atob(s), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* Open a .tmod / .zip, or a pile of loose .blueprint files, as one model. */
  function openModel(input, done, fail) {
    var many = !(input instanceof File);
    state.openWith = many
      ? { kind: 'files', files: Array.prototype.slice.call(input) }
      : { kind: 'archive', file: input };
    var fd = new FormData();
    if (many) {
      Array.prototype.forEach.call(input, function (f) { fd.append('files', f, f.name); });
    } else {
      fd.append('file', input, input.name);
    }
    setStatus('Opening ' + (many ? input.length + ' parts' : input.name) + '…');
    fetch(apiUrl('/site/blueprint-editor/model'), { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error((b && b.detail) || 'That model couldn’t be opened.');
          return b;
        });
      })
      .then(function (payload) {
        loadProject(payload, many ? null : input);
        if (done) done();
      })
      .catch(function (err) {
        if (fail) fail(err); else setStatus(err.message || String(err), 'error');
      });
  }

  function loadProject(payload, archive) {
    state.project = {
      file: archive || null,          // null for a project of loose files
      name: payload.name,
      source: payload.source,
      rig: payload.rig || null,
      skipped: payload.skipped || [],
      extras: payload.extras || 0,
      history: [],          // model-level undo: parts moved, parts re-socketed
      redo: [],
    };
    state.docs = payload.parts.map(function (p) {
      // Each part carries its own bytes, so every single-file tool - the checks, the
      // .qb export, a rotation - keeps working on one part of a project unchanged.
      var file = new File([b64bytes(p.blueprint)], p.name);
      return makeDoc(file, p.model, { path: p.path, ap: p.ap || null, locked: true });
    });
    state.active = 0;
    state.anchor = 0;
    mount(projectNote(payload));
  }

  function projectNote(payload) {
    var bits = [payload.parts.length + ' part' + (payload.parts.length === 1 ? '' : 's')];
    var placed = payload.parts.filter(function (p) { return p.ap; }).length;
    if (payload.rig) {
      bits.push(placed + ' of them on the ' + payload.rig.name.replace(/_/g, ' ') + ' rig');
    } else {
      bits.push('no matching creature in the game data, so they’re laid out side by side');
    }
    if (payload.skipped.length) {
      bits.push(payload.skipped.length + ' couldn’t be opened');
    }
    return 'Opened ' + payload.name + ' — ' + bits.join(', ') + '.';
  }

  /* The panel says "Layers" for a stack and "Parts" for a model, because they are not
     the same idea: layers cover each other and flatten into one file, parts sit on
     different bones and stay separate files for ever. Same controls, different truth. */
  function renderMode() {
    var on = inProject();
    var set = function (id, text) { var el = $(id); if (el) el.textContent = text; };
    set('bpe-save-label', on ? 'Save the model' : 'Save');
    set('bpe-layers-title', on ? 'Parts' : 'Layers');
    set('bpe-layer-open-label', on ? 'Add a part' : 'Add a layer');
    // The Creations checks grade one submitted item against its type's rules; a part of
    // a creature isn't one, so the whole block goes rather than sitting there inert.
    $('bpe-checkblock').hidden = on;
    set('bpe-layers-hint', on
      ? 'Middle-click (or shift-click) a part in the view to work on it; double-click '
        + 'to work on it on its own.'
      : 'Each layer is its own blueprint. Pick one to edit it, drag it about with the '
        + 'Move tool, and reorder them — on save the top layer wins wherever two '
        + 'overlap.');
    $('bpe-page').classList.toggle('bpe-animating', false);
    if (on) buildAnimBar();
    else {
      $('bpe-animbar').hidden = true;
      $('bpe-animate').hidden = true;
    }
    renderStageBar();
  }

  /* The site replaces every <select> with its own combobox and keeps the real one
     hidden as the value - so code that sets `.value` has to tell the control to
     repaint, or the button still shows what was selected before. */
  function syncDropdown(sel) {
    if (window.BTTDropdown) window.BTTDropdown.refresh(sel);
  }

  function inProject() { return !!state.project; }
  function rig() { return state.project && state.project.rig; }

  /* What to CALL a part in a list of them. Trove names every part of a creature after
     the creature - `c_mt_raptor_birdgold_body`, `c_mt_raptor_birdgold_l_foot` - so a
     column of them truncates to twelve identical rows reading "c_mt_raptor_birdgol…".
     The shared opening is dropped (at an underscore, so nothing is cut mid-word), which
     leaves exactly the part that differs: body, l foot, r foot. One part keeps its whole
     name, since there is nothing to tell it apart from. */
  /* ---- part thumbnails -------------------------------------------------------
     A row that says "l_thigh" tells you the name of a part; a picture tells you which
     part it is. Drawn HERE, from the voxels already in the page, rather than asked of
     the renderer: the parts are not stored anywhere to ask about (the editor is
     stateless), a part just added has never existed server-side at all, and one you
     have painted would answer with its old colours.

     Isometric, with a one-pixel z-buffer instead of sorting: every voxel projects to a
     screen cell and only the nearest survives, which is O(n) and draws each pixel once.
     Depth doubles as shading - nearer is lighter - so the silhouette reads as a shape
     rather than a flat blob without needing face normals. */
  var THUMB = 26;

  function partThumb(d) {
    if (d.thumb !== undefined) return d.thumb;
    d.thumb = drawThumb(d.payload);
    return d.thumb;
  }

  function drawThumb(p) {
    var n = p.count, i, x, y, z;
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], any = false;
    for (i = 0; i < n; i++) {
      if (!p.live[i]) continue;
      any = true;
      x = p.x[i] - p.z[i];
      y = (p.x[i] + p.z[i]) * 0.5 - p.y[i];
      if (x < lo[0]) lo[0] = x;
      if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y;
      if (y > hi[1]) hi[1] = y;
    }
    if (!any) return null;

    var S = THUMB * 2;                                  // backing pixels (for retina)
    var span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1);
    var k = (S - 2) / (span + 1);
    var offX = (S - (hi[0] - lo[0]) * k) / 2 - lo[0] * k;
    var offY = (S - (hi[1] - lo[1]) * k) / 2 - lo[1] * k;

    var cells = new Map(), dmin = Infinity, dmax = -Infinity;
    for (i = 0; i < n; i++) {
      if (!p.live[i]) continue;
      var depth = p.x[i] + p.y[i] + p.z[i];
      if (depth < dmin) dmin = depth;
      if (depth > dmax) dmax = depth;
      var px = Math.round((p.x[i] - p.z[i]) * k + offX);
      var py = Math.round(((p.x[i] + p.z[i]) * 0.5 - p.y[i]) * k + offY);
      var key = px * 4096 + py;
      var was = cells.get(key);
      if (!was || depth > was[2]) cells.set(key, [px, py, depth, p.rgb[i]]);
    }

    var canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    var g = canvas.getContext('2d');
    var range = (dmax - dmin) || 1;
    var size = Math.max(1, Math.ceil(k));
    cells.forEach(function (c) {
      var shade = 0.72 + 0.28 * ((c[2] - dmin) / range);
      var r = Math.min(255, ((c[3] >> 16) & 255) * shade) | 0;
      var gg = Math.min(255, ((c[3] >> 8) & 255) * shade) | 0;
      var b = Math.min(255, (c[3] & 255) * shade) | 0;
      g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
      g.fillRect(c[0], c[1], size, size);
    });
    return canvas.toDataURL('image/png');
  }

  // A part that changed no longer looks like its picture.
  function clearThumb(d) { if (d) d.thumb = undefined; }

  function indexOfDoc(id) {
    for (var i = 0; i < state.docs.length; i++) if (state.docs[i].id === id) return i;
    return -1;
  }

  function partLabel(d) {
    var name = d.payload.name.replace(/\.blueprint$/i, '');
    // computePartPrefix has already checked every part shares it and keeps something.
    return state.partPrefix ? name.slice(state.partPrefix) : name;
  }

  function computePartPrefix() {
    state.partPrefix = 0;
    if (!inProject() || state.docs.length < 2) return;
    var names = state.docs.map(function (d) {
      return d.payload.name.replace(/\.blueprint$/i, '');
    });
    var first = names[0], i = 0;
    while (i < first.length) {
      var ch = first[i];
      if (!names.every(function (n) { return n[i] === ch; })) break;
      i++;
    }
    // back off to the last underscore inside the shared run, and only bother when it
    // actually buys something
    var cut = first.lastIndexOf('_', i - 1) + 1;
    state.partPrefix = (cut > 3 && names.every(function (n) { return n.length > cut; }))
      ? cut : 0;
  }

  /* Every socket this skeleton has, whether or not the mod fills it - the list you pick
     from when you add a part. A rig that carries no `hat` point can't be given a hat,
     and that is exactly the thing to say rather than let someone place one nowhere. */
  function sockets() {
    var r = rig();
    return r ? Object.keys(r.rest).sort() : [];
  }

  // 4x4 matrices, column-major like the baked rigs and three.js both store them.
  function matMul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        var v = 0;
        for (var k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = v;
      }
    }
    return o;
  }
  function matScale(s) { return [s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]; }
  function matTrans(x, y, z) { return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]; }
  function matPoint(m, x, y, z) {
    return [m[0]*x + m[4]*y + m[8]*z + m[12],
            m[1]*x + m[5]*y + m[9]*z + m[13],
            m[2]*x + m[6]*y + m[10]*z + m[14]];
  }

  /* THE FRAME CHANGE, and it is not optional: the editor and the rig read the same file
     in two different spaces.

     A blueprint decodes to box-local coordinates with X MIRRORED (Qubicle's convention,
     which is what every tool on this page edits in), while the assembled-creature
     pipeline reads it un-mirrored and adds the model's ORIGIN - the v5 header's `pos`,
     or for v3/v4 the corner its absolute coordinates are written around. So:

         rig = (origin.x + size.x - 1 - x,  origin.y + y,  origin.z + z)

     Skip it and every part lands mirrored and offset by its own origin, which looks
     exactly like a creature that has come apart at the joints. `origin` arrives with
     each part's payload; the same arithmetic covers both versions.

     `move` rides in the same place, because sliding a part along its bone IS a change of
     origin - see `transform.move_on_rig`, which is what the server does on save. */
  function frameOf(d) {
    var o = d.payload.origin || [0, 0, 0];
    var m = d.move;
    // Identity on X. This used to carry a -1 and a `+ size - 1` to undo the mirror
    // the codec applied on decode; the codec no longer applies one, so neither does
    // this - and a part frame that scales by -1 flips its own face winding too.
    return [1,0,0,0, 0,1,0,0, 0,0,1,0,
            o[0] + m[0], o[1] + m[1], o[2] + m[2], 1];
  }

  function placedOn(d) {
    var r = rig();
    return !!(r && d.ap && r.rest[d.ap]);
  }

  /* Where a part sits. On its bone if it has one - the rig's rest matrix times the voxel
     size, which is what the 3D viewers do with the same numbers - and otherwise in the
     row `layoutUnplaced` works out, off to one side of the model. */
  function placeMatrix(d) {
    var r = rig();
    var vs = r ? r.voxel_scale : 1;
    return placedOn(d)
      ? matMul(r.rest[d.ap], matScale(vs * (r.scales[d.ap] || 1)))
      : matMul(matTrans(d.row[0], d.row[1], d.row[2]), matScale(vs));
  }

  function matrixFor(d) { return matMul(placeMatrix(d), frameOf(d)); }

  var BOX_CORNERS = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,0],[1,0,1],[0,1,1],[1,1,1]];

  /* Unplaced parts go in a row beside the model rather than all at the origin on top of
     each other. Measured off whatever IS placed, so the row clears the creature however
     big it is, and each part gets its own width of space. Each one's own origin is
     subtracted back out, so the row lines up on the models rather than on wherever their
     bones would have put them. */
  function layoutUnplaced() {
    var r = rig();
    var vs = r ? r.voxel_scale : 1;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    state.docs.forEach(function (d) {
      if (!placedOn(d)) return;
      var m = matrixFor(d), s = d.payload.size;
      BOX_CORNERS.forEach(function (c) {
        var p = matPoint(m, c[0] * (s[0] - 1), c[1] * (s[1] - 1), c[2] * (s[2] - 1));
        for (var i = 0; i < 3; i++) {
          if (p[i] < lo[i]) lo[i] = p[i];
          if (p[i] > hi[i]) hi[i] = p[i];
        }
      });
    });
    var placed = isFinite(lo[0]);
    var gap = (placed ? (hi[0] - lo[0]) * 0.12 : 0) + vs * 2;
    var x = placed ? hi[0] + gap : 0;
    var y = placed ? lo[1] : 0;
    var z = placed ? (lo[2] + hi[2]) / 2 : 0;
    state.docs.forEach(function (d) {
      if (placedOn(d)) { d.row = [0, 0, 0]; return; }
      var s = d.payload.size, o = d.payload.origin || [0, 0, 0];
      d.row = [x - o[0] * vs, y - o[1] * vs, z - (s[2] * vs) / 2 - o[2] * vs];
      x += s[0] * vs + gap;
    });
  }

  /* ---- moving a part along its bone ------------------------------------------
     The drag arrives in WORLD space and the move has to be whole voxels in the part's
     own frame, which is rotated (and mirrored) by whatever bone it hangs off. So the
     world delta is pushed back through the part's own basis, accumulated, and handed
     over a voxel at a time - the leftover fraction is kept, so a slow drag still moves
     smoothly instead of sticking. */

  /* The basis a MOVE lives in - the placement alone, without the frame change.
     `move` is added to the origin, which is a translation applied after the mirror, so
     the mirror does not act on it: including it would make a part slide left when the
     cursor went right, and would write the opposite sign into the file. */
  function basisOf(d) {
    var m = placeMatrix(d);
    return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  }

  function invert3(a) {
    var c0 = a[4]*a[8] - a[5]*a[7], c1 = a[5]*a[6] - a[3]*a[8], c2 = a[3]*a[7] - a[4]*a[6];
    var det = a[0]*c0 + a[1]*c1 + a[2]*c2;
    if (!det) return null;
    var i = 1 / det;
    return [c0*i, (a[2]*a[7] - a[1]*a[8])*i, (a[1]*a[5] - a[2]*a[4])*i,
            c1*i, (a[0]*a[8] - a[2]*a[6])*i, (a[2]*a[3] - a[0]*a[5])*i,
            c2*i, (a[1]*a[6] - a[0]*a[7])*i, (a[0]*a[4] - a[1]*a[3])*i];
  }

  function mul3(m, v) {
    return [m[0]*v[0] + m[3]*v[1] + m[6]*v[2],
            m[1]*v[0] + m[4]*v[1] + m[7]*v[2],
            m[2]*v[0] + m[5]*v[1] + m[8]*v[2]];
  }

  function dragPart(wx, wy, wz) {
    var d = active();
    if (!d || !canMove(d)) return;
    var inv = invert3(basisOf(d));
    if (!inv) return;
    var l = mul3(inv, [wx, wy, wz]);
    var acc = state.moveAccum;
    acc[0] += l[0]; acc[1] += l[1]; acc[2] += l[2];
    var step = [Math.round(acc[0]), Math.round(acc[1]), Math.round(acc[2])];
    if (!step[0] && !step[1] && !step[2]) return;
    acc[0] -= step[0]; acc[1] -= step[1]; acc[2] -= step[2];
    movePart(d, step);
  }

  /* Parts arrive LOCKED. A model is opened to be painted far more often than to be
     re-rigged, and the cost of the two mistakes is not symmetric: a stray brush stroke
     is one Ctrl-Z, a part nudged off its bone without noticing is a model that looks
     right here and sits wrong in game. Unlocking is one click, on the part. */
  function canMove(d) {
    if (!d || !d.locked) return true;
    setStatus(d.payload.name + ' is locked so it can’t be nudged out of place by '
      + 'accident. Unlock it in the Parts list to move it.', 'warn');
    return false;
  }

  function movePart(d, step) {
    if (!canMove(d)) return;
    d.move = [d.move[0] + step[0], d.move[1] + step[1], d.move[2] + step[2]];
    // Mid-drag the whole streak is one undo entry; a click on the arrows is its own.
    if (state.moveStroke) {
      state.moveStroke.delta = [state.moveStroke.delta[0] + step[0],
                                state.moveStroke.delta[1] + step[1],
                                state.moveStroke.delta[2] + step[2]];
    } else {
      pushModelUndo({ kind: 'move', id: d.id, delta: step });
    }
    renderLayers();
    drawStack();
  }

  /* ---- undo: one history per part, one for the model view --------------------

     TWO PLACES YOU CAN BE, so two histories. Inside a part (you double-clicked into it,
     the rest of the model is hidden) Ctrl-Z walks that part's own edits. Looking at the
     whole model, it walks what you did TO THE MODEL - a part slid along its bone, a part
     put on a different socket - so reaching for undo after nudging a leg can never start
     peeling back paint you put on it half an hour ago.

     A voxel edit made while the whole model is showing is still that part's edit; the
     model view records a REFERENCE to it, so undoing from out here takes back the last
     thing you did either way, and the part's own stack stays the single copy of what
     changed. A reference whose part has since been undone from the inside is stale and
     skipped rather than double-applied. */

  function pushModelUndo(entry) {
    if (!state.project) return;
    state.project.history.push(entry);
    state.project.redo.length = 0;
    updateDirty();
  }

  // Which history Ctrl-Z is walking: the model's while the whole model is on screen.
  function inModelView() { return inProject() && !state.isolate; }

  /* Painting a part while the whole model is showing is that part's edit AND the model
     view's last action, so the model's history keeps a pointer to it. */
  function noteEditInModelView() {
    if (inModelView() && active()) pushModelUndo({ kind: 'edit', id: active().id });
  }

  function undoModel() {
    var h = state.project && state.project.history;
    if (!h) return;
    while (h.length) {
      var entry = h.pop();
      var d = state.docs.filter(function (x) { return x.id === entry.id; })[0];
      if (!d) continue;                       // the part was removed - nothing to undo
      if (entry.kind === 'edit') {
        if (!d.history.length) continue;      // already undone from inside the part
        undoDoc(d);
        setStatus('Undone on ' + d.payload.name + '.', 'ok');
      } else if (entry.kind === 'move') {
        d.move = [d.move[0] - entry.delta[0], d.move[1] - entry.delta[1],
                  d.move[2] - entry.delta[2]];
        setStatus('Move undone.', 'ok');
      } else if (entry.kind === 'ap') {
        d.ap = entry.from;
        setStatus('Put ' + d.payload.name.replace(/\.blueprint$/i, '') + ' back '
          + (entry.from ? 'on ' + entry.from.replace(/_/g, ' ') : 'beside the model')
          + '.', 'ok');
      }
      state.project.redo.push(entry);
      renderLayers();
      drawStack();
      updateDirty();
      return;
    }
    updateDirty();
  }

  /* Put back the last thing undone out here. Same skip-the-stale rule as undoModel,
     read the other way: an `edit` reference whose part has had a fresh edit since has
     had its redo stack cleared, and there is nothing left out here to put back. */
  function redoModel() {
    var r = state.project && state.project.redo;
    if (!r) return;
    while (r.length) {
      var entry = r.pop();
      var d = state.docs.filter(function (x) { return x.id === entry.id; })[0];
      if (!d) continue;
      if (entry.kind === 'edit') {
        if (!d.redo.length) continue;
        redoDoc(d);
        setStatus('Redone on ' + d.payload.name + '.', 'ok');
      } else if (entry.kind === 'move') {
        d.move = [d.move[0] + entry.delta[0], d.move[1] + entry.delta[1],
                  d.move[2] + entry.delta[2]];
        setStatus('Move redone.', 'ok');
      } else if (entry.kind === 'ap') {
        d.ap = entry.to;
        setStatus('Put ' + d.payload.name.replace(/\.blueprint$/i, '') + ' back '
          + (entry.to ? 'on ' + entry.to.replace(/_/g, ' ') : 'beside the model')
          + '.', 'ok');
      }
      state.project.history.push(entry);
      renderLayers();
      drawStack();
      updateDirty();
      return;
    }
    updateDirty();
  }

  /* Draw the model. Only the parts that CHANGED are re-meshed: switching to another
     part redraws two of them, not sixteen, which is the difference between an instant
     switch and a visible stall on a creature. A part's geometry can only change while
     it is the one being edited, so `dirtyMesh` is set as it stops being that. */
  function drawProject() {
    layoutUnplaced();
    var a = active();
    state.scene.setModelMatrix(matrixFor(a));
    state.scene.setModelOutline(ACTIVE_BOX);

    var want = {};
    state.docs.forEach(function (d, i) {
      if (i !== state.active && d.visible && !state.isolate) want[d.id] = d;
    });
    Object.keys(state.drawn).forEach(function (id) {
      if (!want[id]) { state.scene.clearLayer(id); delete state.drawn[id]; }
    });
    Object.keys(want).forEach(function (id) {
      var d = want[id];
      if (!state.drawn[id] || d.dirtyMesh) {
        // Qubicle draws a box around every part of a multi-part model, and it is right:
        // without them a creature is one lump of voxels with no seams.
        state.scene.setLayer(d.id, viewOf(d), PART_BOX, { opacity: PART_BOX_OPACITY });
        d.dirtyMesh = false;
        state.drawn[id] = 1;
      }
      state.scene.setLayerMatrix(d.id, matrixFor(d));
    });
  }

  // ---- animation preview --------------------------------------------------- //

  /* The rest pose is where you edit; it is not where the model LIVES. A horn that looks
     right standing still can swing through the jaw the moment the creature opens its
     mouth, and until now the only way to find that out was to build the mod and load the
     game. So the editor plays the creature's own baked clips - the same TANIM1 binaries
     the model viewer fetches, from the same endpoint.

     Playing is a MODE, not an overlay: the tools go quiet, because a click landing on a
     part halfway through a stride would edit a voxel at coordinates that mean nothing in
     the pose you can see. */

  var AC = function () { return window.AnimClips; };

  /* position + quaternion -> a column-major 4x4, the same composition three.js does. */
  function compose(px, py, pz, x, y, z, w) {
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    return [1 - (yy + zz), xy + wz, xz - wy, 0,
            xy - wz, 1 - (xx + zz), yz + wx, 0,
            xz + wy, yz - wx, 1 - (xx + yy), 0,
            px, py, pz, 1];
  }

  /* Pose every part at the moment the shared player describes. A part with no bone - or
     one this clip does not drive - stays where it rests. */
  function poseAt(at) {
    var r = rig(), vs = r.voxel_scale;
    state.docs.forEach(function (d, i) {
      var pose = placedOn(d) ? AC().sample(at, d.ap) : null;
      var m = pose
        ? matMul(matMul(compose(pose.p[0], pose.p[1], pose.p[2],
                                pose.q[0], pose.q[1], pose.q[2], pose.q[3]),
                        matScale(vs * (r.scales[d.ap] || 1))), frameOf(d))
        : matrixFor(d);
      if (i === state.active) state.scene.setModelMatrix(m);
      else if (state.drawn[d.id]) state.scene.setLayerMatrix(d.id, m);
    });
    state.scene.request();
  }

  /* One button on the bar = one program: a clip, or the several a move is made of once
     the rig's state machine has said which belong together. */
  function playProgram(key) {
    var r = rig();
    if (!key || !r) { stopClip(); return; }
    var spec = state.anim.kit.programs[key];
    if (!spec) return;
    setAnimating(true);
    state.anim.want = key;
    state.anim.bar.setLoading(key, true);
    Promise.all(spec.clips.map(function (name) {
      if (state.anim.loaded[name]) return null;
      return fetch(apiUrl('/site/rigs/' + encodeURIComponent(r.name) + '/anim/'
                          + encodeURIComponent(name)))
        .then(function (res) {
          if (!res.ok) throw new Error('That animation isn’t available for this rig.');
          return res.arrayBuffer();
        })
        .then(function (buf) { state.anim.loaded[name] = AC().decode(buf); });
    })).then(function () {
      state.anim.bar.setLoading(key, false);
      if (state.anim.want !== key) return;             // another button won the race
      var prog = AC().timeline(spec, state.anim.loaded);
      if (!prog) return;
      state.anim.prog = prog;
      var t0 = performance.now();
      var tick = function (ts) {
        if (state.anim.prog !== prog) return;          // stopped, or a different program
        state.anim.raf = requestAnimationFrame(tick);
        poseAt(AC().frameAt(prog, (ts - t0) / 1000));
      };
      cancelAnimationFrame(state.anim.raf);
      state.anim.raf = requestAnimationFrame(tick);
      setStatus('');
    }).catch(function (err) {
      state.anim.bar.setLoading(key, false);
      setStatus(err.message || String(err), 'error');
    });
  }

  function stopClip() {
    if (state.anim.raf) cancelAnimationFrame(state.anim.raf);
    state.anim.raf = 0;
    state.anim.prog = null;
    state.anim.want = null;
    if (state.scene) drawStack();                        // back to the rest pose
  }

  /* Editing and playing are exclusive. Leaving Animate puts the model back in its rest
     pose, which is the only pose the voxel coordinates on screen agree with. */
  function setAnimating(on) {
    if (!inProject()) return;
    var clips = (rig() && rig().animations) || [];
    on = !!on && !!clips.length;
    if (state.anim.on === on) return;
    state.anim.on = on;
    if (!on) { stopClip(); if (state.anim.bar) state.anim.bar.setActive(null); }
    if (state.scene) {
      state.scene.setDragMode(on ? '' : dragModeFor(state.tool));
      state.scene.setModelOutline(on ? null : ACTIVE_BOX);
    }
    // Watching a creature move is watching the WHOLE creature.
    if (on && state.isolate) { state.isolate = false; renderLayers(); drawStack(); }
    $('bpe-page').classList.toggle('bpe-animating', on);
    $('bpe-animbar').hidden = !on;
    $('bpe-hover').hidden = true;
    renderStageBar();
    renderToolHint();
    // The bar takes its height out of the stage, and three.js writes the canvas size as
    // an inline style - so a canvas left at its old height spills over the bar and eats
    // every click on it.
    if (state.scene) { state.scene.resize(); state.scene.request(); }
  }

  /* The bar is built once per model, from the rig's clip list and its state machine -
     the same control the model viewer carries, so a clip sits under the same heading in
     both. The graph is fetched alongside and is allowed to be missing: a rig without one
     (props, chests) just lists its clips. */
  function buildAnimBar() {
    var r = rig();
    var host = $('bpe-animbar');
    state.anim = { on: false, prog: null, want: null, raf: 0, loaded: {},
                   kit: null, bar: null };
    host.hidden = true;
    host.textContent = '';
    $('bpe-animate').hidden = !(r && r.animations && r.animations.length);
    if (!r || !r.animations || !r.animations.length || !window.AnimClips) return;
    U.getJSON('/site/rigs/' + encodeURIComponent(r.name) + '/graph')
      .catch(function () { return null; })
      .then(function (graph) {
        if (rig() !== r) return;                       // a different model got opened
        state.anim.kit = AC().programs(r.animations, graph);
        state.anim.bar = AC().bar({
          host: host, kit: state.anim.kit, onPick: playProgram,
          restLabel: 'Rest pose', hint: 'editing is off while it plays',
          onResize: function () { if (state.scene) state.scene.resize(); },
        });
      });
  }

  /* Add blueprints to an open model. They are decoded through the ordinary single-file
     path, so anything the editor can open can be added, and then we ASK where each one
     goes: the game's map places the parts a mod already had, but a file someone just
     dropped in is by definition not in it yet. */
  function addParts(fileList) {
    var picked = Array.prototype.slice.call(fileList).filter(function (f) {
      return /\.blueprint$/i.test(f.name);
    });
    if (!picked.length) return;
    if (state.docs.length + picked.length > 48) {
      setStatus('That is as many parts as one model holds.', 'error');
      return;
    }
    setStatus('Reading ' + picked.length + ' part' + (picked.length === 1 ? '' : 's') + '…');
    Promise.all(picked.map(function (f) {
      var fd = new FormData();
      fd.append('file', f, f.name);
      return fetch(apiUrl('/site/blueprint-editor/inspect'), { method: 'POST', body: fd })
        .then(function (res) {
          return res.json().then(function (b) {
            if (!res.ok) throw new Error((b && b.detail) || (f.name + ' couldn’t be opened.'));
            return { file: f, payload: b };
          });
        });
    })).then(function (opened) {
      opened.forEach(function (o) {
        state.docs.push(makeDoc(o.file, o.payload, { path: '', ap: null, added: true }));
      });
      // The first one we need an answer about. setActive redraws the list, and that is
      // also what puts the cursor in its socket picker - so nothing may redraw after it,
      // or the focus lands on an element that has already been replaced.
      state.ask = state.docs.length - opened.length;
      setActive(state.ask);
      var one = opened.length === 1;
      setStatus((one ? opened[0].payload.name + ' is in' : opened.length + ' parts are in')
        + '. ' + (rig()
            ? 'Tell me where ' + (one ? 'it' : 'each one') + ' attaches and '
              + (one ? 'it' : 'they') + ' will snap onto the model.'
            : 'There’s no rig for this model, so ' + (one ? 'it sits' : 'they sit')
              + ' beside the others.'), 'ok');
    }).catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  /* Somebody answering "where does this go". The socket list is the rig's own, so the
     only thing that can be chosen is a bone the skeleton actually has. */
  function setPartAp(i, ap) {
    var d = doc(i);
    if (!d || (ap || null) === d.ap) return;
    pushModelUndo({ kind: 'ap', id: d.id, from: d.ap, to: ap || null });
    d.ap = ap || null;
    if (state.ask === i) state.ask = -1;
    renderLayers();
    drawStack();
    if (state.scene && ap) state.scene.request();
  }

  function removePart(i) {
    if (!state.docs[i] || state.docs.length < 2) return;
    if (state.scene) state.scene.clearLayer(state.docs[i].id);
    delete state.drawn[state.docs[i].id];
    state.docs.splice(i, 1);
    if (state.ask >= i) state.ask = -1;
    setActive(Math.min(state.active, state.docs.length - 1));
  }

  /* The whole model back out as the file it came in as. The archive is posted again
     alongside the per-part edits - the server holds nothing between opening a model and
     writing it - and any part added since rides along with the path it should be packed
     at, so a mod comes back complete rather than as a folder of loose blueprints. */
  function saveModel() {
    var p = state.project;
    if (!p) return;
    var fd = new FormData();
    var edits = {};
    /* Where each part lives inside the mod. One already in it keeps its path; a part
       added since goes to blueprints/, which is the only folder Trove reads models out
       of. A project of loose files has no archive to keep anything else in, so every
       part is posted and the server names them by their own filenames. */
    var pathOf = new Map();
    state.docs.forEach(function (d) {
      pathOf.set(d, d.path || (p.file ? 'blueprints/' + d.file.name : d.file.name));
    });
    if (p.file) fd.append('file', p.file, p.file.name);
    var posted = [];
    state.docs.forEach(function (d) {
      // Already in the archive and still the bytes that came out of it -> nothing to
      // post; the server edits its own copy. A rotated part is NOT that, so it goes.
      if (p.file && d.path && !d.replaced) return;
      fd.append('files', d.file, d.file.name);
      posted.push(pathOf.get(d));
    });
    // ONE field holding the whole list, lined up with the files - a repeated form field
    // would arrive as whichever copy the server kept.
    fd.append('paths', JSON.stringify(posted));
    var moves = {};
    state.docs.forEach(function (d) {
      var list = editListOf(d);
      if (list.length) edits[pathOf.get(d)] = list;
      if (d.move[0] || d.move[1] || d.move[2]) moves[pathOf.get(d)] = d.move;
    });
    fd.append('edits', JSON.stringify(edits));
    fd.append('moves', JSON.stringify(moves));
    fd.append('name', p.name);
    setStatus('Building ' + p.name + '…');
    fetch(apiUrl('/site/blueprint-editor/model-save'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'The model couldn’t be saved.');
          });
        }
        var summary = {};
        try { summary = JSON.parse(res.headers.get('X-Kiwi-Summary') || '{}'); } catch (e) { /* optional */ }
        var name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
        return res.blob().then(function (blob) {
          return { blob: blob, summary: summary, name: name ? name[1] : p.name };
        });
      })
      .then(function (out) {
        return download(out.blob, out.name).then(function (path) {
          if (!path) { setStatus(''); return; }
          var s = out.summary;
          var bits = [];
          if (s.parts) bits.push(s.parts + ' part' + (s.parts === 1 ? '' : 's') + ' changed');
          if (s.added_parts) bits.push(s.added_parts + ' added');
          if (s.moved) bits.push(s.moved + ' moved on the rig');
          if (s.ignored) bits.push(s.ignored + ' protected voxels left as they were');
          setStatus('Saved to ' + path + (bits.length ? ' — ' + bits.join(', ') : '') + '.', 'ok');
        });
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  // ---- starting from a model that's already in the game -------------------- //

  /* Most mods start from something the game already has: a mount recoloured, a dragon
     restyled. The codex knows every one of those by name, and the prefab behind the name
     is exactly what binds its blueprints to its bones - so a search of the codex IS a
     search of the editable models, and the card's picture is the creature itself. */

  var searchTimer = 0, searchSeq = 0;

  /* A recipe is an instruction and an item is a thing in a bag - neither is built from
     blueprint parts on a skeleton, so neither can be opened here. They are dropped from
     the results rather than left to be clicked and refused. */
  var NOT_A_MODEL = { recipe: 1, item: 1 };

  function runSearch() {
    var q = $('bpe-search').value.trim();
    var type = $('bpe-searchtype').value;
    var note = $('bpe-resultnote');
    if (q.length < 2 && !type) {
      $('bpe-results').innerHTML = '';
      note.hidden = true;
      return;
    }
    var seq = ++searchSeq;
    // Ask for more than fits, because the types that are never models are dropped
    // below and a page of recipes would otherwise come back as an empty grid.
    var url = '/site/blueprint-editor/search?limit=60&q=' + encodeURIComponent(q)
      + (type ? '&type=' + encodeURIComponent(type) : '');
    U.getJSON(url).then(function (body) {
      if (seq !== searchSeq) return;      // a later keystroke already answered
      // The first search reads every prefab in the install; ask again until that's done.
      if (body && body.indexing) {
        note.hidden = false;
        note.textContent = 'Reading your Trove install’s models for the first time…';
        setTimeout(function () { if (seq === searchSeq) runSearch(); }, 1500);
        return;
      }
      if (body && body.error) {
        note.hidden = false;
        note.textContent = body.error;
        return;
      }
      var items = ((body && body.items) || []).filter(function (e) {
        return !NOT_A_MODEL[e.codex_type || e.type];
      });
      renderResults(items.slice(0, 24), items.length);
    }).catch(function () {
      if (seq !== searchSeq) return;
      note.hidden = false;
      note.textContent = 'The game data couldn’t be searched just now.';
    });
  }

  function renderResults(items, total) {
    var note = $('bpe-resultnote');
    // Only a creature the game binds to a skeleton can be opened as a model, and that
    // is not knowable from a codex row - so everything is offered and the one that
    // isn't bound says so when you pick it, rather than being silently missing.
    $('bpe-results').innerHTML = items.map(function (e) {
      var meta = [e.codex_type, e.parts + ' part' + (e.parts === 1 ? '' : 's')]
        .concat(e.animated ? ['animated'] : []).join(' · ');
      return '<li><button type="button" class="bpe-result" data-prefab="' + esc(e.path || '')
        + '" title="' + esc(e.path || '') + '"><span class="bpe-result-img">'
        + '<i class="fa-solid fa-' + (e.codex_type === 'dragon' ? 'dragon' : 'cube') + '" aria-hidden="true"></i></span>'
        + '<span class="bpe-result-name">' + esc(e.name || e.path || 'Unnamed')
        + '<small>' + esc(meta) + '</small></span></button></li>';
    }).join('');
    // Say something only when there is something to say: nothing found, or more found
    // than fits. (It used to hide the "nothing found" line in exactly the case that
    // produced it.)
    var msg = !items.length
      ? 'Nothing in the game data matches that.'
      : (total > items.length
          ? 'Showing ' + items.length + ' of ' + total.toLocaleString()
            + ' — keep typing to narrow it down.'
          : '');
    note.textContent = msg;
    note.hidden = !msg;
  }

  function openGameModel(prefab, label, done, fail) {
    state.openWith = { kind: 'game', prefab: prefab, label: label };
    setStatus('Opening ' + (label || prefab) + '…');
    U.fetchJSON('/site/blueprint-editor/game-model?prefab=' + encodeURIComponent(prefab))
      .then(function (payload) { loadProject(payload, null); if (done) done(); })
      .catch(function (err) {
        // A bare status code says nothing to whoever clicked a picture of a dragon, and
        // the one thing that goes wrong here has a real explanation: plenty of codex
        // entries aren't creatures at all.
        var msg = (err && err.message) || '';
        if (fail) { fail(err); return; }
        setStatus(/^HTTP \d+$/.test(msg) || !msg
          ? (label || 'That one') + ' isn’t a model the game builds from blueprint parts,'
            + ' so there’s nothing to open in the editor.'
          : msg, 'error');
      });
  }

  // ---- Qubicle interop ---------------------------------------------------- //

  /* WebView2 has no download shelf, so a file goes out through a native Save As dialog.
     Resolves to the path written, or '' when the dialog was cancelled. */
  function download(blob, filename) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('The file couldn’t be prepared for saving.')); };
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.readAsDataURL(blob);
    }).then(function (b64) {
      return eel.save_blueprint_editor_file(filename, b64)();
    }).then(function (res) {
      if (!res || !res.success) throw new Error((res && res.error) || 'The file couldn’t be saved.');
      return res.cancelled ? '' : (res.path || filename);
    });
  }

  /* Out to the authoring format: the base model plus the _a / _s / _t material maps,
     which is what Qubicle and MagicaVoxel users actually work in. */
  function exportQb() {
    if (!state.file) return;
    var list = editList();
    setStatus('Building the .qb files…');
    var fd = new FormData();
    anchorParts(fd);
    stackParts(fd);
    fetch(apiUrl('/site/blueprint-editor/export-qb'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'The export failed.');
          });
        }
        var notes = [];
        try { notes = JSON.parse(res.headers.get('X-Kiwi-Notes') || '[]'); } catch (e) { /* header is optional */ }
        return res.blob().then(function (blob) { return { blob: blob, notes: notes }; });
      })
      .then(function (out) {
        var stem = state.file.name.replace(/\.blueprint$/i, '') || 'model';
        return download(out.blob, stem + '_qb.zip').then(function (path) {
          if (!path) { setStatus(''); return; }
          // Anything the conversion had to flatten is said out loud here.
          setStatus(out.notes.length
            ? 'Exported four .qb files. ' + out.notes.join(' ')
            : 'Exported four .qb files — model, alpha, specular and type.', 'ok');
        });
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  /* In from the authoring format: compile the .qb set to a blueprint on the server,
     then open the result through the ordinary path so everything downstream - editing,
     checks, saving - behaves exactly as it does for a file that arrived as a blueprint. */
  function importQb(fileList) {
    var picked = Array.prototype.slice.call(fileList).filter(function (f) {
      return /\.qb$/i.test(f.name);
    });
    if (!picked.length) {
      setStatus('Pick a .qb file — and its _a / _s / _t maps too, if you have them.', 'error');
      return;
    }
    if (picked.length > 4) {
      setStatus('Send the model and up to three material maps.', 'error');
      return;
    }
    setStatus('Compiling ' + picked.length + ' .qb file' + (picked.length === 1 ? '' : 's') + '…');
    var fd = new FormData();
    picked.forEach(function (f) { fd.append('files', f, f.name); });
    fetch(apiUrl('/site/blueprint-editor/import-qb'), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (b) {
            throw new Error((b && b.detail) || 'Those .qb files couldn’t be compiled.');
          });
        }
        var summary = {};
        try { summary = JSON.parse(res.headers.get('X-Kiwi-Summary') || '{}'); } catch (e) { /* optional */ }
        return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
      })
      .then(function (out) {
        var base = picked.find(function (f) { return !/_[ast]\.qb$/i.test(f.name); }) || picked[0];
        var stem = base.name.replace(/\.qb$/i, '');
        var file = new File([out.blob], stem + '.blueprint');
        var s = out.summary;
        var bits = [];
        if (s.maps && s.maps.length) {
          bits.push('read the ' + s.maps.join(', ') + ' map' + (s.maps.length === 1 ? '' : 's'));
        } else {
          bits.push('no material maps were supplied, so everything is a rough solid');
        }
        if (s.attachment_source === 'marker') bits.push('found the attachment point');
        else if (s.attachment_source === 'offset') bits.push('took the attachment point from the matrix offset');
        // No marker means the model was centred, the same as a decoration. Say that
        // rather than "no attachment point", because one is shown either way - the
        // format always stores an origin, and a centred one is a real answer for a deco.
        else bits.push('no attachment marker, so it was centred — add a magenta '
          + '(255, 0, 255) voxel if it needs a specific grip point');
        var lossy = (s.unknown_type || 0) + (s.unknown_alpha || 0) + (s.unknown_specular || 0);
        if (lossy) bits.push(lossy.toLocaleString() + ' voxels had map colours outside the palette and fell back to defaults');
        // With a model open, a compiled .qb joins it as a part rather than replacing it.
        if (inProject()) { addParts([file]); return; }
        openFile(file, 'Compiled — ' + bits.join('; ') + '.');
      })
      .catch(function (err) { setStatus(err.message || String(err), 'error'); });
  }

  // ---- rendering ---------------------------------------------------------- //

  function label(i) {
    var d = state.data, t = d.type[i], w = d.w[i];
    var pal = (d.palette.types || []).find(function (p) { return p.type === t; });
    if (!pal) {
      var known = (d.materials || []).find(function (m) { return m.type === t && m.w === w; });
      return known ? known.label : 'Unknown type ' + t;
    }
    var opt = (pal.options || []).find(function (o) { return o.w === w; });
    return pal.label + (opt ? ' · ' + opt.label : '');
  }

  var KIND_LABELS = {
    other: 'Not sure / something else', melee: 'Melee weapon', gun: 'Gun',
    staff: 'Staff', bow: 'Bow', spear: 'Spear', fist: 'Fist weapon',
    mask: 'Mask / face', hat: 'Hat', hair: 'Hair / helmet', deco: 'Decoration',
  };

  function renderKinds() {
    var types = state.data.creation_types || ['other'];
    // "Not sure" first: it's the honest default, and it runs only the checks that
    // don't depend on knowing what the model is.
    types = types.slice().sort(function (a, b) {
      return (a === 'other' ? -1 : b === 'other' ? 1 : a.localeCompare(b));
    });
    $('bpe-kind').innerHTML = types.map(function (t) {
      return '<option value="' + t + '"' + (t === state.kind ? ' selected' : '') + '>'
        + esc(KIND_LABELS[t] || t) + '</option>';
    }).join('');
  }

  // ---- the saved colour palette ------------------------------------------- //

  /* A palette that outlives the page. A model is built one part at a time, and the
     colours have to agree across all of them - re-picking the same shade by eye on each
     part is exactly where that fails. Kept in localStorage rather than on the server:
     nothing about what someone is building needs to leave their browser. */
  var SWATCH_KEY = 'btt.bpe.swatches';
  var MAX_SWATCHES = 24;

  function loadSwatches() {
    try {
      var v = JSON.parse(localStorage.getItem(SWATCH_KEY) || '[]');
      if (!Array.isArray(v)) return [];
      return v.filter(function (n) { return typeof n === 'number' && n >= 0 && n <= 0xFFFFFF; })
              .slice(0, MAX_SWATCHES);
    } catch (e) { return []; }        // private mode, or someone else's data in the key
  }

  function storeSwatches() {
    try { localStorage.setItem(SWATCH_KEY, JSON.stringify(state.swatches)); } catch (e) { /* full or blocked */ }
  }

  function renderSwatches() {
    var el = $('bpe-swatches');
    if (!el) return;
    if (!state.swatches.length) {
      el.innerHTML = '<li class="bpe-swempty">'
        + 'Press + to keep a colour here.</li>';
      return;
    }
    el.innerHTML = state.swatches.map(function (rgb, i) {
      var h = hex(rgb).toUpperCase();
      // The current paint colour reads as selected, so the strip says which one is live.
      var on = rgb === state.paint.rgb;
      return '<li class="bpe-sw' + (on ? ' bpe-sw-on' : '') + '">'
        + '<button type="button" class="bpe-swbtn" data-sw="' + i + '" style="background:' + h + '"'
        + ' aria-pressed="' + on + '" title="Paint with ' + h + '">'
        + '<span class="sr-only">' + h + '</span></button>'
        + '<button type="button" class="bpe-swx" data-swx="' + i + '"'
        + ' title="Remove ' + h + '" aria-label="Remove ' + h + '">&times;</button></li>';
    }).join('');
  }

  /* Push the current paint settings back into the controls. The eyedropper changes them
     from outside the panel, and a swatch that didn't follow would be lying. */
  function syncPaintUI() {
    $('bpe-colour').value = hex(state.paint.rgb);
    $('bpe-colour-hex').textContent = hex(state.paint.rgb).toUpperCase();
    renderPalette();
    renderSwatches();
  }

  /* The paint controls only govern a paint click, and Add uses them for the new voxel -
     so Erase and Pick grey them out rather than leaving a colour picker that does
     nothing. */
  // ---- how the mouse drives the camera ------------------------------------ //

  /* There is no one standard to adopt: MagicaVoxel, Blender and Maya each bind the view
     to a different set of buttons, and the right one is whichever the person was using
     an hour ago. So all three ship. The choice is remembered browser-side next to the
     palette and for the same reason - it belongs to the person, not to the file.

     This table is the ONLY source for both the dialog rows and the one-line tool hint,
     so the editor cannot end up naming a gesture the scene doesn't listen for. What each
     preset actually binds lives in voxel_scene.js; these are its captions. */
  var NAV_KEY = 'btt.bpe.nav';
  var NAV_DEFAULT = 'magicavoxel';
  var NAV_INFO = {
    magicavoxel: {
      orbit: '<span>Right-drag</span>',
      pan: '<span>Middle-drag</span>',
      zoom: '<span>Scroll</span>',
      turn: 'Right-drag turns the view.',
    },
    blender: {
      orbit: '<span>Middle-drag</span>',
      pan: '<kbd>Shift</kbd> + <span>middle-drag</span>',
      zoom: '<span>Scroll</span>, <span>or</span> <kbd>Ctrl</kbd> + <span>middle-drag</span>',
      turn: 'Middle-drag turns the view.',
    },
    maya: {
      orbit: '<kbd>Alt</kbd> + <span>drag</span>',
      pan: '<kbd>Alt</kbd> + <span>middle-drag</span>',
      zoom: '<span>Scroll</span>, <span>or</span> <kbd>Alt</kbd> + <span>right-drag</span>',
      turn: 'Alt-drag turns the view.',
    },
  };

  function loadNav() {
    try {
      var v = localStorage.getItem(NAV_KEY);
      return NAV_INFO[v] ? v : NAV_DEFAULT;
    } catch (e) { return NAV_DEFAULT; }   // private mode, or someone else's data
  }

  function setNav(name) {
    state.nav = NAV_INFO[name] ? name : NAV_DEFAULT;
    try { localStorage.setItem(NAV_KEY, state.nav); } catch (e) { /* full or blocked */ }
    if (state.scene) state.scene.setNavScheme(state.nav);
    renderNav();
    renderToolHint();          // it names the turn gesture, so it changes with the preset
  }

  function renderNav() {
    var info = NAV_INFO[state.nav] || NAV_INFO[NAV_DEFAULT];
    ['orbit', 'pan', 'zoom'].forEach(function (k) {
      var el = $('bpe-nav-' + k);
      if (el) el.innerHTML = info[k];
    });
    /* Roving tabindex, which is what a radiogroup owes the keyboard: Tab reaches the
       group once and lands on the chosen option, and the arrows move within it. */
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      var on = b.dataset.nav === state.nav;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    // Those rows were just rewritten, so the language sweep has to run over them again
    // or a non-English page shows them in English until the next reload.
    if (window.BTTi18n && window.BTTi18n.refresh) window.BTTi18n.refresh();
  }

  /* Paint, add and erase run along the drag; move repositions; pick stays a click.
     The left button is the TOOL in all of them - the view is turned with whatever the
     chosen navigation preset binds it to, which is why no tool has to give a button
     back. */
  function dragModeFor(tool) {
    if (tool === 'move') return 'move';
    if (tool === 'select') return 'marquee';
    if (tool === 'paint' || tool === 'add' || tool === 'erase' || tool === 'box') return 'stroke';
    return '';
  }

  /* A marquee released. The scene hands back COORDINATES, so they are resolved against
     the live index here rather than there - the scene draws a compacted view of the
     part and its own row numbers are not ours.

     Shift adds and Ctrl subtracts, which is what a selection rectangle does in every
     editor that has one. An empty box with no modifier CLEARS: dragging over nothing is
     how people deselect, and leaving the old selection standing after an explicit empty
     drag reads as the tool having missed. */
  function onRect(cells, ev) {
    if (!state.data || state.anim.on || state.tool !== 'select') return;
    var d = state.data, rows = [];
    cells.forEach(function (c) {
      var i = state.index.get(c.x + ',' + c.y + ',' + c.z);
      if (i !== undefined && d.live[i]) rows.push(i);
    });
    var add = !!(ev && ev.shiftKey);
    var sub = !!(ev && (ev.ctrlKey || ev.metaKey));
    if (!rows.length) {
      if (!add && !sub) clearSelection();
      setStatus('Nothing in that box.' + (state.slice.on ? ' The slice is on, so only its layer can be caught.' : ''));
      return;
    }
    if (sub) {
      if (state.sel) rows.forEach(function (i) { state.sel.delete(i); });
    } else if (add && state.sel) {
      rows.forEach(function (i) { state.sel.add(i); });
    } else {
      state.sel = new Set(rows);
    }
    if (state.sel && !state.sel.size) state.sel = null;
    afterSelection();
    var n = state.sel ? state.sel.size : 0;
    setStatus(rows.length.toLocaleString() + ' voxel' + (rows.length === 1 ? '' : 's')
      + (sub ? ' removed · ' : (add ? ' added · ' : ' caught · '))
      + n.toLocaleString() + ' selected.', 'ok');
  }

  /* A drag is ONE action. Edits accumulate into a single batch so the whole streak
     undoes in one step, and the expensive panel redraws wait for the end rather than
     running per voxel. */
  function onStroke(phase) {
    // A move-drag is one action as well, and its undo entry is the model's, not the
    // part's - so it closes here rather than sharing the voxel batch below.
    if (state.tool === 'move') {
      if (phase === 'start') {
        state.moveStroke = { id: (active() || {}).id, delta: [0, 0, 0] };
        return;
      }
      var m = state.moveStroke;
      state.moveStroke = null;
      if (m && (m.delta[0] || m.delta[1] || m.delta[2]) && inProject()) {
        pushModelUndo({ kind: 'move', id: m.id, delta: m.delta });
      }
      return;
    }
    /* Box paints nothing as it drags, so it has no stroke batch to fold into - the
       whole rectangle is applied here, on release, as one action of its own. */
    if (state.tool === 'box') {
      if (phase === 'start') cancelBox(); else commitBox();
      return;
    }
    if (phase === 'start') {
      state.stroke = [];
      state.strokeNormal = null;
      return;
    }
    var batch = state.stroke;
    state.stroke = null;
    state.strokeNormal = null;
    if (batch && batch.length) {
      state.history.push(batch);
      state.redo.length = 0;
      clearThumb(active());
      noteEditInModelView();
      renderMaterialList();
      renderMeta();
      renderLayers();
      renderSelection();
      updateDirty();
      staleReport();
    }
  }

  /* ---- tools and their keys -------------------------------------------------

     Two ways to reach every tool, because they suit different hands: the DIGITS run
     left to right along the row exactly as it is drawn, which needs nothing memorised,
     and the LETTERS are the ones these tools carry in the software people arrive from
     (B brush, I eyedropper, E eraser, V move, M marquee - Photoshop's, which Qubicle
     and every voxel editor since inherited). S and R are ours: the buttons say Select
     and the box is a rectangle, and a name you can see beats a convention you can't. */
  var TOOL_ORDER = ['paint', 'pick', 'add', 'erase', 'move', 'select', 'box'];
  var TOOL_KEYS = {
    paint: 'B', pick: 'I', add: 'A', erase: 'E', move: 'V', select: 'S', box: 'R',
  };
  var KEY_TOOL = (function () {
    var m = {};
    TOOL_ORDER.forEach(function (t, i) {
      m[TOOL_KEYS[t].toLowerCase()] = t;
      m[String(i + 1)] = t;          // 1-7, in the order the row is drawn
      m['m'] = 'select';             // the marquee key, for hands that already know it
    });
    return m;
  })();

  function setTool(name) {
    if (!name || TOOL_ORDER.indexOf(name) < 0) return;
    state.tool = name;
    document.querySelectorAll('[data-tool]').forEach(function (o) {
      o.setAttribute('aria-pressed', String(o.dataset.tool === state.tool));
    });
    if (state.scene) state.scene.setDragMode(dragModeFor(state.tool));
    $('bpe-grabblock').hidden = state.tool !== 'select';
    $('bpe-boxblock').hidden = state.tool !== 'box';
    // Switching away mid-drag would leave a preview floating over the model with
    // nothing left to apply it.
    cancelBox();
    renderToolHint();
  }

  /* The key belongs ON the button. These are icon-only, so the tooltip is already the
     only place the tool is named, and a shortcut nobody can see is a shortcut nobody
     uses. Written once at startup off the same table the keys are read from, so the
     two can't drift. */
  function labelToolKeys() {
    document.querySelectorAll('[data-tool]').forEach(function (b) {
      var key = TOOL_KEYS[b.dataset.tool];
      if (!key) return;
      var name = b.getAttribute('aria-label') || b.title;
      b.title = name + ' (' + key + ')';
    });
  }

  function renderToolHint() {
    // Every tool that owns the left button has to say how to turn the model instead,
    // and which gesture that is depends on the preset - so it comes from NAV_INFO
    // rather than being spelled out four times.
    var turn = ' ' + (NAV_INFO[state.nav] || NAV_INFO[NAV_DEFAULT]).turn;
    var hints = {
      paint: 'Click or drag across voxels to paint them.' + turn,
      pick: 'Click a voxel to copy its colour and material into the settings below.',
      add: 'Drag along a face to lay voxels against it.' + turn,
      erase: 'Click or drag across voxels to delete them.' + turn,
      move: 'Drag to slide this layer around.' + turn,
      select: 'Click a voxel, or drag a box across the model. Shift adds to the '
        + 'selection and Ctrl takes away. Everything else then works only where it lands.',
      box: 'Drag out a rectangle across one face to fill or clear it in one go. '
        + 'Turn on a slice first to work inside the model.',
    };
    var hint = hints[state.tool] || hints.paint;
    /* Which layer a click lands on is the thing to be unambiguous about once there is
       more than one model on screen - but in a MODEL the stage bar names the part you
       are in, directly above the model, so saying it again here is a third line of a
       panel with better uses for the room. */
    if (!inProject() && state.docs.length > 1 && active()) {
      hint += ' Working on ' + active().payload.name + '.';
    }
    if (inProject() && state.anim.on) {
      $('bpe-toolhint').textContent = 'The model is animating, so the tools are off — '
        + 'the voxel under the cursor isn’t where it will be a frame later. Come back to '
        + 'editing to make changes.';
      return;
    }
    if (inProject() && state.tool === 'move') {
      var a2 = active();
      hint = a2 && a2.locked
        ? 'Parts are locked when a model opens, so nothing slides out of place by '
          + 'accident. Click the padlock beside a part to move it.'
        : 'Drag to slide this part along its bone, or use the arrows under Parts. It '
          + 'moves in whole voxels and takes its attachment point with it.';
    } else if (state.tool === 'move' && active() === anchorDoc()) {
      hint = 'This layer is the anchor - the frame the others are placed against, so it '
        + 'does not move. Pick another layer, or pin a different one as the anchor.';
    }
    $('bpe-toolhint').textContent = hint;
    var faded = state.tool === 'erase' || state.tool === 'pick'
             || state.tool === 'move' || state.tool === 'select';
    ['bpe-paint-colour', 'bpe-paint-material'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('bpe-faded', faded);
    });
    // "A click changes" only means anything while painting.
    var modes = $('bpe-modes');
    if (modes) modes.classList.toggle('bpe-faded', state.tool !== 'paint');
    // Scope governs paint and erase; pick and add are always a single voxel.
    var scopes = $('bpe-scopes');
    var single = state.tool === 'pick' || state.tool === 'add' || state.tool === 'move';
    if (scopes) scopes.classList.toggle('bpe-faded', single);
    var lbl = $('bpe-scope-label');
    if (lbl) lbl.classList.toggle('bpe-faded', single);
    renderScopeHint();
  }

  /* Say how many voxels the current scope would hit BEFORE the click, using whatever is
     selected as the sample. "Every voxel of that material" on a plain model can mean
     hundreds, and finding that out by doing it is the wrong order. */
  function renderScopeHint() {
    var el = $('bpe-scopehint');
    if (!el || !state.data) return;
    if (state.tool === 'pick' || state.tool === 'add' || state.scope === 'voxel') {
      el.textContent = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (state.selection < 0) {
      el.textContent = state.scope === 'colour'
        ? 'Matches on the exact colour of whichever voxel you click.'
        : 'Matches on material — on a plain model that can be most of it.';
      return;
    }
    var n = targetsFor(state.selection).length;
    el.textContent = 'The selected voxel matches ' + n.toLocaleString()
      + (n === 1 ? ' voxel' : ' voxels') + '.';
  }

  /* The material palette is the server's answer about the OPEN file, so there is
     nothing to draw before one is open - and the colour controls beside it work either
     way. Returning quietly beats throwing halfway through `syncPaintUI` and leaving the
     rest of the paint controls un-synced. */
  /* Authoring in Qubicle, a material IS a colour: you paint the _t map white for
     solid and the _s map green for metal. A modder coming from that workflow knows
     these by their swatch, so each chip carries the map colour it is written as -
     shown only. The editor writes Trove's real (type, w); going back through the map
     colours is the lossy trip the whole material model exists to avoid. */
  function qbDot(o) {
    return o && o.qb
      ? '<span class="bpe-qbdot" style="background:' + esc(o.qb) + '" aria-hidden="true"></span>'
      : '';
  }
  function qbTitle(o) {
    return o && o.qb
      ? ' title="' + esc(o.qb.toUpperCase() + ' in the ' + (o.qb_map || '') + '.qb map') + '"'
      : '';
  }

  function renderPalette() {
    if (!state.data) return;
    var pal = state.data.palette;
    var html = (pal.types || []).map(function (p) {
      return '<button type="button" class="bpe-mat" data-type="' + p.type + '"'
        + ' aria-pressed="' + (state.paint.type === p.type) + '"'
        + qbTitle(p) + '>' + qbDot(p) + esc(p.label) + '</button>';
    }).join('');
    $('bpe-types').innerHTML = html;
    renderWOptions();
  }

  function renderWOptions() {
    if (!state.data) return;
    var pal = state.data.palette;
    var p = (pal.types || []).find(function (t) { return t.type === state.paint.type; });
    var opts = (p && p.options) || [];
    /* A material with one option has no choice to offer - a glowing solid is emissive,
       and nothing reads a specular finish off one. Six buttons where five did nothing
       is worse than no buttons, so the whole row goes. */
    var single = opts.length < 2;
    $('bpe-finish-label').hidden = single;
    $('bpe-finish').hidden = single;
    if (!p) { $('bpe-finish').innerHTML = ''; return; }
    $('bpe-finish-label').textContent = p['class'] === 'glass' ? 'Opacity' : 'Finish';
    $('bpe-finish').innerHTML = opts.map(function (o) {
      return '<button type="button" class="bpe-w" data-w="' + o.w + '"'
        + ' aria-pressed="' + (state.paint.w === o.w) + '"'
        + qbTitle(o) + '>' + qbDot(o) + esc(o.label) + '</button>';
    }).join('');
  }

  /* Every distinct material in the model, largest first. This doubles as the bulk
     tool: it is how you recolour "all the glass" without hunting for a voxel. */
  function renderMaterialList() {
    var d = state.data;
    var seen = new Map();
    for (var i = 0; i < d.count; i++) {
      if (!d.live[i]) continue;
      var key = d.type[i] + ':' + d.w[i];
      var e = seen.get(key);
      if (e) { e.count++; e.colours.add(d.rgb[i]); }
      else {
        seen.set(key, { type: d.type[i], w: d.w[i], count: 1, i: i,
                        colours: new Set([d.rgb[i]]) });
      }
    }
    var rows = Array.from(seen.values()).sort(function (a, b) { return b.count - a.count; });
    $('bpe-materials').innerHTML = rows.map(function (r) {
      // Apply is offered whenever SOMETHING can change - a placeable-colour voxel
      // takes a new colour even though its material is fixed, and the click applies
      // whichever half it's allowed. Only a voxel that can take neither is locked.
      var canMaterial = !!d.edit[r.i], canColour = !!d.paint[r.i];
      var locked = !canMaterial && !canColour;
      var title = canMaterial && canColour ? 'Apply the current paint to all of these'
        : canColour ? 'These can be recoloured, but their material is fixed'
        : 'Their material can change, but Trove colours these itself';
      // A material group can span many colours, and a single swatch implied it didn't -
      // which is half of why "everything of that material" surprised people. Show up to
      // three of the colours actually in the group, and say how many there are.
      var cols = Array.from(r.colours);
      var swatch = cols.length === 1
        ? 'background:' + hex(cols[0])
        : 'background:linear-gradient(135deg,' + cols.slice(0, 3).map(function (c, k, a) {
            var from = Math.round(k / a.length * 100), to = Math.round((k + 1) / a.length * 100);
            return hex(c) + ' ' + from + '%,' + hex(c) + ' ' + to + '%';
          }).join(',') + ')';
      var colnote = cols.length > 1 ? ' · ' + cols.length + ' colours' : '';
      return '<li class="bpe-matrow' + (locked ? ' bpe-locked' : '') + '">'
        + '<span class="bpe-swatch" style="' + swatch + '" title="'
        + esc(cols.length === 1 ? hex(cols[0]).toUpperCase() : cols.length + ' different colours')
        + '"></span>'
        + '<span class="bpe-matname" title="' + esc(label(r.i) + colnote) + '">'
        + esc(label(r.i)) + '<small class="bpe-colnote">' + esc(colnote) + '</small></span>'
        + '<span class="bpe-matcount">' + r.count.toLocaleString() + '</span>'
        + (locked
            ? '<span class="bpe-lock" title="Controlled by the game — preserved on save">'
              + '<i class="fa-solid fa-lock" aria-hidden="true"></i></span>'
            : '<button type="button" class="bpe-applyall' + ((canMaterial && canColour) ? '' : ' bpe-partial')
              + '" data-type="' + r.type + '" data-w="' + r.w + '" title="' + esc(title) + '">Apply</button>')
        + '</li>';
    }).join('');
  }

  function renderMeta() {
    var s = state.data.stats;
    var live = liveCount();
    var bits = [
      live.toLocaleString() + ' voxels'
        + (live !== s.voxels ? ' (was ' + s.voxels.toLocaleString() + ')' : ''),
      'v' + state.data.version,
      state.data.size.join('×'),
    ];
    $('bpe-meta').textContent = bits.join(' · ');
    // In a model the part's name alone is half an answer - which model it belongs to is
    // the other half, and it is what the download is named after.
    $('bpe-filename').textContent = inProject()
      ? state.project.name + ' · ' + state.data.name
      : state.data.name;

    var notes = [];
    if (s.placeholders) {
      notes.push(s.placeholders.toLocaleString() + ' deco placeholder'
        + (s.placeholders === 1 ? '' : 's') + ' — these mark where furniture goes'
        + ' and are kept exactly as they are.');
    }
    if (s.procedural) {
      notes.push(s.procedural.toLocaleString() + ' voxel'
        + (s.procedural === 1 ? ' is' : 's are') + ' coloured by the game at runtime'
        + ' (terrain and the like), so repainting them here would have no effect in game.');
    }
    var other = s.locked - s.placeholders;
    if (other > 0) {
      notes.push(other.toLocaleString() + (other === 1 ? ' more voxel uses a material' : ' more voxels use materials')
        + ' outside the modding palette and ' + (other === 1 ? 'is' : 'are') + ' preserved as-is.');
    }
    if (s.entities) {
      notes.push(s.entities.toLocaleString() + ' placed object'
        + (s.entities === 1 ? '' : 's') + ' travel with the model untouched.');
    }
    // The attachment point is where the game grips or seats the model. It is usually
    // OUTSIDE the model for a hat or mask (that gap is the head), which looks wrong
    // until it's explained, so explain it rather than just printing coordinates.
    var a = state.data.attachment;
    if (a) {
      var outside = a[0] < 0 || a[1] < 0 || a[2] < 0
        || a[0] >= state.data.size[0] || a[1] >= state.data.size[1] || a[2] >= state.data.size[2];
      notes.push('Attaches at ' + a.join(', ') + (outside
        ? ' — outside the model, which is right for a hat or mask: the gap is where the head goes.'
        : ' — the pink marker in the view, where the game grips it.'));
    } else if (state.data.version !== 5) {
      notes.push('This is an older blueprint (v' + state.data.version + '), which stores no '
        + 'attachment point, so there is none to show.');
    }
    var box = $('bpe-notes');
    box.innerHTML = notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    box.hidden = !notes.length;
  }

  function renderSelection() {
    var box = $('bpe-selection');
    var i = state.selection;
    renderScopeHint();
    if (i < 0 || !state.data) {
      box.innerHTML = '<p class="bpe-hint">Click a voxel to select it.</p>';
      return;
    }
    var d = state.data;
    // Say which half is unavailable, not just "locked" - a placeable-colour voxel
    // takes a new colour but not a new material, and the two read very differently.
    var note = '';
    if (!d.edit[i] && !d.paint[i]) {
      note = 'The game controls this voxel’s colour and material. It’s saved exactly as it is.';
    } else if (!d.edit[i]) {
      note = 'You can recolour this voxel, but its material is one the game manages and is kept as-is.';
    } else if (!d.paint[i]) {
      note = 'Trove colours this voxel itself, so only its material can be changed here.';
    }
    box.innerHTML =
      '<div class="bpe-selrow"><span class="bpe-swatch" style="background:'
        + hex(d.rgb[i]) + '"></span>'
      + '<div><strong>' + esc(label(i)) + '</strong>'
      + '<span class="bpe-selcoords">' + d.x[i] + ', ' + d.y[i] + ', ' + d.z[i]
      + ' · ' + hex(d.rgb[i]).toUpperCase() + '</span></div></div>'
      + (note
          ? '<p class="bpe-hint bpe-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> '
            + esc(note) + '</p>'
          : '');
  }

  function updateDirty() {
    scheduleSave();
    var n = editList().length;
    $('bpe-save').disabled = false;
    var undoBtn = $('bpe-undo'), redoBtn = $('bpe-redo');
    if (inModelView()) {
      // Say which history the buttons walk, so it is never a surprise which of the two
      // they take back.
      undoBtn.disabled = !state.project.history.length;
      undoBtn.title = 'Undo the last change to the model';
      redoBtn.disabled = !state.project.redo.length;
      redoBtn.title = 'Redo the last change to the model';
    } else {
      undoBtn.disabled = !state.history.length;
      undoBtn.title = inProject() ? 'Undo the last change to this part' : 'Undo';
      redoBtn.disabled = !state.redo.length;
      redoBtn.title = inProject() ? 'Redo the last change to this part' : 'Redo';
    }
    $('bpe-revert').disabled = !n;
    if (inProject()) {
      // Across the whole model, not just the part in front of you - the download
      // carries all of it, so the count has to describe all of it.
      var total = 0, parts = 0;
      state.docs.forEach(function (d) {
        var c = editListOf(d).length;
        if (c) { total += c; parts++; }
      });
      $('bpe-dirty').textContent = total
        ? total.toLocaleString() + ' voxel' + (total === 1 ? '' : 's') + ' changed across '
          + parts + ' part' + (parts === 1 ? '' : 's')
        : 'No changes yet';
      return;
    }
    $('bpe-dirty').textContent = n
      ? n.toLocaleString() + ' voxel' + (n === 1 ? '' : 's') + ' changed'
      : 'No changes yet';
  }

  // ---- wiring ------------------------------------------------------------- //

  // ---- keeping your work through a refresh --------------------------------- //

  /* Everything above this line lives in memory, which meant a refresh, a closed tab or
     a crash threw away an afternoon. This keeps it in the browser instead - IndexedDB,
     never the server, because a half-finished model is the author's business and the
     rest of this page is built on not holding their work.

     What is stored is the ORIGINAL bytes plus the edit list - the same sparse,
     index-keyed diff a save already posts - and not the decoded model. A creature's
     payload is a dozen parallel arrays per part and megabytes of them; the file it came
     from is a few hundred kilobytes, and reopening it is a request the page already
     knows how to make. So a restore is: open it again exactly as you first did, then
     replay the diff.

     Replay lands on the right rows for free. A fresh inspect gives `origin[i] === i`, so
     an edit's `i` IS its row, and adds append in list order because that is the order
     `editListOf` walked them out in. */

  var DB_NAME = 'btt-bpe', DB_STORE = 'sessions', DB_VERSION = 1;
  var MAX_SESSIONS = 6;            // a working set, not an archive
  var saveTimer = 0, dbPromise = null;

  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    }).catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }

  function idbDo(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  /* Bytes are read once per file and kept: autosave runs on every edit, and re-reading
     a .tmod off disk each time would be the slowest thing on the page. */
  function bytesOf(file) {
    if (!file) return Promise.resolve(null);
    if (file._bytes) return Promise.resolve(file._bytes);
    return file.arrayBuffer().then(function (buf) {
      try { file._bytes = buf; } catch (e) { /* frozen File - just don't cache */ }
      return buf;
    });
  }

  /* How to open this again. Captured when it IS opened rather than reconstructed later,
     so a restore takes the same route the original did and there is no second code path
     to drift from the first. */
  function reopenSpec() {
    var o = state.openWith;
    if (!o) return Promise.resolve(null);
    if (o.kind === 'game') {
      return Promise.resolve({ kind: 'game', prefab: o.prefab, label: o.label });
    }
    if (o.kind === 'files') {
      return Promise.all(o.files.map(function (f) {
        return bytesOf(f).then(function (b) { return { name: f.name, bytes: b }; });
      })).then(function (parts) { return { kind: 'files', parts: parts }; });
    }
    return bytesOf(o.file).then(function (b) {
      return { kind: o.kind, name: o.file.name, bytes: b };
    });
  }

  function docSnapshot(d) {
    return {
      path: d.path || '', name: d.file ? d.file.name : '',
      edits: editListOf(d),
      move: d.move.slice(), row: d.row.slice(), offset: d.offset.slice(),
      ap: d.ap, locked: !!d.locked, visible: d.visible !== false,
      added: !!d.added, mode: d.mode,
    };
  }

  function editedCount() {
    return state.docs.reduce(function (n, d) { return n + editListOf(d).length; }, 0);
  }

  function scheduleSave() {
    if (!state.docs.length || state.restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 900);
  }

  function saveSession() {
    if (!state.docs.length || state.restoring) return Promise.resolve();
    return reopenSpec().then(function (open) {
      if (!open) return null;
      var rec = {
        id: state.sessionId,
        savedAt: Date.now(),
        name: state.project ? state.project.name
                            : ((state.docs[0].file || {}).name || 'blueprint'),
        parts: state.docs.length,
        edited: editedCount(),
        open: open,
        project: state.project ? {
          name: state.project.name, source: state.project.source,
        } : null,
        docs: state.docs.map(docSnapshot),
        active: state.active, anchor: state.anchor,
      };
      return idbDo('readwrite', function (st) { st.put(rec); }).then(trimSessions);
    }).then(markSaved, function () { /* quota, private mode, no IDB - never fatal */ });
  }

  function trimSessions() {
    return listSessions().then(function (all) {
      var extra = all.slice(MAX_SESSIONS);
      if (!extra.length) return null;
      return idbDo('readwrite', function (st) {
        extra.forEach(function (r) { st.delete(r.id); });
      });
    });
  }

  function listSessions() {
    return idbDo('readonly', function (st) { return st.getAll(); })
      .then(function (all) {
        return (all || []).sort(function (a, b) { return b.savedAt - a.savedAt; });
      })
      .catch(function () { return []; });
  }

  function dropSession(id) {
    return idbDo('readwrite', function (st) { st.delete(id); }).catch(function () {});
  }

  function markSaved() {
    var el = $('bpe-saved');
    if (!el) return;
    el.hidden = false;
    el.textContent = 'Saved on this PC';
  }

  /* Put the edits back onto a freshly opened part. Deliberately not through `applyTo`:
     this is not an action the user is taking now, so it makes no undo entry and refuses
     nothing - the permissions were enforced when each edit was first made, and this is
     the same file they were made against. */
  function replayEdits(docu, edits) {
    var d = docu.payload;
    var cells = new Map();
    for (var i = 0; i < d.count; i++) cells.set(d.x[i] + ',' + d.y[i] + ',' + d.z[i], i);
    (edits || []).forEach(function (e) {
      var j;
      if (e.add) {
        var key = e.add.join(',');
        j = cells.get(key);
        if (j === undefined) {
          j = d.count;
          d.x.push(e.add[0]); d.y.push(e.add[1]); d.z.push(e.add[2]);
          d.rgb.push(0); d.type.push(21); d.w.push(0);
          d.kind.push(0); d.level.push(255); d.spec.push(0);
          d.edit.push(1); d.paint.push(1); d.live.push(1);
          docu.origin.push(-1);
          d.count = j + 1;
          cells.set(key, j);
        }
        d.live[j] = 1;
      } else {
        j = e.i;
        // A save that no longer fits its file is dropped rather than applied to whatever
        // row happens to sit at that index now.
        if (!(j >= 0 && j < d.count)) return;
        if (e.del) { d.live[j] = 0; return; }
      }
      if (e.rgb !== undefined) d.rgb[j] = e.rgb;
      if (e.type !== undefined) { d.type[j] = e.type; d.w[j] = e.w; }
      reshade(j, d);
    });
  }

  function applySnapshot(snaps) {
    var byKey = {};
    snaps.forEach(function (sn) { byKey[sn.path || sn.name] = sn; });
    state.docs.forEach(function (d) {
      var sn = byKey[d.path || (d.file && d.file.name)]
            || (snaps.length === 1 && state.docs.length === 1 ? snaps[0] : null);
      if (!sn) return;
      d.move = sn.move.slice(); d.row = sn.row.slice(); d.offset = sn.offset.slice();
      if (sn.ap !== undefined) d.ap = sn.ap;
      d.locked = sn.locked; d.visible = sn.visible; d.mode = sn.mode || d.mode;
      replayEdits(d, sn.edits);
      /* mount() has already run by this point: it drew the stack and built each part's
         list thumbnail from the payload as it came off the wire, and BOTH are cached -
         `state.drawn` for the geometry, `d.thumb` for the picture. Replaying the edits
         changes the payload underneath both caches, so anything derived from it has to
         be dropped here or the part keeps showing its unedited self: the 3D layer until
         you click it, and the thumbnail for as long as the model stays open. */
      d.dirtyMesh = true;
      clearThumb(d);
    });
  }

  function restoreSession(rec) {
    var open = rec.open;
    if (!open) return;
    state.restoring = true;

    var done = function () {
      // Every reopen path ends in mount(); the saved edits go on after it, and then the
      // page is redrawn as though it had been edited to this point.
      applySnapshot(rec.docs);
      var want = Math.min(rec.active || 0, state.docs.length - 1);
      state.anchor = Math.min(rec.anchor || 0, state.docs.length - 1);
      state.sessionId = rec.id;
      state.restoring = false;
      setActive(want);
      if (state.scene) state.scene.rebuild(liveView());
      drawStack();
      setStatus('Picked up where you left off — ' + rec.edited.toLocaleString()
        + ' change' + (rec.edited === 1 ? '' : 's') + ' restored. Undo starts fresh.', 'ok');
    };
    var fail = function (err) {
      state.restoring = false;
      setStatus((err && err.message) || 'That saved model could not be reopened.', 'error');
    };

    if (open.kind === 'game') { openGameModel(open.prefab, open.label, done, fail); return; }
    if (open.kind === 'files') {
      openModel(open.parts.map(function (p) { return new File([p.bytes], p.name); }), done, fail);
      return;
    }
    var file = new File([open.bytes], open.name);
    if (open.kind === 'archive') { openModel(file, done, fail); return; }
    openFile(file, null, done, fail);
  }

  /* The list on the opening screen. Drawn only when there is something in it, so a
     first visit looks exactly as it did before any of this existed. */
  function renderSessions() {
    var box = $('bpe-resume'), list = $('bpe-resumelist');
    if (!box || !list) return;
    listSessions().then(function (all) {
      box.hidden = !all.length;
      if (!all.length) return;
      list.innerHTML = all.map(function (r) {
        return '<li class="bpe-resumerow">'
          + '<button type="button" class="bpe-resumeopen" data-resume="' + esc(r.id) + '">'
          + '<span class="bpe-resumename">' + esc(r.name) + '</span>'
          + '<span class="bpe-resumemeta">' + esc(agoText(r.savedAt))
          + ' · ' + r.edited.toLocaleString() + ' change' + (r.edited === 1 ? '' : 's')
          + (r.parts > 1 ? ' · ' + r.parts + ' parts' : '') + '</span></button>'
          + '<button type="button" class="bpe-resumex" data-forget="' + esc(r.id) + '"'
          + ' title="Forget this" aria-label="Forget ' + esc(r.name) + '">&times;</button>'
          + '</li>';
      }).join('');
    });
  }

  function agoText(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function ready() {
    var input = $('bpe-input');
    $('bpe-open').addEventListener('click', function () { input.click(); });
    $('bpe-open2').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) openFile(input.files[0]);
      input.value = '';
    });

    var drop = $('bpe-page');
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('bpe-dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('bpe-dragging'); });
    });
    /* Sorting the drop by extension rather than asking is the whole point of a drop
       target, and with model projects there is more to sort: a .tmod or .zip is a whole
       model, several blueprints at once are a model too, and one blueprint dropped onto
       an open model joins it as a part. */
    drop.addEventListener('drop', function (e) {
      var dropped = e.dataTransfer && e.dataTransfer.files;
      if (!dropped || !dropped.length) return;
      var all = Array.prototype.slice.call(dropped);
      var qbs = all.filter(function (f) { return /\.qb$/i.test(f.name); });
      var bps = all.filter(function (f) { return /\.blueprint$/i.test(f.name); });
      var mod = all.find(function (f) { return /\.(tmod|zip)$/i.test(f.name); });
      if (qbs.length) importQb(qbs);
      else if (mod) openModel(mod);
      else if (bps.length && inProject()) addParts(bps);
      else if (bps.length > 1) openModel(bps);
      // A .qbcl is a Qubicle project holding several models, not one grid, so it has
      // nothing to compile from - say that rather than failing as a bad blueprint.
      else if (/\.qbcl$/i.test(all[0].name)) {
        setStatus('That’s a Qubicle project file, which holds several models at once. '
          + 'Export the model as .qb and drop that instead.', 'error');
      } else openFile(all[0]);
    });

    $('bpe-colour').addEventListener('input', function (e) {
      state.paint.rgb = unhex(e.target.value);
      $('bpe-colour-hex').textContent = hex(state.paint.rgb).toUpperCase();
      renderSwatches();
    });

    state.swatches = loadSwatches();
    renderSwatches();
    // Before the first renderToolHint, so the hint opens naming the right gesture.
    state.nav = loadNav();
    renderNav();
    $('bpe-swatch-add').addEventListener('click', function () {
      var rgb = state.paint.rgb;
      if (state.swatches.indexOf(rgb) >= 0) {
        setStatus(hex(rgb).toUpperCase() + ' is already in the palette.');
        return;
      }
      state.swatches.unshift(rgb);
      state.swatches.length = Math.min(state.swatches.length, MAX_SWATCHES);
      storeSwatches();
      renderSwatches();
    });
    /* Clicking a swatch sets the COLOUR only. Material and finish are their own
       controls, and a palette that quietly changed those too would repaint glass as
       solid the first time someone reached for a shade they liked. */
    $('bpe-swatches').addEventListener('click', function (e) {
      var x = e.target.closest('[data-swx]');
      if (x) {
        state.swatches.splice(parseInt(x.dataset.swx, 10), 1);
        storeSwatches();
        renderSwatches();
        return;
      }
      var b = e.target.closest('[data-sw]');
      if (!b) return;
      state.paint.rgb = state.swatches[parseInt(b.dataset.sw, 10)];
      syncPaintUI();
    });

    $('bpe-types').addEventListener('click', function (e) {
      var b = e.target.closest('.bpe-mat');
      if (!b) return;
      state.paint.type = parseInt(b.dataset.type, 10);
      state.paint.w = 0;
      renderPalette();
    });
    $('bpe-finish').addEventListener('click', function (e) {
      var b = e.target.closest('.bpe-w');
      if (!b) return;
      state.paint.w = parseInt(b.dataset.w, 10);
      renderWOptions();
    });

    labelToolKeys();
    document.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { setTool(b.dataset.tool); });
    });

    $('bpe-boxmodes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-boxmode]');
      if (!b) return;
      state.box.fill = b.dataset.boxmode === 'fill';
      Array.prototype.forEach.call(e.currentTarget.children, function (o) {
        o.setAttribute('aria-pressed', String(o.dataset.boxmode === b.dataset.boxmode));
      });
      drawBox();
    });

    $('bpe-slice-axes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-slice]');
      if (!b || !state.data) return;
      var v = b.dataset.slice;
      setSlice(v === 'off' ? { on: false } : { on: true, axis: v });
    });
    $('bpe-slicebar').addEventListener('click', function (e) {
      var b = e.target.closest('[data-slicestep]');
      if (!b) return;
      setSlice({ at: state.slice.at + parseInt(b.dataset.slicestep, 10) });
    });
    $('bpe-slice-at').addEventListener('input', function (e) {
      setSlice({ at: parseInt(e.target.value, 10) || 0 });
    });

    renderSessions();
    $('bpe-resumelist').addEventListener('click', function (e) {
      var x = e.target.closest('[data-forget]');
      if (x) {
        dropSession(x.dataset.forget).then(renderSessions);
        return;
      }
      var b = e.target.closest('[data-resume]');
      if (!b) return;
      listSessions().then(function (all) {
        var rec = all.find(function (r) { return r.id === b.dataset.resume; });
        if (rec) restoreSession(rec);
      });
    });

    renderGrabs();
    $('bpe-grabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-grab]');
      if (!b) return;
      state.grab = b.dataset.grab;
      renderGrabs();
    });
    $('bpe-selclear').addEventListener('click', clearSelection);
    $('bpe-selout').addEventListener('click', function () {
      state.selOut = !state.selOut;
      renderSelectionBar();
    });
    $('bpe-selnudge').addEventListener('click', function (e) {
      var b = e.target.closest('[data-selnudge]');
      if (!b) return;
      var v = b.dataset.selnudge.split(',').map(Number);
      shiftSelection(v[0], v[1], v[2], $('bpe-selcopy').checked);
    });

    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.mode;
        document.querySelectorAll('[data-mode]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o.dataset.mode === state.mode));
        });
      });
    });
    document.querySelectorAll('[data-scope]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.scope = b.dataset.scope;
        document.querySelectorAll('[data-scope]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o.dataset.scope === state.scope));
        });
        renderScopeHint();
      });
    });

    // "Apply" on a material row is the same edit as clicking one of its voxels,
    // aimed at every voxel that shares the material.
    $('bpe-materials').addEventListener('click', function (e) {
      var b = e.target.closest('.bpe-applyall');
      if (!b || !state.data) return;
      var t = parseInt(b.dataset.type, 10), w = parseInt(b.dataset.w, 10);
      var c = change();
      if (!Object.keys(c).length) return;
      var batch = [], refused = 0, masked = 0;
      for (var i = 0; i < state.data.count; i++) {
        if (state.data.type[i] !== t || state.data.w[i] !== w) continue;
        if (!allowed(i)) { masked++; continue; }
        if (!applyTo(i, c, batch)) refused++;
      }
      commit(batch, refused);
      if (masked && !refused) {
        setStatus(masked.toLocaleString() + ' voxel' + (masked === 1 ? ' was' : 's were')
          + ' outside the selection and left alone.', 'ok');
      }
    });

    $('bpe-kind').addEventListener('change', function (e) {
      state.kind = e.target.value;
      staleReport();
    });
    $('bpe-check').addEventListener('click', runCheck);
    $('bpe-report').addEventListener('click', function (e) {
      var b = e.target.closest('.bpe-f-show');
      if (!b || !state.report) return;
      var f = state.report.findings[parseInt(b.dataset.finding, 10)];
      var already = b.classList.contains('active');
      [...document.querySelectorAll('.bpe-f-show')].forEach(function (o) {
        o.classList.remove('active');
      });
      if (already) {
        state.scene && state.scene.clearOverlay('lint');
      } else {
        b.classList.add('active');
        highlightFinding(f);
      }
    });
    $('bpe-show-attach').addEventListener('change', function (e) {
      state.showAttach = e.target.checked;
      drawAttachment();
    });

    var qbInput = $('bpe-qb-input');
    $('bpe-import-qb').addEventListener('click', function () { qbInput.click(); });
    $('bpe-import-qb2').addEventListener('click', function () { qbInput.click(); });
    qbInput.addEventListener('change', function () {
      if (qbInput.files && qbInput.files.length) importQb(qbInput.files);
      qbInput.value = '';
    });
    $('bpe-transforms').addEventListener('click', function (e) {
      var b = e.target.closest('.bpe-xform');
      if (b) runTransform(b.dataset.op);
    });
    var layerInput = $('bpe-layer-input');
    $('bpe-layer-open').addEventListener('click', function () { layerInput.click(); });
    layerInput.addEventListener('change', function () {
      if (layerInput.files && layerInput.files.length) {
        // The same button adds a layer to a stack and a part to a model - which of
        // those you are doing is decided by what is open, not by picking the right one.
        if (inProject()) addParts(layerInput.files);
        else addLayer(layerInput.files[0]);
      }
      layerInput.value = '';
    });

    var search = $('bpe-search');
    if (search) {
      var go = U.debounce(runSearch, 250);
      search.addEventListener('input', go);
      search.addEventListener('search', runSearch);
      $('bpe-searchtype').addEventListener('change', runSearch);
      $('bpe-results').addEventListener('click', function (e) {
        var b = e.target.closest('.bpe-result');
        if (!b || !b.dataset.prefab) return;
        openGameModel(b.dataset.prefab, b.querySelector('.bpe-result-name').textContent);
      });
      // A codex row can name a blueprint the renderer has nothing to draw for, and a
      // broken-image box is worse than none. Captured, because `error` doesn't bubble.
      $('bpe-results').addEventListener('error', function (e) {
        if (e.target && e.target.tagName === 'IMG') e.target.remove();
      }, true);
    }

    var modelInput = $('bpe-model-input');
    ['bpe-open-model', 'bpe-open-model2'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', function () { modelInput.click(); });
    });
    modelInput.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(modelInput.files || []);
      if (picked.length) {
        var mod = picked.find(function (f) { return /\.(tmod|zip)$/i.test(f.name); });
        openModel(mod || picked);
      }
      modelInput.value = '';
    });
    $('bpe-save-part').addEventListener('click', save);

    /* Double-click a part to go INTO it - Qubicle's gesture, and the one that makes a
       sixteen-part creature a single workspace rather than sixteen files. It isolates
       too: you went in to work on that part, and the rest of the creature standing
       around it is what made the part hard to see in the first place. The way back out
       is one button, on the stage where you are already looking. */
    $('bpe-stage').addEventListener('dblclick', function (e) {
      if (!inProject() || !state.scene || state.anim.on) return;
      var top = state.scene.pickTop(e);
      if (!top.layer) return;
      var i = indexOfDoc(top.layer);
      if (i < 0) return;
      state.isolate = true;
      setActive(i);                          // ends by calling updateDirty
      state.scene.frameAll();
      setStatus('Editing ' + partLabel(state.docs[i])
        + ' on its own — “Show the whole model” brings the rest back.', 'ok');
    });

    /* Point at a part and take it - reaching for the picker every time you want the
       other wing is the tedious way round. TWO gestures, because neither costs anything
       and people have different mice:

       MIDDLE-CLICK, which nothing else on the stage uses (it used to fall through and
       paint, which is fixed in voxel_scene.js), and SHIFT-CLICK for a trackpad with no
       middle button - shift only means anything while DRAGGING, where it pans, so a
       shift-click that never travelled was free. Alt-click is the eyedropper and stays
       exactly that. */
    var downAt = null;
    $('bpe-stage').addEventListener('pointerdown', function (e) {
      downAt = [e.clientX, e.clientY];
    }, true);
    function grabPart(e) {
      if (!inProject() || !state.scene || state.anim.on) return;
      // a drag was a pan or an orbit, not a pick
      if (downAt && Math.abs(e.clientX - downAt[0]) + Math.abs(e.clientY - downAt[1]) > 4) return;
      var top = state.scene.pickTop(e);
      var i = top.layer ? indexOfDoc(top.layer) : -1;
      if (i < 0) return;
      e.preventDefault();
      setActive(i);
      setStatus('Now editing ' + partLabel(state.docs[i]) + '.', 'ok');
    }
    $('bpe-stage').addEventListener('click', function (e) {
      if (e.shiftKey) grabPart(e);
    });
    $('bpe-stage').addEventListener('auxclick', function (e) {
      if (e.button === 1) grabPart(e);
    });
    /* Every gesture in one dialog, rather than the one line of hint text that fitted
       under the stage. `showModal` brings the focus trap and Escape with it; the extra
       click handler closes on the backdrop, which a <dialog> does not do by itself. */
    var keysDlg = $('bpe-keysdlg');
    keysDlg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-nav]');
      if (b) setNav(b.dataset.nav);
    });
    /* Arrows move within the group and pick as they go, which is how a radiogroup is
       expected to behave - Tab is for leaving it, not for walking three options. */
    keysDlg.addEventListener('keydown', function (e) {
      var b = e.target.closest && e.target.closest('[data-nav]');
      if (!b) return;
      var step = /Right|Down/.test(e.key) ? 1 : (/Left|Up/.test(e.key) ? -1 : 0);
      if (!step) return;
      e.preventDefault();
      var order = window.VoxelScene ? window.VoxelScene.SCHEMES : Object.keys(NAV_INFO);
      var at = order.indexOf(state.nav);
      setNav(order[(at + step + order.length) % order.length]);
      var next = keysDlg.querySelector('[data-nav="' + state.nav + '"]');
      if (next) next.focus();
    });
    $('bpe-keys').addEventListener('click', function () {
      // The model-only rows are meaningless with a single blueprint open.
      keysDlg.classList.toggle('bpe-has-model', inProject());
      if (keysDlg.showModal) keysDlg.showModal(); else keysDlg.setAttribute('open', '');
    });
    $('bpe-keys-close').addEventListener('click', function () { keysDlg.close(); });
    keysDlg.addEventListener('click', function (e) {
      if (e.target === keysDlg) keysDlg.close();      // the backdrop, not the card
    });

    // The stage's own controls.
    $('bpe-stagepart').addEventListener('change', function (e) {
      setActive(+e.target.value);
    });
    $('bpe-animate').addEventListener('click', function () {
      setAnimating(!state.anim.on);
    });
    $('bpe-apsel').addEventListener('change', function (e) {
      setPartAp(state.active, e.target.value);
    });
    $('bpe-flatten').addEventListener('click', flattenStack);
    /* One control for both directions: going into a part and coming back out. Two
       buttons for that is how you end up hunting for the one that undoes the other. */
    $('bpe-isolate').addEventListener('click', function () {
      state.isolate = !state.isolate;
      renderLayers();
      drawStack();
      // Stepping in or out changes WHICH history undo walks, so the button has to say
      // so in the same breath.
      updateDirty();
      // Re-frame either way. `frameAll` frames what is DRAWN, so on the way in that is
      // the part by itself - which is the whole point of going in - and on the way out
      // it is the creature again.
      if (inProject() && state.scene) state.scene.frameAll();
      setStatus('');
    });
    $('bpe-layerlist').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-pick],button[data-vis],button[data-up],' +
                               'button[data-down],button[data-drop],button[data-anchor],' +
                               'button[data-lock]');
      if (!b) return;
      var ds = b.dataset;
      if (ds.pick !== undefined) return setActive(+ds.pick);
      if (ds.anchor !== undefined) return setAnchor(+ds.anchor);
      if (ds.vis !== undefined) {
        var d = doc(+ds.vis);
        if (d) { d.visible = !d.visible; renderLayers(); drawStack(); }
        return;
      }
      if (ds.lock !== undefined) {
        var ld = doc(+ds.lock);
        if (ld) {
          ld.locked = !ld.locked;
          renderLayers();
          setStatus(ld.locked ? '' : ld.payload.name + ' can be moved now.', 'ok');
        }
        return;
      }
      if (ds.up !== undefined) return reorderLayer(+ds.up, 1);
      if (ds.down !== undefined) return reorderLayer(+ds.down, -1);
      if (ds.drop !== undefined) {
        return inProject() ? removePart(+ds.drop) : removeLayer(+ds.drop);
      }
    });
    // Answering "where does this part attach". The options are the rig's own sockets,
    // so the only thing that can be picked is a bone the skeleton actually has.
    // The shared dropdown copies the select's classes onto its trigger button, so match
    // the element that actually carries the value and the index.
    $('bpe-layerlist').addEventListener('change', function (e) {
      var sel = e.target.closest('select.bpe-apsel');
      if (sel) setPartAp(+sel.dataset.ap, sel.value);
    });
    $('bpe-align').addEventListener('change', function (e) {
      var d = active();
      if (!d) return;
      d.mode = e.target.value;
      d.offset = [0, 0, 0];
      renderLayers();
      drawStack();
    });
    $('bpe-nudge').addEventListener('click', function (e) {
      var b = e.target.closest('[data-nudge]');
      if (!b) return;
      var v = b.dataset.nudge.split(',').map(Number);
      nudgeActive(v[0], v[1], v[2]);
    });
    $('bpe-export-qb').addEventListener('click', exportQb);

    $('bpe-undo').addEventListener('click', undo);
    $('bpe-redo').addEventListener('click', redo);
    $('bpe-revert').addEventListener('click', revertAll);
    $('bpe-save').addEventListener('click', function () {
      if (inProject()) saveModel(); else save();
    });

    /* A field has first claim on every key it can take: the search box, the colour hex,
       a filename. Without this, typing "brush" into the model search would switch tools
       five times and never reach the box. */
    function typing(e) {
      var t = e.target || {};
      return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable;
    }

    document.addEventListener('keydown', function (e) {
      if (!$('bpe-page') || !$('bpe-page').offsetParent) return;   // another tab is showing
      var bare = !e.ctrlKey && !e.metaKey && !e.altKey;

      // Stepping the slice: the bracket keys, as in every other voxel editor. Only
      // while a slice is on, so they stay free the rest of the time.
      if (state.slice.on && state.data && bare && (e.key === '[' || e.key === ']')
          && !typing(e)) {
        e.preventDefault();
        setSlice({ at: state.slice.at + (e.key === ']' ? 1 : -1) });
        return;
      }

      /* One key per tool. Shift is allowed through - it is held for a shift-click and
         letting go of it a frame late should not swallow the next tool press - but a
         modifier that means something else here (Ctrl-Z, Alt-click) is not. */
      if (state.data && bare && !typing(e)) {
        var want = KEY_TOOL[e.key.toLowerCase()];
        if (want) {
          e.preventDefault();
          setTool(want);
          setStatus('');
          return;
        }
      }

      if (!(e.ctrlKey || e.metaKey) || !state.data) return;
      var k = e.key.toLowerCase();
      // Both spellings of redo: Ctrl-Shift-Z everywhere, Ctrl-Y for the Windows habit.
      if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'z') { e.preventDefault(); undo(); }
    });
  }

  // Starts once Modder Tools has injected the sub-view, not on page load.
  var started = false;
  document.addEventListener('modder_qb_editor_loaded', function () {
    if (started || !$('bpe-page')) return;
    started = true;
    ready();
  });
  // The canvas keeps the size it had when the tab was last visible.
  document.addEventListener('modder_qb_editor_shown', function () {
    if (!state.scene) return;
    requestAnimationFrame(function () { state.scene.resize(); state.scene.request(); });
  });
})();
