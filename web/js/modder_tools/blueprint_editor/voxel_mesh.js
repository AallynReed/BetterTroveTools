/* Kiwi voxel mesher - turns a voxel payload into drawable geometry.

   Both 3D viewers used to draw every voxel as a complete 1x1x1 cube. For solids
   that only wastes triangles (you can't see an interior face through an opaque
   one), but for GLASS it's visible: the faces where two transparent voxels touch
   are still drawn, so a pane of glass shows a grid of internal quads and reads as
   darker where voxels overlap. This emits only the faces that can actually be
   seen, by the same rule the server's catalog rasterizer uses
   (`app/trove/render/voxel.py::_faces`), so the WebGL preview and the PNG render
   finally agree:

     - no neighbour                      -> draw
     - opaque, neighbour opaque          -> cull (never visible)
     - opaque, neighbour transparent     -> draw (the solid shows THROUGH the glass)
     - transparent, ANY neighbour        -> cull (this is the fix)

   Fewer faces is also just less geometry: a solid model drops its whole interior,
   and nothing has to build a per-voxel instance matrix any more.

   Input is one voxel set - a single blueprint, or one part of an assembled
   creature - as {x, y, z, rgb, kind, level, spec}, plain arrays or typed arrays
   alike. Output is one mesh per material group (kind + glass level + specular),
   coloured per vertex. */
