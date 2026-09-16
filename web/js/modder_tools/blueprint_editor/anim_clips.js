/* Kiwi rig animation - clips, the control bar, and the maths that plays them.

   Lifted out of `model_viewer.js`, which grew all of this while it was the only thing
   that played a creature's animations. The Blueprint Editor plays them too now, and a
   second copy of the bucketing rules would mean two answers to "which button is this
   clip under" - so this is the one answer, and the bar looks and reads the same
   wherever it is mounted.

   Split by what a host has to decide for itself:

     shared   what the clips are called and how they group, the rig's state machine ->
              moves, the control bar, decoding a clip, and sampling a pose from it
     host     where the frames are fetched from, and what a pose is applied TO - three
              meshes with matrices, or a scene placing parts on a rig

   Usage:
     var kit = AnimClips.programs(names, graph);       // buttons + what each one plays
     var bar = AnimClips.bar({ host: el, kit: kit, onPick: play });
     var prog = AnimClips.timeline(kit.programs[key], loadedClips);
     var at = AnimClips.frameAt(prog, seconds);
     var pose = AnimClips.sample(at, 'head');          // { p: [3], q: [4] } | null
*/
(function () {
  'use strict';

  var _styles = false;

  /* The bar's own styling, so a host gets the control looking right by mounting it.
     These are the `mv-*` classes model_viewer has always drawn - same names, so its
     markup and anything themed against it are untouched. */
  function injectStyles() {
    if (_styles) return;
    _styles = true;
    var css =
      '.mv-bar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:10px 12px;border-top:1px solid #232a33}' +
      '.mv-btn{background:#1b2129;border:1px solid #2a323d;color:#cdd6e0;border-radius:8px;padding:6px 12px;font-size:.82rem;cursor:pointer}' +
      '.mv-btn:hover{border-color:#4cc9f0}.mv-btn.on{background:rgba(86,156,255,.16);border-color:#4cc9f0;color:#e6edf3}' +
      '.mv-btn.mv-loading{opacity:.55;cursor:progress}' +
      '.mv-btn:focus-visible,.mv-cat:focus-visible{outline:2px solid #4cc9f0;outline-offset:1px}' +
      '.mv-hint{color:#6b7480;font-size:.74rem;margin-left:auto;flex:0 1 auto;min-width:0;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.mv-cats,.mv-clips{display:flex;flex-wrap:wrap;gap:7px;align-items:center;flex:1 0 100%;min-width:0}' +
      '.mv-clips{max-height:min(5.6rem,26vh);overflow-y:auto;overscroll-behavior:contain}' +
      '.mv-cat{background:transparent;border:1px solid #2a323d;color:#9aa4b2;border-radius:999px;' +
        'padding:3px 11px;font-size:.75rem;cursor:pointer;display:inline-flex;gap:5px;align-items:center}' +
      '.mv-cat:hover{border-color:#4cc9f0;color:#cdd6e0}' +
      '.mv-cat.on{background:rgba(86,156,255,.16);border-color:#4cc9f0;color:#e6edf3}' +
      '.mv-cat-n{opacity:.6;font-variant-numeric:tabular-nums}' +
      '.mv-sep{width:1px;height:18px;background:#2a323d;flex:0 0 auto}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ---- decoding ------------------------------------------------------------ //

  /* One baked animation clip (TANIM1). Layout, little-endian:
       8s  magic "TANIM1\0\0"
       u32 ap_count, u32 frame_count, u32 fps, u32 name_blob_len
       ..  name_blob: NUL-separated attach-point keys, NUL-padded to a 4-byte boundary
       ..  frame_count * ap_count * 7 float32: position xyz then quaternion xyzw
     The float payload is 4-byte aligned by construction, so it wraps with no copy. */
  function decode(buf) {
    var dv = new DataView(buf);
    var head = new Uint8Array(buf, 0, 6), magic = '';
    for (var i = 0; i < 6; i++) magic += String.fromCharCode(head[i]);
    if (magic !== 'TANIM1') throw new Error('bad animation clip');
    var apCount = dv.getUint32(8, true), frameCount = dv.getUint32(12, true);
    var fps = dv.getUint32(16, true), nb = dv.getUint32(20, true);
    var raw = new Uint8Array(buf, 24, nb), s = '';
    for (var j = 0; j < nb; j++) s += String.fromCharCode(raw[j]);
    var keys = s.split('\0').filter(Boolean);
    var apIndex = {};
    for (var k = 0; k < keys.length; k++) apIndex[keys[k]] = k;
    return {
      fps: fps, frameCount: frameCount, apCount: apCount, apIndex: apIndex,
      data: new Float32Array(buf, 24 + nb, frameCount * apCount * 7),
    };
  }

  // ---- names, and the buckets they fall into -------------------------------- //

  /* Clip names read <stance>_<action>_<detail>, e.g. "unarmed_ability_drink" or
     "mount_balance_idle". A companion ships a handful; a player rig ships 80+, which
     would bury the model under buttons, so those bucket by action and the bar shows one
     bucket at a time. Matching is prefix-based on the action token - anything unmatched
     lands in "Other" rather than being guessed into the wrong bucket. */
  var STANCES = ['unarmed_', 'ranged_', '1h_', '2h_'];
  var CLIP_GROUPS = [
    ['Idle', ['idle', 'sleep', 'pose', 'sit', 'afk', 'bob', 'stand', 'breathe', 'wait']],
    ['Move', ['walk', 'run', 'jump', 'roll', 'swim', 'glide', 'fly', 'climb', 'dash',
              'sprint', 'land', 'fall', 'turn', 'strafe', 'charge', 'move', 'hover',
              'crawl', 'slide', 'recall', 'leap', 'flip']],
    ['Mount', ['mount']],
    ['Combat', ['ability', 'melee', 'shoot', 'throw', 'attack', 'block', 'cast', 'mine',
                'shockwave', 'damage', 'death', 'die', 'hit', 'fling', 'instant', 'swing',
                'stab', 'punch', 'kick', 'slam', 'rampage', 'multispit', 'breath']],
    ['Emote', ['emote', 'dance', 'wave', 'laugh', 'cry', 'shrug', 'taunt', 'bow',
               'excite', 'point', 'clap', 'salute', 'prance']],
    ['Fishing', ['fishing']],
  ];
  var OTHER = 'Other';

  function stripStance(name) {
    for (var i = 0; i < STANCES.length; i++) {
      if (name.indexOf(STANCES[i]) === 0) return name.slice(STANCES[i].length);
    }
    return name;
  }

  /* -> { group, token }; token is the action word the bucket matched on, so the label
     can drop it (under "Mount", "mount balance idle" reads better as "balance idle"). */
  function clipInfo(name) {
    var b = stripStance(name);
    for (var i = 0; i < CLIP_GROUPS.length; i++) {
      var toks = CLIP_GROUPS[i][1];
      for (var j = 0; j < toks.length; j++) {
        if (b === toks[j] || b.indexOf(toks[j] + '_') === 0) {
          return { group: CLIP_GROUPS[i][0], token: toks[j] };
        }
      }
    }
    return { group: OTHER, token: null };
  }

  function groupRank(g) {
    for (var i = 0; i < CLIP_GROUPS.length; i++) if (CLIP_GROUPS[i][0] === g) return i;
    return CLIP_GROUPS.length;                     // Other sorts last
  }

  /* Tokens that are pure namespaces - the bucket chip already says "Mount", so
     "mount balance idle" reads better as "balance idle". Every other token carries
     meaning that the bucket name does not ("walk"/"run" both live under Move, and
     "idle class" must not collapse to a bare "class"), so it stays in the label. */
  var NAMESPACE_TOKENS = { mount: 1, ability: 1, emote: 1, fishing: 1 };

  function clipLabel(name, token) {
    var b = stripStance(name).replace(/_/g, ' ');
    if (token && NAMESPACE_TOKENS[token] && b.indexOf(token + ' ') === 0) {
      b = b.slice(token.length + 1);
    }
    return b;
  }

  // ---- moves, from the rig's own state machine ------------------------------ //

  /* A jump is not one clip: the game plays jump_begin, lets jump_cycle hold while you
     are in the air, then jump_end (or jump_end_run_forward if you land moving). Listing
     those as three unrelated buttons asks the viewer to reassemble a move the game
     already knows how to assemble, so we read it out of `<rig>.graph.json` instead.

     The edge kinds carry the structure, and none of it is inferred from clip names.
     Granny's own state-machine source decides which trigger each answers to:
       onloop      the clip ended and the machine moves on BY ITSELF - a hard chain
       onrequest   gameplay asked for that state - a branch, e.g. how landing chooses
     A state with an outgoing onloop edge therefore FINISHES; one without it HOLDS.

     The others are deliberately not chained. onconditional fires whenever a gameplay
     condition holds and dynamic is driven from game code, so neither is a clip ending.
     lastresort shares onloop's trigger a pass later, and reading it as a continuation
     is tempting - but all 20 in the game are idle variation, six mounts alternating
     happy_idle with happy_idle_alternate and back. Chaining them builds a cycle where
     a state should simply hold, which cost the dog its "sad" and "happy" moves.

     A move is: a start state, the states its onloop edges run through, and one ending
     picked from the branches out of the state it comes to rest on. A state whose chain
     ends at a hub - somewhere many moves return to, i.e. idle - is an ending, not a
     start, which is what keeps every emote a plain button instead of its own "move". */
  var STEP_WORDS = { begin: 1, cycle: 1, end: 1, start: 1, stop: 1, loop: 1,
                     enter: 1, exit: 1, idle: 1 };

  function buildMoves(graph, have) {
    var nodes = graph && graph.nodes, edges = graph && graph.edges;
    if (!nodes || !edges) return [];
    function clipOf(id) {
      var n = nodes[id];
      if (!n) return null;
      var c = n.clip || (n.clips && n.clips.length === 1 ? n.clips[0] : null);
      return c && have[c] ? c : null;
    }
    /* A rig nests state machines (Movement, Ability, ...) and each one carries its own
       "idle", so several distinct nodes share a name. Identity therefore keys on the
       CLIP a state plays, not on the node id, or the same clip walks into a move twice
       and the real rest state never looks like one. */
    function key(id) { return clipOf(id) || ('#' + id); }
    var auto = {}, autoIn = {}, req = {}, reqFrom = {};
    edges.forEach(function (e) {
      if (e.from == null || e.to == null || e.from === e.to) return;
      if (e.when === 'onloop') {
        if (!auto[e.from]) auto[e.from] = e;         // one automatic successor per state
        var k = key(e.to);
        autoIn[k] = (autoIn[k] || 0) + 1;
      } else if (e.when === 'onrequest') {
        (req[e.from] = req[e.from] || []).push(e);
        var t = key(e.to), f = key(e.from);
        if (!reqFrom[t]) reqFrom[t] = {};
        reqFrom[t][f] = 1;
      }
    });
    // a state that many other states fall back into by themselves is where moves END -
    // idle, and whatever else a rig rests in
    function isHub(id) { return !auto[id] && (autoIn[key(id)] || 0) >= 2; }

    var chains = [];
    Object.keys(nodes).forEach(function (id) {
      if (!auto[id] || autoIn[key(id)]) return;      // must finish, and must start a chain
      var seen = {}, path = [], cur = id;
      while (cur != null) {
        var k = key(cur);
        if (seen[k]) { cur = null; break; }
        seen[k] = 1;
        var e = auto[cur];
        path.push({ id: cur, next: e ? (e.blend || 0) : 0 });
        if (!e) break;                               // nothing automatic follows: it holds
        if (isHub(e.to) || seen[key(e.to)]) { cur = null; break; }   // back to rest
        cur = e.to;
      }
      if (cur == null || path.length < 2) return;    // ran back to rest -> a clip, not a move
      chains.push({ park: cur, path: path, keys: seen });
    });
    chains.sort(function (a, b) { return b.path.length - a.path.length; });

    var used = {}, moves = [];
    chains.forEach(function (ch) {
      var clips = [], blends = [];
      for (var i = 0; i < ch.path.length; i++) {
        var c = clipOf(ch.path[i].id);
        if (!c) return;                              // a clip we do not ship - skip the move
        if (used[ch.path[i].id]) return;
        clips.push(c);
        blends.push(i ? (ch.path[i - 1].next || 0) : 0);
      }
      // how the move is entered, so looping the preview can cross-fade the way the
      // game does rather than cutting
      var first = clipOf(ch.path[0].id), enter = 0;
      edges.forEach(function (e) {
        // compare on the clip: ids arrive as strings from the node map and as numbers on
        // the edges, so identity has to go through the same key as everywhere else
        if (enter || e.when !== 'onrequest' || clipOf(e.to) !== first) return;
        if (isHub(e.from) || !enter) enter = e.blend || 0;
      });
      /* Which branch ENDS the move is the one thing the file does not answer. Granny has
         a field for exactly this - a transition's PreferredExit, "leaving that state,
         prefer this way out" - and Trove sets it on none of its 9,016 transitions, so
         the choice is ours to make and worth naming as such.

         The rule: an ending belongs to THIS move; a state the rest of the rig asks for
         just as often is a destination the move happens to allow, not part of it.
         Landing into a backward run is real, but run_backward is asked for from idle,
         from running, from taking a hit - it is its own state. jump_end is asked for
         from inside the jump and almost nowhere else. */
      var endKeys = {};
      var endings = (req[ch.park] || []).filter(function (e) {
        var k = clipOf(e.to);
        if (!k || ch.keys[k] || endKeys[k] || used[e.to] || isHub(e.to)) return false;
        var from = Object.keys(reqFrom[k] || {}), inside = 0;
        from.forEach(function (f) { if (ch.keys[f]) inside++; });
        if (inside * 2 <= from.length) return false;      // more of the rig wants it than this move
        endKeys[k] = 1;
        return true;
      });
      var made = [];
      if (!endings.length) {
        made.push({ clips: clips.slice(), blends: blends.slice(), enter: enter, ids: [] });
      } else {
        endings.forEach(function (e) {
          made.push({ clips: clips.concat([clipOf(e.to)]),
                      blends: blends.concat([e.blend || 0]), enter: enter, ids: [e.to] });
        });
      }
      made.forEach(function (m) {
        m.label = moveLabel(m.clips);
        moves.push(m);
      });
      ch.path.forEach(function (s) { used[s.id] = 1; });
      made.forEach(function (m) { m.ids.forEach(function (i) { used[i] = 1; }); });
    });
    // two moves that came out with the same clips and the same name are one move
    var seenKey = {};
    return moves.filter(function (m) {
      var k = m.clips.join('|');
      if (seenKey[k]) return false;
      seenKey[k] = 1;
      return true;
    });
  }

  /* "jump_begin + jump_cycle + jump_end_run_forward" -> "jump & run forward": the shared
     leading words name the move, and whatever the ending adds on top names the variant.
     The step words themselves (begin/cycle/end) never reach the label. */
  function moveLabel(clips) {
    var toks = clips.map(function (c) { return stripStance(c).split('_'); });
    var stem = [];
    for (var i = 0; ; i++) {
      var t = toks[0][i];
      if (t === undefined || STEP_WORDS[t]) break;
      var shared = toks.every(function (x) { return x[i] === t; });
      if (!shared) break;
      stem.push(t);
    }
    if (!stem.length) stem = toks[0].slice(0, 1);
    var tail = toks[toks.length - 1].slice(stem.length).filter(function (t) {
      return !STEP_WORDS[t];
    });
    return stem.join(' ') + (tail.length ? ' & ' + tail.join(' ') : '');
  }

  /* One button = one program. The rig's state machine (when it has one) folds the clips
     that only ever play as part of a move - jump_begin, jump_cycle, jump_end - into that
     single move, and whatever it does not claim stays its own button.

     `have` is the clip list: an array of names, or the metadata object keyed by them. */
  function programs(have, graph) {
    var names = Array.isArray(have) ? have : Object.keys(have || {});
    var index = {};
    names.forEach(function (n) { index[n] = 1; });
    var out = {}, entries = [], covered = {};
    (graph ? buildMoves(graph, index) : []).forEach(function (m) {
      var key = 'move:' + m.clips.join('+');
      var blends = m.blends.slice();
      blends[0] = m.enter || 0;                   // the fade that loops it back round
      out[key] = { clips: m.clips, blends: blends };
      entries.push({ key: key, name: m.clips[0], label: m.label });
      m.clips.forEach(function (c) { covered[c] = 1; });
    });
    names.forEach(function (c) {
      if (covered[c]) return;
      out[c] = { clips: [c], blends: [0] };
      entries.push({ key: c, name: c, label: null });
    });
    return { programs: out, entries: entries };
  }

  // ---- the control bar ------------------------------------------------------ //

  /* Up to FLAT_MAX programs list flat; past that they bucket by action so the bar stays
     a couple of rows instead of burying the model. */
  var FLAT_MAX = 12;

  /* `opts`: { host, kit, onPick(key|null), restLabel, hint, onResize }.
     `onPick` gets null for "rest pose" - the host decides what resting means. */
  function bar(opts) {
    injectStyles();
    var host = opts.host, kit = opts.kit, entries = kit.entries;
    var onResize = opts.onResize || function () {};
    var active = null;
    host.textContent = '';
    host.classList.add('mv-bar');

    function mkBtn(parent, label, an) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mv-btn';
      b.textContent = label;
      b.dataset.anim = an;
      b.addEventListener('click', function () { pick(an === 'rest' ? null : an); });
      parent.appendChild(b);
      return b;
    }
    function pick(key) {
      setActive(key);
      if (opts.onPick) opts.onPick(key);
    }
    function setActive(key) {
      active = key;
      Array.prototype.forEach.call(host.querySelectorAll('.mv-btn'), function (b) {
        b.classList.toggle('on', b.dataset.anim === (key || 'rest'));
      });
    }
    function setLoading(key, on) {
      var b = host.querySelector('.mv-btn[data-anim="' + (window.CSS && CSS.escape
        ? CSS.escape(key) : key) + '"]');
      if (b) b.classList.toggle('mv-loading', !!on);
    }

    function entryLabel(e, token) { return e.label || clipLabel(e.name, token); }

    var hintHost = host;
    if (entries.length <= FLAT_MAX) {
      mkBtn(host, opts.restLabel || 'Rest pose', 'rest');
      entries.forEach(function (e) { mkBtn(host, entryLabel(e, null), e.key); });
    } else {
      var buckets = {}, groups = [];
      entries.forEach(function (e) {
        var g = clipInfo(e.name).group;
        if (!buckets[g]) { buckets[g] = []; groups.push(g); }
        buckets[g].push(e);
      });
      groups.sort(function (a, b) { return groupRank(a) - groupRank(b); });

      var cats = document.createElement('div');
      cats.className = 'mv-cats';
      var clips = document.createElement('div');
      clips.className = 'mv-clips';
      clips.setAttribute('role', 'group');
      clips.setAttribute('aria-label', 'Animation clips');
      host.appendChild(cats);
      host.appendChild(clips);

      mkBtn(cats, opts.restLabel || 'Rest pose', 'rest');
      var sep = document.createElement('span');
      sep.className = 'mv-sep';
      sep.setAttribute('aria-hidden', 'true');
      cats.appendChild(sep);

      var showGroup = function (g) {
        clips.textContent = '';
        buckets[g].forEach(function (e) {
          mkBtn(clips, entryLabel(e, clipInfo(e.name).token), e.key);
        });
        onResize();                               // bucket sizes differ -> bar height changed
        Array.prototype.forEach.call(cats.querySelectorAll('.mv-cat'), function (b) {
          var on = b.dataset.cat === g;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        setActive(active);                        // keep the playing clip highlighted
      };
      groups.forEach(function (g) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mv-cat';
        b.dataset.cat = g;
        b.setAttribute('aria-pressed', 'false');
        b.appendChild(document.createTextNode(g + ' '));
        var n = document.createElement('span');
        n.className = 'mv-cat-n';
        n.textContent = buckets[g].length;
        b.appendChild(n);
        b.addEventListener('click', function () { showGroup(g); });
        cats.appendChild(b);
      });
      showGroup(groups[0]);
      hintHost = cats;                            // ride the category row, not a third line
    }
    if (opts.hint) {
      var hint = document.createElement('span');
      hint.className = 'mv-hint';
      hint.textContent = opts.hint;
      hintHost.appendChild(hint);
    }
    setActive(null);
    return { setActive: setActive, setLoading: setLoading, host: host };
  }

  // ---- playing one ---------------------------------------------------------- //

  /* Lay a program's clips on one looping timeline. Each clip starts before the one ahead
     of it has finished, overlapping by that edge's cross-fade, and `blends[0]` is the
     fade that carries the last clip back into the first so a repeat does not cut. A
     cross-fade is capped at half of either clip it joins - a 250ms fade across a 200ms
     clip would otherwise never show the clip at all.

     `loaded` maps clip name -> decoded clip. Returns null if any of them is missing. */
  function timeline(spec, loaded) {
    var A = [], i;
    if (!spec) return null;
    for (i = 0; i < spec.clips.length; i++) {
      var c = loaded[spec.clips[i]];
      if (!c || !c.frameCount) return null;
      A.push(c);
    }
    var n = A.length, dur = A.map(function (x) { return x.frameCount / x.fps; });
    var blends = [], starts = [0];
    for (i = 0; i < n; i++) {
      var prev = dur[(i - 1 + n) % n];
      blends.push(n < 2 ? 0 : Math.max(0, Math.min(spec.blends[i] || 0,
                                                   dur[i] / 2, prev / 2)));
    }
    for (i = 1; i < n; i++) starts[i] = starts[i - 1] + dur[i - 1] - blends[i];
    return { A: A, dur: dur, blends: blends, starts: starts,
             total: starts[n - 1] + dur[n - 1] - blends[0] };
  }

  /* Where a program is at `t` seconds in: the clip and frame to sample, plus the clip
     being faded out of and how far across. */
  function frameAt(prog, t) {
    var n = prog.A.length;
    t = ((t % prog.total) + prog.total) % prog.total;
    var i = n - 1;
    while (i > 0 && t < prog.starts[i]) i--;
    var cur = prog.A[i], local = t - prog.starts[i], b = prog.blends[i];
    if (n > 1 && b > 0 && local < b) {
      var p = (i - 1 + n) % n;
      // coming out of the last clip into the first, the previous step started before
      // this lap did
      var ps = i === 0 ? prog.starts[p] - prog.total : prog.starts[p];
      return { A: prog.A[p], f: (t - ps) * prog.A[p].fps,
               B: cur, g: local * cur.fps, u: local / b };
    }
    return { A: cur, f: local * cur.fps, B: null, g: 0, u: 0 };
  }

  /* The pose of one attach point, as position + quaternion, or null when the clip does
     not drive it. Clips bake at the game's rate (30fps) and the display runs at 60/120,
     so the pose blends between the two neighbouring frames rather than snapping to one -
     the transforms are rigid, so that is a lerp on position and a slerp on rotation. The
     next frame wraps to 0 because playback loops. */
  function sampleOne(A, ai, f, out) {
    var n = A.frameCount, f0 = Math.floor(f), a = f - f0, d = A.data;
    var o = ((f0 % n) * A.apCount + ai) * 7;
    out.p[0] = d[o]; out.p[1] = d[o + 1]; out.p[2] = d[o + 2];
    out.q[0] = d[o + 3]; out.q[1] = d[o + 4]; out.q[2] = d[o + 5]; out.q[3] = d[o + 6];
    if (a) {
      var o2 = (((f0 + 1) % n) * A.apCount + ai) * 7;
      lerpInto(out, d[o2], d[o2 + 1], d[o2 + 2],
               d[o2 + 3], d[o2 + 4], d[o2 + 5], d[o2 + 6], a);
    }
    return out;
  }

  function lerpInto(out, px, py, pz, qx, qy, qz, qw, a) {
    out.p[0] += (px - out.p[0]) * a;
    out.p[1] += (py - out.p[1]) * a;
    out.p[2] += (pz - out.p[2]) * a;
    // shortest arc: flip the target when the two quaternions face opposite ways
    var dot = out.q[0] * qx + out.q[1] * qy + out.q[2] * qz + out.q[3] * qw;
    var s = dot < 0 ? -1 : 1;
    out.q[0] += (s * qx - out.q[0]) * a;
    out.q[1] += (s * qy - out.q[1]) * a;
    out.q[2] += (s * qz - out.q[2]) * a;
    out.q[3] += (s * qw - out.q[3]) * a;
    var len = Math.hypot(out.q[0], out.q[1], out.q[2], out.q[3]) || 1;
    for (var i = 0; i < 4; i++) out.q[i] /= len;
  }

  var _scratch = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  var _other = { p: [0, 0, 0], q: [0, 0, 0, 1] };

  /* The pose of `apKey` at the moment `frameAt` described - including the cross-fade
     into the next clip when there is one. Returns a SHARED object: read it before the
     next call. */
  function sample(at, apKey) {
    var ai = at.A.apIndex[apKey];
    if (ai === undefined) return null;
    sampleOne(at.A, ai, at.f, _scratch);
    if (at.B) {
      var bi = at.B.apIndex[apKey];
      if (bi !== undefined) {
        sampleOne(at.B, bi, at.g, _other);
        lerpInto(_scratch, _other.p[0], _other.p[1], _other.p[2],
                 _other.q[0], _other.q[1], _other.q[2], _other.q[3], at.u);
      }
    }
    return _scratch;
  }

  window.AnimClips = {
    decode: decode,
    programs: programs,
    bar: bar,
    timeline: timeline,
    frameAt: frameAt,
    sample: sample,
    clipInfo: clipInfo,
    clipLabel: clipLabel,
    buildMoves: buildMoves,
  };
})();
