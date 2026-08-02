// sprites.js — every graphic in the game as pixel data in code. No image
// assets. Each sprite is a `{ map, palette, scale? }` definition where `map`
// is an array of equal-length strings, '.' means transparent, and every other
// character indexes that sprite's own palette (a `{char: '#rrggbb'}` object).
//
// `buildSprites()` rasterizes them all to offscreen canvases at boot. The raw
// definitions stay exported so pure-Node tooling can validate them without a
// DOM, and so render.js can rasterize the background strips itself (see
// STAGE_PALETTES in render.js, which picks one of two mid-ground images per
// section rather than re-hueing one).
//
// Presentation module: may touch the DOM.

// --- generators for the geometric sprites --------------------------------
// Craters and mountain ridges are still pixel data, just described by their
// profile rather than by hand-typed 56-character rows.

/**
 * A bowl-shaped notch: full feature width at the top (ground level),
 * narrowing to a 2px floor. 's' is the lit rim lip, 'k' the shadowed pit.
 */
function craterMap(w, depth) {
  const rows = [];
  const half = w / 2;
  for (let y = 0; y < depth; y++) {
    const t = depth === 1 ? 1 : y / (depth - 1);
    // Elliptical wall: stays near full width through the upper half, then
    // curves in sharply — a bowl, not a wedge.
    const inset = Math.min(half - 1, Math.round((half - 1) * (1 - Math.sqrt(1 - t * t))));
    let row = '';
    for (let x = 0; x < w; x++) {
      const rim = Math.min(x - inset, w - 1 - inset - x);
      if (rim < 0) row += '.';
      else if (y === 0 && rim < 2) row += 's';       // lit lip at ground level
      else if (y === 1 && rim < 1) row += 's';
      else row += 'k';
    }
    rows.push(row);
  }
  return rows;
}

/** Two bowls joined by a short dark ridge — the classic wide double crater. */
function doubleCraterMap() {
  const depth = 16;
  const lobe = craterMap(26, depth);
  const rows = [];
  for (let y = 0; y < depth; y++) {
    rows.push(lobe[y] + (y <= 2 ? 'kkkk' : '....') + lobe[y]);
  }
  return rows;
}

/**
 * Horizontally tileable jagged ridge, emitted as a FILLED BAND rather than a
 * silhouette outline. `points` are peak heights sampled evenly across the
 * strip; index arithmetic wraps, so column `width-1` interpolates back toward
 * `points[0]` and the strip tiles seamlessly.
 *
 * Only two characters are produced: 'e' for the top `peakDepth` rows of each
 * column (the peak colour) and 'm' for everything below it, solid all the way
 * to the bottom of the strip. That is the M52's actual background structure:
 * each layer is a 2bpp image with a fixed 3-pen palette, and the hardware
 * fills every row below the image with the layer's pen 3 (MAME's
 * `m_do_bg_fills`) — so the "mountains" are a filled teal mass with blue
 * peaks, not a thin outlined ridge over sky. See
 * .superpowers/notes/authenticity-research.md §8.3.
 */
function ridgeMap(width, height, points, peakDepth) {
  const n = points.length;
  const cols = new Array(width);
  for (let x = 0; x < width; x++) {
    const t = (x / width) * n;
    const i = Math.floor(t);
    const f = t - i;
    cols[x] = Math.round(points[i % n] + (points[(i + 1) % n] - points[i % n]) * f);
  }
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = height - cols[x];
      if (y < top) row += '.';
      else if (y < top + peakDepth) row += 'e';
      else row += 'm';
    }
    rows.push(row);
  }
  return rows;
}

// The far range is the tall, broad one (distant mountains, M52 bg0/GFX3); the
// near range is a shorter, chunkier row of foothills in front of it (rolling
// hills, bg1/GFX4). Band heights were raised from 56/26 when the layers became
// filled masses: the research brief §8.2 measures the arcade's mountain band at
// 98px and hills band at ~70px of a 248-row frame, and §"Note on aspect ratio"
// notes our 384px-wide reframing shows ~2.4x more world per screen, which is
// exactly what makes thin bands read as sparse.
export const MOUNTAIN_FAR_MAP = ridgeMap(96, 84, [24, 40, 28, 52, 22, 44, 32, 38], 6);
export const MOUNTAIN_NEAR_MAP = ridgeMap(96, 40, [10, 24, 14, 19, 8, 21, 12, 17], 4);