(function () {
  'use strict';

  // Per face: outward normal, then the two tangents u,v with u x v = n, so the
  // quad p0..p3 below winds counter-clockwise seen from outside.
  var FACES = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 0, 0, 1, 1, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, 0, 1, 0, 1, 0, 0]
  ];

  // Beyond this the bounding box is mostly empty air, so index by key instead of
  // paying for the grid (a 64 MB Int32Array for a handful of voxels).
  var MAX_CELLS = 16 << 20;

  function isOpaque(kind) { return kind === 0 || kind === 2; }   // solid / glow

  /* --- The lighting model ---------------------------------------------------

     The previews used to shade with three.js' own Phong material under an ambient
     plus two directional lights. That is a different lighting model from the
     game's, and it shows: flat midtones, crushed shadow sides, and a white
     highlight on everything. Trove's object pass is a plain forward shader whose
     source ships with the client, so we run its arithmetic instead of
     approximating it:

       programs/fragment/terrain.fragment                    CalcTerrainColor
       programs/fragment/library_diffuselighting.fragment    Lighting_LightingSS
       programs/fragment/library_specularlighting.fragment   Lighting_BRDFSpecular

     Fed the inputs a lone model actually has - no world lightmap, no fog, no
     point lights, no normal map - every term of CalcTerrainColor that depends on
     world state falls out (blockColor 0, darkness 1, fog 0, subsurface 0) and
     what remains is:

       lighting = sunColor * pow(max(N·L * 0.7 + 0.3, 0.0), 0.65)   // wrap diffuse
                + brdfLobe * sunSpecular                            // baked lobe
                + ambientColor
       colour   = voxelColour * mix(lighting, vec3(1.2), glow)

     The `* 0.7 + 0.3` wrap and the 0.65 curve are the whole Trove look: a face
     turned away from the sun settles at 0.3 instead of black, and the curve lifts
     the midtones, so voxels read as softly lit rather than half in shadow.

     The highlight is not derived from a roughness number. A solid voxel's
     specular value (rough · metal · water · iridescent · waxy) indexes a 4x2
     atlas of pre-baked lobes (textures/brdfmap.dds) sampled by (N·H, L·H) - the
     rainbow sheen of "iridescent" is literally a tile of that image. The lobe is
     summed into the lighting BEFORE the voxel's own colour multiplies it, which
     is why gold shimmers gold rather than white. Until the atlas arrives - or if
     the server can't serve it - the sampler holds an empty texture and reads
     black, so a model still draws, just without highlights.

     Everything is in VIEW space, as the game's is: its `viewNormal` is the
     normal matrix applied to the vertex normal, and its `worldPos` is really the
     view-space position (the shader takes the eye vector as `normalize(-worldPos)`,
     which only holds with the eye at the origin). */
  var BRDF_MAP = { value: null };          // shared by every material; filled once
  var _brdfLoad = null, _brdfWaiters = [];

  /* The engine feeds sun/ambient per biome and time of day; a viewer has no world
     to read them from, so it runs one neutral white sun. Sun + ambient reach just
     past 1.0 on a face pointed at the light and leave 0.36 on one pointed away -
     the game's contrast range, rather than three.js' flatter default rig. */
  var SUN = 0.66, SUN_SPEC = 0.85, AMBIENT = 0.36;   // the neutral rig, per channel
  var FALLBACK_DIR = [0.7, 1.0, 0.55];
  var LIGHT = null;
  var HOST_DIR = null;      // the first direction a host asked for = "normal" for the control
  var CTL = null;           // the viewer's Lighting control, once someone has moved it

  function ensureLight(THREE) {
    if (LIGHT) return LIGHT;
    LIGHT = {
      kBrdfMap: BRDF_MAP,
      kSun: { value: new THREE.Vector3(SUN, SUN, SUN) },                    // sunLightColor
      kSunSpec: { value: new THREE.Vector3(SUN_SPEC, SUN_SPEC, SUN_SPEC) }, // sunLightSpecular
      kAmbient: { value: new THREE.Vector3(AMBIENT, AMBIENT, AMBIENT) },    // ambientLightColor
      kSunDir: { value: new THREE.Vector3().fromArray(FALLBACK_DIR).normalize() },
    };
    return LIGHT;
  }

  /* Move the sun or retint it. Every material shares these uniform objects, so one
     call relights the whole scene; the host still has to ask for a redraw.

     A host names its sun on every build - the Blueprint Editor rebuilds after each
     edit - so a sun the user has set with the Lighting control has to OUTRANK the
     host's rather than be overwritten by the next repaint. */
  function setLighting(THREE, opts) {
    var L = ensureLight(THREE);
    if (opts.lightDir && !HOST_DIR) HOST_DIR = [opts.lightDir[0], opts.lightDir[1], opts.lightDir[2]];
    if (CTL) return applyControl(THREE);
    if (opts.lightDir) L.kSunDir.value.fromArray(opts.lightDir).normalize();
    if (opts.sun) L.kSun.value.fromArray(opts.sun);
    if (opts.specular) L.kSunSpec.value.fromArray(opts.specular);
    if (opts.ambient) L.kAmbient.value.fromArray(opts.ambient);
  }

  /* --- The Lighting control (viewer_stage.js) -------------------------------

     `intensity` 0..1, `azimuth` and `elevation` in degrees. Dimming the sun on its
     own would just sink the model into the dark, so the light it gives up moves
     into the ambient term: 0% is the model under a flat, even light - its true
     colours, no shading at all - at the brightness 100% shows it at. Passing null
     hands the sun back to whatever the host asked for. */
  function setLightControl(THREE, ctl) {
    CTL = ctl ? { intensity: ctl.intensity, azimuth: ctl.azimuth, elevation: ctl.elevation } : null;
    if (CTL) return applyControl(THREE);
    var L = ensureLight(THREE);
    L.kSun.value.setScalar(SUN);
    L.kSunSpec.value.setScalar(SUN_SPEC);
    L.kAmbient.value.setScalar(AMBIENT);
    L.kSunDir.value.fromArray(HOST_DIR || FALLBACK_DIR).normalize();
  }

  function applyControl(THREE) {
    var L = ensureLight(THREE), t = Math.max(0, Math.min(1, CTL.intensity));
    L.kSun.value.setScalar(SUN * t);
    L.kSunSpec.value.setScalar(SUN_SPEC * t);
    L.kAmbient.value.setScalar(AMBIENT + SUN * (1 - t));
    var e = CTL.elevation * Math.PI / 180, a = CTL.azimuth * Math.PI / 180;
    // already unit length, by construction
    L.kSunDir.value.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  }

  // Where the sun is now, whoever last set it - the guide rays draw along this
  // rather than recomputing the angles, so the two can't disagree.
  function sunDirection(THREE) {
    return ensureLight(THREE).kSunDir.value.toArray();
  }

  /* The settings that reproduce the host's own sun, so the control opens showing
     the viewer as it already looks and "Reset" has somewhere to go back to. */
  function lightControlDefaults() {
    var d = HOST_DIR || FALLBACK_DIR, DEG = 180 / Math.PI;
    var len = Math.hypot(d[0], d[1], d[2]) || 1;
    return {
      intensity: 1,
      azimuth: (Math.round(Math.atan2(d[0], d[2]) * DEG) + 360) % 360,
      elevation: Math.round(Math.asin(d[1] / len) * DEG),
    };
  }

  // `color` is declared here rather than via `vertexColors`, so the attribute is
  // named once whatever three.js decides to inject for a ShaderMaterial.
  var VERT = [
    'attribute vec3 color;',
    'varying vec3 vCol;',
    'varying vec3 vNor;',
    'varying vec3 vEye;',
    'void main() {',
    '  vCol = color;',
    '  vNor = normalize(normalMatrix * normal);',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vEye = -mv.xyz;',                  // view space: the eye sits at the origin
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var FRAG = [
    'uniform sampler2D kBrdfMap;',
    'uniform vec3 kSun;',
    'uniform vec3 kSunSpec;',
    'uniform vec3 kAmbient;',
    'uniform vec3 kSunDir;',              // world space; the sun follows the model, not the camera
    'uniform float kTile;',               // effectColor.x * 8.0 - which lobe of the atlas
    'uniform float kGlow;',               // effectColor.y
    'uniform float kOpacity;',
    'varying vec3 vCol;',
    'varying vec3 vNor;',
    'varying vec3 vEye;',
    '',
    // Lighting_BRDFSpecular. cell.y picks the atlas row (tiles 0-3 bottom, 4-7
    // top); the clamps are the game's half-texel inset, which stops one lobe
    // bleeding into its neighbour. `bias` is the fractional part of the index,
    // always 0 for the whole-number values a voxel carries.
    'vec3 kBrdf(vec3 N, vec3 L, vec3 E) {',
    '  float sel = floor(kTile + 0.01);',
    '  float bias = kTile - sel;',
    '  vec2 cell = vec2(mod(sel, 4.0), step((kTile + 0.01) / 4.0, 1.0));',
    '  vec3 H = normalize(E + L);',
    '  vec2 tx;',
    '  tx.x = clamp((dot(N, H) / (1.0 - bias)) - bias / (1.0 - bias), 0.0078125, 0.9921875);',
    '  tx.y = clamp(dot(L, H), 0.00390625, 0.99609375);',
    '  return texture2D(kBrdfMap, (cell + tx) * vec2(0.25, 0.5)).rgb',
    '         * clamp(dot(N, L) * 2.0 + 1.0, 0.0, 1.0) * 1.5;',
    '}',
    '',
    'void main() {',
    '  vec3 N = normalize(vNor);',
    '  vec3 E = normalize(vEye);',
    '  vec3 L = normalize((viewMatrix * vec4(kSunDir, 0.0)).xyz);',
    '  vec3 spec = kBrdf(N, L, E) * kSunSpec;',
    '  vec3 lighting = kSun * pow(max(dot(N, L) * 0.7 + 0.3, 0.0), 0.65) + spec + kAmbient;',
    '  vec3 lit = vCol * mix(lighting, vec3(1.2), kGlow);',
    // The game widens a translucent voxel's alpha wherever the highlight lands, so
    // a specular streak across glass reads as solid rather than see-through.
    '  gl_FragColor = vec4(lit, max(max(spec.r, spec.g), max(kOpacity, spec.b)));',
    '}'
  ].join('\n');

  /* Fetch the atlas once per page. Failure is not an error - the model still
     draws, just without highlights - so a missing texture costs fidelity, not a model.

     It goes through `fetch` first, and only then into the loader, because a texture
     asked for as an <img> is INVISIBLE to the fetch wrappers pages put in front of
     /site/*: ours moves those calls to the API origin, and a partner framing the
     viewer proxies them through its own server. Both were rewriting every other
     request the viewer makes and silently missing this one, which 404s and leaves
     every solid shaded rough. A fetch that never got an answer at all (blocked, or
     an origin that serves the file but sends no CORS header) still falls back to the
     plain loader, which needs neither - but a real HTTP error is taken at its word
     rather than asked for a second time. */
  function loadBrdf(THREE, url, onReady) {
    if (BRDF_MAP.value) return;
    if (onReady) _brdfWaiters.push(onReady);
    if (_brdfLoad) return;
    function into(src, revoke) {
      new THREE.TextureLoader().load(src, function (tex) {
        tex.flipY = false;                 // atlas rows are top-down, as the game samples them
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;       // a mip would smear one lobe into the next
        BRDF_MAP.value = tex;
        if (revoke) URL.revokeObjectURL(src);
        _brdfWaiters.splice(0).forEach(function (fn) { fn(); });
      }, undefined, function () {
        if (revoke) URL.revokeObjectURL(src);
        _brdfWaiters.length = 0;
      });
    }
    _brdfLoad = fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('brdf ' + r.status);   // answered, and said no
      return r.blob().then(function (b) { into(URL.createObjectURL(b), true); });
    }).catch(function (e) {
      if (String(e && e.message).indexOf('brdf ') === 0) { _brdfWaiters.length = 0; return; }
      into(url, false);                                 // never answered - try it as an <img>
    });
  }

  /* 0 solid · 1 glass · 2 glow · 3 glow-glass. Glass opacity = (level/255)^2
     (level = 16+32*w), matching the game/catalog. Colour rides on the vertices.
     All four kinds run the one shader above - glow is the shader's own glow term,
     not a second unlit material - so there is a single lighting model on screen. */
  function makeMaterial(THREE, kind, level, spec) {
    var L = ensureLight(THREE), glass = (kind === 1 || kind === 3);
    return new THREE.ShaderMaterial({
      uniforms: {
        kBrdfMap: L.kBrdfMap, kSun: L.kSun, kSunSpec: L.kSunSpec,
        kAmbient: L.kAmbient, kSunDir: L.kSunDir,
        kTile: { value: kind === 0 ? (spec || 0) : 0 },
        kGlow: { value: (kind === 2 || kind === 3) ? 1 : 0 },
        kOpacity: { value: glass ? Math.pow((level || 255) / 255, 2) : 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: glass,
      depthWrite: !glass,
    });
  }

  /* Which voxel (if any) sits at each cell, so a face can ask its neighbour's kind. */
  function occupancy(X, Y, Z, n) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, i;
    for (i = 0; i < n; i++) {
      if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
      if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
      if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
    }
    var w = maxX - minX + 3, h = maxY - minY + 3, d = maxZ - minZ + 3;   // 1 cell of padding
    if (n && w * h * d <= MAX_CELLS) {
      var grid = new Int32Array(w * h * d), hd = h * d;
      for (i = 0; i < n; i++) grid[(X[i] - minX + 1) * hd + (Y[i] - minY + 1) * d + (Z[i] - minZ + 1)] = i + 1;
      return function (x, y, z) {
        x -= minX; y -= minY; z -= minZ;
        if (x < -1 || y < -1 || z < -1 || x > w - 2 || y > h - 2 || z > d - 2) return 0;
        return grid[(x + 1) * hd + (y + 1) * d + (z + 1)];
      };
    }
    var map = new Map();
    for (i = 0; i < n; i++) map.set(X[i] + ',' + Y[i] + ',' + Z[i], i + 1);
    return function (x, y, z) { return map.get(x + ',' + y + ',' + z) || 0; };
  }

  /* `opts`: { brdfUrl, lightDir:[x,y,z], sun, ambient, specular, onReady } - where
     to fetch the specular atlas, where the sun sits and what colour it is, and a
     redraw hook (the viewers render on demand, so a texture that lands after the
     first frame needs one). */
  function build(THREE, part, opts) {
    var X = part.x, Y = part.y, Z = part.z, RGB = part.rgb;
    var KIND = part.kind, LVL = part.level, SPEC = part.spec;
    var n = X ? X.length : 0;
    if (!n) return [];

    opts = opts || {};
    setLighting(THREE, opts);
    if (opts.brdfUrl) loadBrdf(THREE, opts.brdfUrl, opts.onReady);

    var at = occupancy(X, Y, Z, n);
    var kindOf = function (i) { return KIND ? (KIND[i] || 0) : 0; };
    var groupOf = function (i, k) {
      return k + ':' + ((k === 1 || k === 3) ? (LVL ? LVL[i] : 255) : 255)
               + ':' + (k === 0 && SPEC ? (SPEC[i] || 0) : 0);
    };

    // Pass 1: decide every face once, remember the six-bit answer, and count how
    // much geometry each material group needs.
    var mask = new Uint8Array(n), counts = {}, i, f;
    for (i = 0; i < n; i++) {
      var k = kindOf(i), opaque = isOpaque(k), bits = 0, drawn = 0;
      for (f = 0; f < 6; f++) {
        var F = FACES[f], nb = at(X[i] + F[0], Y[i] + F[1], Z[i] + F[2]);
        var draw = nb === 0 ? true : (opaque && !isOpaque(kindOf(nb - 1)));
        if (draw) { bits |= 1 << f; drawn++; }
      }
      mask[i] = bits;
      if (drawn) { var g = groupOf(i, k); counts[g] = (counts[g] || 0) + drawn; }
    }

    var buffers = {};
    Object.keys(counts).forEach(function (g) {
      var q = counts[g];
      buffers[g] = { pos: new Float32Array(q * 12), nor: new Float32Array(q * 12),
                     col: new Float32Array(q * 12), idx: new Uint32Array(q * 6), v: 0, t: 0 };
    });

    // Pass 2: write the quads.
    for (i = 0; i < n; i++) {
      if (!mask[i]) continue;
      var b = buffers[groupOf(i, kindOf(i))];
      var c = RGB ? RGB[i] : 0xffffff;
      var cr = ((c >> 16) & 255) / 255, cg = ((c >> 8) & 255) / 255, cb = (c & 255) / 255;
      var x = X[i], y = Y[i], z = Z[i];
      for (f = 0; f < 6; f++) {
        if (!(mask[i] & (1 << f))) continue;
        var F = FACES[f];
        var fx = x + F[0] * 0.5, fy = y + F[1] * 0.5, fz = z + F[2] * 0.5;   // face centre
        var ux = F[3] * 0.5, uy = F[4] * 0.5, uz = F[5] * 0.5;
        var vx = F[6] * 0.5, vy = F[7] * 0.5, vz = F[8] * 0.5;
        var base = b.v / 3, p = b.v;
        // p0 = c-u-v, p1 = c+u-v, p2 = c+u+v, p3 = c-u+v
        b.pos[p] = fx - ux - vx; b.pos[p + 1] = fy - uy - vy; b.pos[p + 2] = fz - uz - vz;
        b.pos[p + 3] = fx + ux - vx; b.pos[p + 4] = fy + uy - vy; b.pos[p + 5] = fz + uz - vz;
        b.pos[p + 6] = fx + ux + vx; b.pos[p + 7] = fy + uy + vy; b.pos[p + 8] = fz + uz + vz;
        b.pos[p + 9] = fx - ux + vx; b.pos[p + 10] = fy - uy + vy; b.pos[p + 11] = fz - uz + vz;
        for (var j = 0; j < 4; j++) {
          b.nor[p + j * 3] = F[0]; b.nor[p + j * 3 + 1] = F[1]; b.nor[p + j * 3 + 2] = F[2];
          b.col[p + j * 3] = cr; b.col[p + j * 3 + 1] = cg; b.col[p + j * 3 + 2] = cb;
        }
        b.v += 12;
        b.idx[b.t] = base; b.idx[b.t + 1] = base + 1; b.idx[b.t + 2] = base + 2;
        b.idx[b.t + 3] = base; b.idx[b.t + 4] = base + 2; b.idx[b.t + 5] = base + 3;
        b.t += 6;
      }
    }

    return Object.keys(buffers).map(function (g) {
      var b = buffers[g], kv = g.split(':'), k = +kv[0], lv = +kv[1], sp = +kv[2];
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
      geo.setIndex(new THREE.BufferAttribute(b.idx, 1));
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, makeMaterial(THREE, k, lv, sp));
      if (k === 1 || k === 3) mesh.renderOrder = 1;      // draw transparent after opaque
      return mesh;
    });
  }

  window.VoxelMesh = {
    build: build, makeMaterial: makeMaterial, setLighting: setLighting,
    setLightControl: setLightControl, lightControlDefaults: lightControlDefaults,
    sunDirection: sunDirection,
  };
})();
