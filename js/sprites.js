// sprites.js — every graphic in the game as pixel data in code. No image
// assets. Each sprite is a `{ map, palette, scale? }` definition where `map`
// is an array of equal-length strings, '.' means transparent, and every other
// character indexes that sprite's own palette (a `{char: '#rrggbb'}` object).
//
// `buildSprites()` rasterizes them all to offscreen canvases at boot. The raw
// definitions stay exported so pure-Node tooling can validate them without a
// DOM, and so render.js can re-rasterize the mountain strips with per-stage
// palettes (see STAGE_PALETTES in render.js).
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
 * Horizontally tileable jagged ridge. `points` are peak heights sampled
 * evenly across the strip; index arithmetic wraps, so column `width-1`
 * interpolates back toward `points[0]` and the strip tiles seamlessly.
 * 'w' = snow cap (tall columns only), 'e' = lit top edge, 'm' = body,
 * 's' = shaded base.
 */
function ridgeMap(width, height, points, capRatio) {
  const n = points.length;
  const cols = new Array(width);
  let maxH = 0;
  for (let x = 0; x < width; x++) {
    const t = (x / width) * n;
    const i = Math.floor(t);
    const f = t - i;
    const h = Math.round(points[i % n] + (points[(i + 1) % n] - points[i % n]) * f);
    cols[x] = h;
    if (h > maxH) maxH = h;
  }
  const capH = maxH * capRatio;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = height - cols[x];
      if (y < top) row += '.';
      else if (y === top) row += cols[x] >= capH ? 'w' : 'e';
      else if (y === top + 1 && cols[x] >= capH) row += 'w';
      else if (y >= height - 4) row += 's';
      else row += 'm';
    }
    rows.push(row);
  }
  return rows;
}

// The far range is the tall, broad, dark one with capped peaks; the near
// range is a shorter, chunkier, brighter row of foothills in front of it, so
// both layers stay legible while parallaxing past each other.
export const MOUNTAIN_FAR_MAP = ridgeMap(96, 56, [24, 40, 28, 52, 22, 44, 32, 38], 0.86);
export const MOUNTAIN_NEAR_MAP = ridgeMap(96, 26, [10, 24, 14, 19, 8, 21, 12, 17], 0.92);

export const MOUNTAIN_FAR_PALETTE = { e: '#2a7a3c', m: '#175226', s: '#0e3618', w: '#b8ecc6' };
export const MOUNTAIN_NEAR_PALETTE = { e: '#63d47a', m: '#33a44a', s: '#1d6b2e', w: '#ffffff' };

// --- shared palettes -----------------------------------------------------

const BUGGY_PAL = {
  o: '#3a0f26', // outline / underside
  p: '#e0509a', // body pink (matches the terrain strip)
  h: '#ff8fc8', // top highlight
  s: '#a02c66', // lower shade
  c: '#7fd8ff', // canopy glass
  w: '#ffffff', // helmet / suit
  g: '#c8c8d8', // cannon, lit
  d: '#606078', // cannon, shaded / axle
};

const WHEEL_PAL = {
  k: '#100609', // tire, near-black
  d: '#2a1420', // inner disc
  r: '#c86ea4', // rim spokes
  w: '#ffb8e0', // hub
};

const ROCK_PAL = {
  w: '#d0d0d0', // lit face
  g: '#8a8a8a', // mid
  d: '#585858', // shadow face
  k: '#242428', // outline
};

const CRATER_PAL = { k: '#180610', s: '#ff9ad0' };

const UFO_PAL = { c: '#60d0ff', w: '#ffffff', m: '#c0c8d8', y: '#ffd020', d: '#404858' };
const UFO_PAL_B = { c: '#8affd0', w: '#ffffff', m: '#3fb890', y: '#ffe850', d: '#1c5a48' };
const UFO_PAL_C = { c: '#ffb0f0', w: '#ffffff', m: '#a860d8', y: '#ff5060', d: '#3c1a60' };

const BOOM_PAL = { w: '#ffffff', o: '#ffc020', y: '#ff5000' };

// --- pixel maps ----------------------------------------------------------

export const SPRITES = {
  // 32x14 chassis. Rows 12-13 are the axle stubs the wheels sit over, so the
  // buggy composites to exactly BUGGY_W x BUGGY_H (32x20) with wheels at y+12.
  buggyBody: {
    palette: BUGGY_PAL,
    map: [
      '......owwo......................',
      '.....owwwwo.....................',
      '....ohwcccho....................',
      '...ohpcccccpho.ddddggggggggggg..',
      '..ohppcccccpphdddddddddddddddd..',
      '..ohhhhhhhhhhhhhhhhhhhhho.......',
      '..opppppppppppppppppppppppo.....',
      '..opppppppppppppppppppppppppo...',
      '..oppppppppppppppppppppppppppo..',
      '..oppppppppppppppppppppppppppo..',
      '..osssssssssssssssssssssssssso..',
      '..oooooooooooooooooooooooooooo..',
      '.....dd........dd........dd.....',
      '.....dd........dd........dd.....',
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

  // 10x14 stranded astronaut, arms raised.
  astronaut: {
    palette: { o: '#20202c', w: '#ffffff', c: '#7fd8ff' },
    map: [
      '...owwo...',
      '..owccwo..',
      '..owccwo..',
      '...owwo...',
      'ow..ww..wo',
      '.owwwwwwo.',
      '.owwccwwo.',
      '.owwccwwo.',
      '.owwwwwwo.',
      '..owwwwo..',
      '..owwwwo..',
      '..ow..wo..',
      '..ow..wo..',
      '.oww..wwo.',
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
  mine0: {
    palette: { k: '#3c3c4a', d: '#b0b0bc', r: '#ff4030' },
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
    palette: { k: '#54546a', d: '#e8e8f2', r: '#ffe060' },
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
    palette: { w: '#ffffff', c: '#a0e0ff' },
    map: ['cwww', 'cwww'],
  },
  shotUp: {
    palette: { w: '#ffffff', c: '#a0e0ff' },
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
    palette: { m: '#9aa2b0', d: '#3c424e', t: '#22262e', w: '#c8ced8', g: '#dfe4ec' },
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
    palette: { r: '#e04030', w: '#ffe060', d: '#601810' },
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
    palette: { w: '#d8d8e0', h: '#ffffff', d: '#f0a020' },
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
    palette: { c: '#ffffff', w: '#60e0ff', y: '#2060c0', d: '#103060' },
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
    palette: { c: '#7fd8ff', w: '#ffffff', m: '#b8c0d0', d: '#3a4050', y: '#ffd020', k: '#20242e', r: '#ff4030' },
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

  // 16x16 Earth hanging in the starfield.
  earth: {
    palette: { b: '#2a6ad8', l: '#4f9bff', g: '#2fa04a', w: '#dfe8ff', d: '#14306a' },
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
