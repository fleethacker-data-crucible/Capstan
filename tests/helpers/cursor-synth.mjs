// Synthetic cursor data for TESTS ONLY. Nothing in src/ imports this: the product never invents cursor
// data. Deterministic scripted paths so tests can check exact positions, times and clicks.

/** @typedef {{ samples: {t:number,x:number,y:number}[], clicks: {t:number,button:'left'|'right'|'middle',down:boolean}[], keys: {t:number,key:string,down:boolean}[] }} Data */

const lerp = (a, b, u) => a + (b - a) * u;

/** Samples of a path made of [t, x, y] waypoints joined by straight lines, at `hz`. */
export function path(waypoints, seconds, hz = 30) {
  const samples = [];
  for (let i = 0; i <= Math.round(seconds * hz); i++) {
    const t = i / hz;
    let x = waypoints[0][1];
    let y = waypoints[0][2];
    for (let k = 1; k < waypoints.length; k++) {
      const [t0, x0, y0] = waypoints[k - 1];
      const [t1, x1, y1] = waypoints[k];
      if (t >= t1) {
        x = x1;
        y = y1;
      } else if (t >= t0) {
        const u = (t - t0) / (t1 - t0);
        x = lerp(x0, x1, u);
        y = lerp(y0, y1, u);
        break;
      }
    }
    samples.push({ t: Math.round(t * 1e4) / 1e4, x, y });
  }
  return samples;
}

/**
 * Three seconds for the 3.008 s fixture clip. The cursor rests at (0.25, 0.30), glides to
 * (0.70, 0.60) between 1.0 s and 1.5 s and rests there.
 * Left press 0.5 s (at 0.25, 0.30); left press 2.0 s and right press 2.2 s (at 0.70, 0.60).
 * Ctrl+C at 2.4 s; "hi" typed at 2.7 s and 2.8 s.
 * @returns {Data}
 */
export function shortCursor() {
  return {
    samples: path([[0, 0.25, 0.3], [1, 0.25, 0.3], [1.5, 0.7, 0.6], [3, 0.7, 0.6]], 3),
    clicks: [
      { t: 0.5, button: 'left', down: true },
      { t: 0.58, button: 'left', down: false },
      { t: 2.0, button: 'left', down: true },
      { t: 2.08, button: 'left', down: false },
      { t: 2.2, button: 'right', down: true },
      { t: 2.28, button: 'right', down: false },
    ],
    keys: [
      { t: 2.4, key: 'Control', down: true },
      { t: 2.45, key: 'c', down: true },
      { t: 2.5, key: 'c', down: false },
      { t: 2.55, key: 'Control', down: false },
      { t: 2.7, key: 'h', down: true },
      { t: 2.75, key: 'h', down: false },
      { t: 2.8, key: 'i', down: true },
      { t: 2.85, key: 'i', down: false },
    ],
  };
}

/**
 * Twelve seconds for smart focus: a rest at A (0.20, 0.25) for 2 s, a click pair at B (0.75, 0.70)
 * at 3.2 s and 3.9 s, a rest of 2.5 s at C (0.30, 0.75) from 5.0 s with no clicks, a click pair at
 * D (0.80, 0.20) at 9.0 s and 9.5 s.
 * @returns {Data}
 */
export function longCursor() {
  const press = (t, button = 'left') => [
    { t, button, down: true },
    { t: t + 0.08, button, down: false },
  ];
  return {
    samples: path(
      [[0, 0.2, 0.25], [2, 0.2, 0.25], [3, 0.75, 0.7], [4, 0.75, 0.7], [5, 0.3, 0.75], [7.5, 0.3, 0.75], [8.5, 0.8, 0.2], [12, 0.8, 0.2]],
      12,
    ),
    clicks: [...press(3.2), ...press(3.9), ...press(9.0), ...press(9.5)],
    keys: [],
  };
}

/** Deterministic hand jitter added to a sample list (for smoothing tests). */
export function jitter(samples, amount) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  return samples.map((s) => ({ t: s.t, x: s.x + rnd() * amount, y: s.y + rnd() * amount }));
}