// Distant mountains: pen1 #0000FF pure blue peaks over a solid #0097AE teal
// body/fill. Rolling hills: pen1 #009700 mid-green ridge over a solid #00DE51
// bright-green fill. Both VERIFIED from the bg_pal PROM (mpc-3.1m) and
// measured in modern-MAME captures — brief §3.2 / §6.1.
export const MOUNTAIN_FAR_PALETTE = { e: '#0000FF', m: '#0097AE' };
export const MOUNTAIN_NEAR_PALETTE = { e: '#009700', m: '#00DE51' };

// --- city ruins (M52 bg2 / GFX5) -----------------------------------------
//
// The OTHER mid-ground layer. The arcade never re-hues a background — the
// bg_pal PROM holds exactly one colour triple per layer — what it alternates
// is *which* mid-ground image the background-control port lets through:
// rolling hills (bg1) or city ruins (bg2), with the distant mountains always
// on. See .superpowers/notes/authenticity-research.md §7 finding 3, and
// STAGE_PALETTES in render.js for the alternation rule.
//
// Colours are the city layer's own three pens, VERIFIED from `mpc-3.1m` and
// measured in a modern-MAME capture of a city section (brief §3.2 / §6.1):
// pen1 #000000, pen2 #FFDE51 pale yellow, pen3 #00DE51 green, with a solid
// #00DE51 fill below the image. Nothing else may appear in this strip.
export const CITY_PALETTE = {
  m: '#00DE51', // pen3 — building mass and the solid fill below the skyline
  y: '#FFDE51', // pen2 — lit cornice/rim tracing the whole silhouette
  k: '#000000', // pen1 — window slots, arch openings, blown-out gaps
};

// 256px wide because that is the hardware's real wrap: each background layer
// is one 256x128 image drawn twice and repeating every 256px (brief §8.3).
// It is also simply less repetitive than the 96px ridge strips — a skyline
// has recognisable landmarks in a way a jagged ridge does not, so a short
// tile reads as an obvious loop.
const CITY_W = 256;
// Same height as MOUNTAIN_NEAR_MAP so the city occupies exactly the band the
// hills vacate, drawn at the same GROUND_Y - height and the same P_NEAR
// parallax rate — it is a swap, not a new layer.
const CITY_H = 40;
// Rows of solid pen-3 mass along the bottom. The skyline rises out of this
// rather than standing on bare sky, which is what the hardware's below-image
// fill does for every layer.
const CITY_BASE = 10;

/**
 * The skyline, as structures rather than hand-typed rows. `h` is height above
 * the base line; `x`/`w` are columns. Deliberately laid out so nothing
 * touches column 0 or column CITY_W-1 — the strip is tiled, and a building
 * straddling the seam would be sliced in half at every repeat.
 */
const CITY_BUILDINGS = [
  { x: 6, w: 15, h: 17, kind: 'tower' },
  { x: 26, w: 23, h: 25, kind: 'dome', gash: { dx: 15, w: 2, h: 11 } },
  { x: 53, w: 11, h: 11, kind: 'stub' },
  { x: 68, w: 21, h: 22, kind: 'stepped' },
  { x: 93, w: 5, h: 19, kind: 'column' },
  { x: 101, w: 5, h: 13, kind: 'column' },
  { x: 112, w: 27, h: 24, kind: 'arch', gash: { dx: 4, w: 2, h: 14 } },
  { x: 145, w: 13, h: 28, kind: 'tower' },
  { x: 163, w: 19, h: 18, kind: 'dome' },
  { x: 188, w: 25, h: 15, kind: 'stepped', gash: { dx: 8, w: 3, h: 8 } },
  { x: 218, w: 15, h: 23, kind: 'tower' },
  { x: 238, w: 12, h: 10, kind: 'stub' },
];

// Jagged descent, in rows below the parapet, for a tower's collapsed side.
// Deliberately NOT monotonic: a smooth 2px-per-column ramp reads as a pitched
// roof, which is the opposite of the intended silhouette. The trend descends,
// the steps do not.
// Steps of 1-3 rows: big jumps leave 1px-wide spikes that read as antennae
// rather than as a broken wall.
const TOWER_BREAK = [1, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13];

/**
 * Column heights (above the base line) for one structure. Every profile is a
 * pure function of the structure's own w/h — no randomness anywhere, so the
 * strip is byte-identical every boot and in every test run.
 */
function cityProfile(b) {
  const { w, h, kind } = b;
  const prof = new Array(w).fill(h);

  if (kind === 'tower') {
    // Sheared off on the right — the classic ruined high-rise. The break is
    // jagged (TOWER_BREAK) rather than a constant slope: a smooth ramp reads
    // as a pitched roof, which is the opposite of the intended silhouette.
    const brk = Math.floor(w * 0.55);
    const floorH = Math.max(3, Math.round(h * 0.45));
    for (let i = brk; i < w; i++) {
      prof[i] = Math.max(floorH, h - TOWER_BREAK[(i - brk) % TOWER_BREAK.length]);
    }
  } else if (kind === 'dome') {
    // A drum with a hemispherical cap: the domed structures the city section
    // is remembered for.
    const r = w / 2;
    const drum = Math.max(3, h - Math.round(r));
    for (let i = 0; i < w; i++) {
      const dx = i - (r - 0.5);
      prof[i] = drum + Math.round(Math.sqrt(Math.max(0, r * r - dx * dx)));
    }
  } else if (kind === 'stepped') {
    // Partially collapsed slab: three plateaus stepping down to the right.
    for (let i = 0; i < w; i++) {
      if (i >= Math.round(w * 0.75)) prof[i] = Math.max(3, h - 9);
      else if (i >= Math.round(w * 0.45)) prof[i] = Math.max(3, h - 5);
    }
  } else if (kind === 'column') {
    prof[w - 1] = Math.max(3, h - 2); // snapped top edge
  } else if (kind === 'stub') {
    for (let i = w - 3; i < w; i++) prof[i] = Math.max(2, h - 2);
  }
  // 'arch' keeps the flat full-height profile; its opening is carved below.
  return prof;
}

/**
 * Builds the tileable city strip. Structure mirrors ridgeMap's: a filled mass
 * with a distinct rim pen, not a thin outlined silhouette, because that is
 * what the hardware's 2bpp-image-plus-below-fill actually produces.
 *
 * ORIGINAL PIXEL ART. No ROM bitmap was transcribed — this is a skyline drawn
 * from the reference's description (domed ruins in green with a pale-yellow
 * highlight) using this project's code-generated-art rule.
 */
function cityMap(width, height, base) {
  const baseTop = height - base;
  const g = Array.from({ length: height }, () => new Array(width).fill('.'));
  for (let y = baseTop; y < height; y++) {
    for (let x = 0; x < width; x++) g[y][x] = 'm';
  }

  for (const b of CITY_BUILDINGS) {
    const prof = cityProfile(b);
    for (let i = 0; i < b.w; i++) {
      const h = prof[i];
      if (h <= 0) continue;
      const x = b.x + i;
      const top = baseTop - h;
      for (let y = top; y < baseTop; y++) g[y][x] = 'm';
      g[top][x] = 'y'; // lit rim traces the whole silhouette, curves included
    }

    // Window slots: 1px wide, 2px tall, on a 4px grid inset from the walls.
    // Guarded on the pixel already being mass, so the grid never punches a
    // hole through a dome's curved edge or over the rim pen.
    for (let wy = baseTop - 4; wy > baseTop - b.h + 2; wy -= 4) {
      for (let wx = 2; wx < b.w - 2; wx += 4) {
        const x = b.x + wx;
        if (g[wy][x] === 'm' && g[wy - 1][x] === 'm') {
          g[wy][x] = 'k';
          g[wy - 1][x] = 'k';
        }
      }
    }

    // A gash: a narrow blown-open shaft punched down from the parapet. This
    // is what separates "ruins" from "skyline" — without a hole through the
    // silhouette, tidy window grids on intact blocks read as a living city.
    if (b.gash) {
      for (let dx = 0; dx < b.gash.w; dx++) {
        const x = b.x + b.gash.dx + dx;
        let top = -1;
        for (let y = 0; y < baseTop; y++) {
          if (g[y][x] !== '.') { top = y; break; }
        }
        if (top < 0) continue;
        for (let y = top; y < Math.min(baseTop, top + b.gash.h); y++) g[y][x] = 'k';
      }
    }

    if (b.kind === 'arch') {
      // A round-headed opening standing on the rubble line: the one silhouette
      // hole big enough to read as "ruin" rather than "window".
      const aw = 7;
      const ah = 9;
      const ax = b.x + Math.round((b.w - aw) / 2);
      const r = (aw - 1) / 2;
      for (let dy = 0; dy < ah; dy++) {
        const y = baseTop - 1 - dy;
        for (let dx = 0; dx < aw; dx++) {
          const cap = dy > ah - 1 - r
            ? Math.sqrt(Math.max(0, r * r - (dy - (ah - 1 - r)) ** 2))
            : r;
          if (Math.abs(dx - r) <= cap && g[y][ax + dx] !== '.') g[y][ax + dx] = 'k';
        }
      }
    }
  }

  return g.map((row) => row.join(''));
}

export const CITY_MAP = cityMap(CITY_W, CITY_H, CITY_BASE);

// --- shared palettes -----------------------------------------------------
//
// SPRITE GAMUT. Everything drawn as a sprite (buggy, wheels, rocks, UFOs,
// explosions, bombs, capsules, bosses) is limited to the 15 colours of the
// M52's sprite palette PROM `mpc-1.1f`. That DAC carries a 470-ohm pulldown on
// every channel, so a sprite physically tops out at #C1C8C8 (~76% amplitude)
// and can NEVER be #FFFFFF — only the tile layer (HUD text, the up-shot beam)
// reaches full white. Keeping sprites below the tile layer's brightness is
// what makes the HUD read as a lit panel and the sprites as objects in the
// world. See .superpowers/notes/authenticity-research.md §2.3, §3.1.
const SPRITE_WHITE = '#C1C8C8';

// Sprite colour set 0 — VERIFIED against a modern-MAME capture (brief §4,
// §6.2). Transparent plus exactly three colours: the chassis, forward barrel
// and vertical mast are ALL the one magenta. The original deliberately
// contrasts a red-violet buggy against the peach regolith; there is no white
// driver, no blue canopy and no grey cannon.
const BUGGY_PAL = {
  o: '#00001A', // near black — outline, underside, axle stubs, barrel underside
  p: '#C100AE', // red-violet — chassis, barrel and mast alike
  t: '#00AEC8', // turquoise — hull trim (same pen as the wheel hubs)
};

// Same set 0: near-black tyre, turquoise hub and spokes.
const WHEEL_PAL = {
  k: '#00001A', // tyre
  d: '#00001A', // inner disc
  r: '#00AEC8', // spokes
  w: '#00AEC8', // hub
};

// Sprite colour set 4 — VERIFIED (brief §4, §6.1). Exactly two colours.
const ROCK_PAL = {
  w: '#845100', // brown, lit face
  g: '#845100', // brown, mid
  d: '#3E3700', // dark tan, shadow face
  k: '#3E3700', // dark tan, outline
};

// Craters are notches in the tile-drawn ground showing the black sky through,
// with no rim highlight (brief §6.1 — INFERRED, no capture contains one).
const CRATER_PAL = { k: '#000000', s: '#000000' };

// Sprite colour set 7 — VERIFIED as the UFO (brief §4): #C1C800 yellow hull,
// #3E90C8 sky-blue dome, #C10000 light-red legs/lights.
const UFO_PAL = { c: '#3E90C8', w: '#3E90C8', m: '#C1C800', y: '#C10000', d: '#C10000' };
// The remake fields three saucer variants so swooper/aimer/bomber read apart
// at a glance; the arcade's set for the other two is unknown (the brief refuses
// to guess — §4). These use real, in-gamut colour sets 8 and D rather than an
// invented hue, so the whole cast stays inside the hardware palette.
const UFO_PAL_B = { c: '#00AEC8', w: '#00AEC8', m: '#C10000', y: '#005100', d: '#005100' };
const UFO_PAL_C = { c: '#C19000', w: '#C19000', m: '#84C800', y: '#C10000', d: '#C10000' };

// Sprite colour set 3 — VERIFIED as the explosion (brief §4).
const BOOM_PAL = { w: SPRITE_WHITE, o: '#C1C800', y: '#840000' };

// --- pixel maps ----------------------------------------------------------

export const SPRITES = {
  // 32x14 chassis. Rows 12-13 are the axle stubs the wheels sit over, so the
  // buggy composites to exactly BUGGY_W x BUGGY_H (32x20) with wheels at y+12.
  // Silhouette is unchanged from the original hand-drawn art (32px chassis,
  // three wheels on a ~10px pitch — both measured as correct against the
  // arcade in the brief §8.5); only the colour structure was redrawn, folding
  // the old white driver / blue canopy / grey cannon into one magenta mast and
  // barrel per sprite colour set 0.
  buggyBody: {
    palette: BUGGY_PAL,
    map: [
      '......oppo......................',
      '.....oppppo.....................',
      '....oppppppo....................',
      '...oppppppppo..ppppppppppppppppo',
      '..oppppppppppo.ooooooooooooooooo',
      '..opppppppppppppppppppppo.......',
      '..opppppppppppppppppppppppo.....',
      '..opppppppppppppppppppppppppo...',
      '..oppppppppppppppppppppppppppo..',
      '..optttppppppptttppppppptttppo..',
      '..oppppppppppppppppppppppppppo..',
      '..oooooooooooooooooooooooooooo..',
      '.....oo........oo........oo.....',
      '.....oo........oo........oo.....',
    ],
  },

  // 8x8, cross spokes.
  wheel0: {
    palette: WHEEL_PAL,
    map: [
      '..kkkk..',
      '.kkrrkk.',
      'kkddddkk',
      'krdwwdrk',
      'krdwwdrk',
      'kkddddkk',
      '.kkrrkk.',
      '..kkkk..',
    ],
  },
  // 8x8, spokes rotated 45 degrees.
  wheel1: {
    palette: WHEEL_PAL,
    map: [
      '..kkkk..',
      '.kkddkk.',
      'krddddrk',
      'kddwwddk',
      'kddwwddk',
      'krddddrk',
      '.kkddkk.',
      '..kkkk..',
    ],
  },

  crater: { palette: CRATER_PAL, map: craterMap(24, 16) },
  bigCrater: { palette: CRATER_PAL, map: craterMap(40, 22) },
  doubleCrater: { palette: CRATER_PAL, map: doubleCraterMap() },
  bombCrater: { palette: CRATER_PAL, map: craterMap(28, 16) },

  // 16x10 lumpy boulder, lit from upper-left.
  rock: {
    palette: ROCK_PAL,
    map: [
      '......kkkk......',
      '....kkwwwwkk....',
      '...kwwwwwwggk...',
      '..kwwwwwgggggk..',
      '.kwwwwgggggggdk.',
      '.kwwwggggggggdk.',
      'kwwggggggggddddk',
      'kwggggggdddddddk',
      'kggggdddddddddk.',
      'kkddddddddddddkk',
    ],
  },

  // 22x16 boulder.
  bigRock: {
    palette: ROCK_PAL,
    map: [
      '.........kkkk.........',
      '.......kkwwwwkk.......',
      '.....kkwwwwwwwwkk.....',
      '....kwwwwwwwwwwggk....',
      '...kwwwwwwwwwgggggk...',
      '..kwwwwwwwwgggggggk...',
      '..kwwwwwwggggggggggk..',
      '.kwwwwwggggggggggggk..',
      '.kwwwwggggggggggggdk..',
      'kwwwggggggggggggddddk.',
      'kwwgggggggggggddddddk.',
      'kwggggggggggdddddddddk',
      'kwgggggggggddddddddddk',
      'kgggggggggdddddddddddk',
      'kgggggdddddddddddddddk',
      'kkddddddddddddddddddkk',
    ],
  },

  // 12x12 spiked mine; two palettes give the warning blink.
  // Mine: colour set unknown (§4/§6.1 — the research brief could obtain no
  // capture containing a mine and explicitly refused to guess). Both blink
  // frames are built from real sprite-PROM entries, so they are in-gamut but
  // NOT attributed.
  mine0: {
    palette: { k: '#3E3700', d: '#845100', r: '#C10000' },
    map: [
      '.....dd.....',
      '.d...dd...d.',
      '..kkkkkkkk..',
      '.dkkrrkkkkd.',
      'dkkkrrkkkkkd',
      'dkkkkkkkkkkd',
      'dkkkkkkkkkkd',
      '.dkkkkkkkkd.',
      '..kkkkkkkk..',
      '.d..kkkk..d.',
      '.d...dd...d.',
      '.....dd.....',
    ],
  },
  mine1: {
    palette: { k: '#845100', d: '#C1C8C8', r: '#C1C800' },
    map: [
      '.....dd.....',
      '.d...dd...d.',
      '..kkkkkkkk..',
      '.dkkrrkkkkd.',
      'dkkkrrkkkkkd',
      'dkkkkkkkkkkd',
      'dkkkkkkkkkkd',
      '.dkkkkkkkkd.',
      '..kkkkkkkk..',
      '.d..kkkk..d.',
      '.d...dd...d.',
      '.....dd.....',
    ],
  },

  shotFwd: {
    palette: { w: SPRITE_WHITE, c: '#3E90C8' },
    map: ['cwww', 'cwww'],
  },
  // The ONE sprite-sheet entry that keeps pure #FFFFFF: the arcade draws the
  // player's up-shot in the TILE layer, not as a sprite, so it is genuinely
  // brighter than anything else moving on screen (brief §6.2, VERIFIED — the
  // capture's beam pixels are #FFFFFF and #C1C8C8 is absent).
  shotUp: {
    palette: { w: '#FFFFFF', c: '#00B8FF' },
    map: ['ww', 'ww', 'ww', 'cc', 'cc'],
  },

  // 16x8 domed saucer.
  ufoA: {
    palette: UFO_PAL,
    map: [
      '......dccd......',
      '.....dccccd.....',
      '....dccwwccd....',
      '..dmmmmmmmmmmd..',
      'dmmyymmyymmyymmd',
      'dmmmmmmmmmmmmmmd',
      '..dmmmmmmmmmmd..',
      '....dddddddd....',
    ],
  },
  // 16x8 flat saucer with landing struts.
  ufoB: {
    palette: UFO_PAL_B,
    map: [
      '......cccc......',
      '.....dccccd.....',
      '..ddmmmmmmmmdd..',
      'dmmmmyymmyymmmmd',
      'dmmmmmmmmmmmmmmd',
      '..ddmmmmmmmmdd..',
      '....dd....dd....',
      '...dd......dd...',
    ],
  },
  // 14x10 tall saucer with antenna.
  ufoC: {
    palette: UFO_PAL_C,
    map: [
      '......dd......',
      '......cc......',
      '.....dccd.....',
      '....dccccd....',
      '...dccwwccd...',
      '.dmmmmmmmmmmd.',
      'dmyymmyymmyymd',
      'dmmmmmmmmmmmmd',
      '.dmmmmmmmmmmd.',
      '...dddddddd...',
    ],
  },

  // 20x14 tracked ground turret, barrel raised forward.
  tank: {
    // Colour set unknown — no capture the brief could obtain contains a tank
    // (§4). In-gamut sprite colours chosen rather than a guessed set.
    palette: { m: '#3E90C8', d: '#00001A', t: '#00001A', w: '#00AEC8', g: '#C1C8C8' },
    map: [
      '................gg..',
      '..............gg....',
      '............gg......',
      '...ddddd..gg........',
      '..dmmmmmdgg.........',
      '..dmmmmmmd..........',
      '.dmmmmmmmmddddddddd.',
      'dmmmmmmmmmmmmmmmmmmd',
      'dmmmmmmmmmmmmmmmmmmd',
      'dddddddddddddddddddd',
      'dtttttttttttttttttdd',
      'dtwtwtwtwtwtwtwtwttd',
      'dtttttttttttttttttdd',
      '.dddddddddddddddddd.',
    ],
  },

  // 14x10 hovering rear-attack drone.
  chaser: {
    // Chase car: colour set unknown (§4). In-gamut set-9-style trio.
    palette: { r: '#C10000', w: '#C1C800', d: '#840000' },
    map: [
      '....dddddd....',
      '..ddrrrrrrdd..',
      '.drrrrrrrrrrd.',
      'drrrwwwwwwrrrd',
      'drrrwwwwwwrrrd',
      '.drrrrrrrrrrd.',
      '..ddrrrrrrdd..',
      '....dd..dd....',
      '...dd....dd...',
      '..dd......dd..',
    ],
  },

  // 8x10 dropped bomb with orange fins.
  bomb: {
    // Bomb: colour set unknown (§4). In-gamut.
    palette: { w: '#845100', h: SPRITE_WHITE, d: '#C19000' },
    map: [
      '...hw...',
      '..hwww..',
      '.hwwwww.',
      '.hwwwww.',
      '.hwwwww.',
      '.hwwwww.',
      '..wwww..',
      '.d.ww.d.',
      'dd.ww.dd',
      'd..ww..d',
    ],
  },

  // 12x10 power-up capsule.
  capsule: {
    // Power-up capsule is a mod-layer addition with no arcade counterpart;
    // kept in the sprite gamut so it sits in the same colour world.
    palette: { c: SPRITE_WHITE, w: '#00AEC8', y: '#3E90C8', d: '#00001A' },
    map: [
      '...cccccc...',
      '..cwwwwwwc..',
      '.cwyyyyyywc.',
      'cwyyyyyyyywc',
      'cwyyyyyyyywc',
      'cwyyyyyyyywc',
      '.cwyyyyyywc.',
      '..cwwwwwwc..',
      '...cccccc...',
      '....dddd....',
    ],
  },

  // 48x15 mothership.
  boss1: {
    // Mothership is a mod-layer addition (the arcade has no boss); kept in the
    // sprite gamut. Cool blues/turquoise for the regular boss.
    palette: { c: '#3E90C8', w: SPRITE_WHITE, m: '#00AEC8', d: '#00001A', y: '#C1C800', k: '#00001A', r: '#C10000' },
    map: [
      '..................cccccccccccc..................',
      '...............dcccwwwwwwwwwwcccd...............',
      '............dccccwwwwwwwwwwwwwwccccd............',
      '.........ddmmmmccccwwwwwwwwwwccccmmmmdd.........',
      '....ddmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmdd....',
      '.ddmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmdd.',
      'dmyymmyymmyymmyymmyymmyymmyymmyymmyymmyymmyymmyd',
      'dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd',
      '.dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd.',
      '....dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd....',
      '........dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd........',
      '............dkkkkkkkkkkkkkkkkkkkkkkd............',
      '................drrrrrrrrrrrrrrd................',
      '....................drrrrrrd....................',
      '......................drrd......................',
    ],
  },

  // 48x15 mothership — final-boss (Z) recolor of boss1, same silhouette so
  // it reads instantly as "the same kind of thing, but meaner": cool
  // cyan/white swapped for hot red/gold, signaling the two-phase finale.
  boss2: {
    palette: { c: '#C10000', w: '#C1C800', m: '#840000', d: '#00001A', y: '#C19000', k: '#00001A', r: '#C10000' },
    map: [
      '..................cccccccccccc..................',
      '...............dcccwwwwwwwwwwcccd...............',
      '............dccccwwwwwwwwwwwwwwccccd............',
      '.........ddmmmmccccwwwwwwwwwwccccmmmmdd.........',
      '....ddmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmdd....',
      '.ddmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmdd.',
      'dmyymmyymmyymmyymmyymmyymmyymmyymmyymmyymmyymmyd',
      'dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd',
      '.dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd.',
      '....dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd....',
      '........dmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmd........',
      '............dkkkkkkkkkkkkkkkkkkkkkkd............',
      '................drrrrrrrrrrrrrrd................',
      '....................drrrrrrd....................',
      '......................drrd......................',
    ],
  },

  // Explosions are authored at half resolution and rasterized 2x so the
  // debris reads as chunky arcade blocks rather than fine noise.
  explosion0: {
    scale: 2,
    palette: BOOM_PAL,
    map: [
      '....yyyy....',
      '..yyoooyyy..',
      '.yyooowwooy.',
      'yyoowwwwwooy',
      'yoowwwwwwooy',
      'yoowwwwwwooy',
      'yoowwwwwwooy',
      'yyoowwwwooyy',
      'yyooowwoooyy',
      '.yyooooooyy.',
      '..yyoooyyy..',
      '....yyyy....',
    ],
  },
  explosion1: {
    scale: 2,
    palette: BOOM_PAL,
    map: [
      '....yyyy....',
      '..yyooooyy..',
      '.yoowwwwooy.',
      'yoow....wooy',
      'yow......woy',
      'yow......woy',
      'yow......woy',
      'yow......woy',
      'yoow....wooy',
      '.yoowwwwooy.',
      '..yyooooyy..',
      '....yyyy....',
    ],
  },
  explosion2: {
    scale: 2,
    palette: BOOM_PAL,
    map: [
      '...yy..yy...',
      '.y.o.....o.y',
      'y....oo....y',
      '..o......o..',
      'y..........y',
      '.o........o.',
      '.o........o.',
      'y..........y',
      '..o......o..',
      'y....oo....y',
      '.y.o.....o.y',
      '...yy..yy...',
    ],
  },

  // 16x16 Earth hanging in the starfield. The arcade sky is empty black — the
  // starfield and Earth are this remake's ONE deliberate visual addition (see
  // brief §6.1 / rank 5, and BUILD-LOG). Recoloured into the sprite gamut so
  // the deviation is a shape choice, not a palette one.
  earth: {
    palette: { b: '#3E90C8', l: '#00AEC8', g: '#00C800', w: SPRITE_WHITE, d: '#00001A' },
    map: [
      '.....dbbbbd.....',
      '...dbblllbbbd...',
      '..dbllllllbbbd..',
      '.dblllggbllbbbd.',
      '.blllgggglbbbbd.',
      'dbllggglllbbbbbd',
      'dblllggbbbwbbbbd',
      'dbllbbbbbwwbbbbd',
      'dbbbbbggbbbbbbbd',
      'dbbbbgggbbbbbbbd',
      'dbbbbggbbbbbbbbd',
      '.dbbbbbbbbbbbbd.',
      '.dbbbbbbwwbbbbd.',
      '..dbbbbbbbbbbd..',
      '...dbbbbbbbbd...',
      '.....dbbbbd.....',
    ],
  },

  mountainFar: { palette: MOUNTAIN_FAR_PALETTE, map: MOUNTAIN_FAR_MAP },
  mountainNear: { palette: MOUNTAIN_NEAR_PALETTE, map: MOUNTAIN_NEAR_MAP },
  cityRuins: { palette: CITY_PALETTE, map: CITY_MAP },
};

// --- rasterization -------------------------------------------------------

function parseHex(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Validates a pixel map: rectangular, and every non-'.' character present in
 * the palette. Throws with a precise location so a typo in a hand-drawn map
 * fails loudly at boot instead of rendering as a hole.
 */
export function validateMap(name, map, palette) {
  if (!Array.isArray(map) || map.length === 0) throw new Error(`sprite ${name}: empty map`);
  const w = map[0].length;
  for (let y = 0; y < map.length; y++) {
    if (map[y].length !== w) {
      throw new Error(`sprite ${name}: row ${y} is ${map[y].length}px, expected ${w}px`);
    }
    for (let x = 0; x < w; x++) {
      const c = map[y][x];
      if (c !== '.' && !(c in palette)) {
        throw new Error(`sprite ${name}: unknown char '${c}' at ${x},${y}`);
      }
    }
  }
  return { w, h: map.length };
}

/**
 * @returns {HTMLCanvasElement} an opaque-where-drawn canvas of the pixel map.
 */
export function rasterize(map, palette, scale = 1, name = 'sprite') {
  const { w, h } = validateMap(name, map, palette);
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const img = ctx.createImageData(canvas.width, canvas.height);
  const rgb = {};
  for (const key of Object.keys(palette)) rgb[key] = parseHex(palette[key]);

  for (let y = 0; y < canvas.height; y++) {
    const srcRow = map[Math.floor(y / scale)];
    for (let x = 0; x < canvas.width; x++) {
      const c = srcRow[Math.floor(x / scale)];
      if (c === '.') continue;
      const [r, g, b] = rgb[c];
      const i = (y * canvas.width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @returns {Object<string, HTMLCanvasElement>} name -> rasterized canvas. */
export function buildSprites() {
  const out = {};
  for (const [name, def] of Object.entries(SPRITES)) {
    out[name] = rasterize(def.map, def.palette, def.scale || 1, name);
  }
  return out;
}
