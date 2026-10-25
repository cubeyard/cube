/** The thinking cube's geometry: a cube of square dots on a lattice, turned
 * and projected for one moment of one state. Pure, so a frame is the same
 * for the same time (every cube on the page shares one clock) and the
 * reduced-motion frame is simply one of them. ThinkingCube.svelte draws it.
 *
 * - `working`: the cube turns slowly while one layer at a time makes a
 *   quarter turn and clicks into place, as a puzzle cube does.
 * - `starting`: the dots gather from a loose cloud into the cube, hold,
 *   and let go (a machine being put together).
 * - `waiting`: the cube turns slowly and a soft band passes through it,
 *   layer by layer (nothing to do until a slot or a wake comes). */
export type CubeState = "working" | "starting" | "waiting";
export type Dot = { x: number; y: number; depth: number; size: number; alpha: number };

type Point = readonly [number, number, number];

/** The dots on the cube's surface: `n` per edge, in [-1, 1] on each axis. */
export function lattice(n: number): Point[] {
  const points: Point[] = [];
  const at = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * 2 - 1);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    if (i === 0 || j === 0 || k === 0 || i === n - 1 || j === n - 1 || k === n - 1) points.push([at(i), at(j), at(k)]);
  }
  return points;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** A fixed scatter per dot: the same cloud every cycle. */
const scatter = (index: number): Point => {
  const s = Math.sin(index * 12.9898) * 43758.5453;
  const u = s - Math.floor(s), v = (s * 1.7) - Math.floor(s * 1.7), w = (s * 2.3) - Math.floor(s * 2.3);
  return [u * 2 - 1, v * 2 - 1, w * 2 - 1];
};
function rotate([x, y, z]: Point, axis: 0 | 1 | 2, angle: number): Point {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 0) return [x, y * c - z * s, y * s + z * c];
  if (axis === 1) return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
}

const TURN_MS = 1500;
const BREATH_MS = 3200;
const GATHER_MS = 2600;

/** The dots of one frame at `time` (ms), in a box `size` CSS px wide,
 * sorted back to front. */
export function frame(state: CubeState, time: number, size: number, points: readonly Point[]): Dot[] {
  const yaw = time * 0.00035 + 0.6;
  const pitch = 0.5;
  // a quarter of the box per unit, so the cube turned on a corner still fits
  const span = size * 0.235;
  const dot = size >= 40 ? size / 44 : size / 17;
  let turning: { axis: 0 | 1 | 2; layer: number; angle: number } | null = null;
  if (state === "working") {
    // one layer per cycle: which axis and layer follows the cycle's number
    const cycle = Math.floor(time / TURN_MS);
    const phase = (time % TURN_MS) / TURN_MS;
    const axis = (cycle % 3) as 0 | 1 | 2;
    const layer = [-1, 1, 0][Math.floor(cycle / 3) % 3]!;
    turning = { axis, layer, angle: ease(clamp01(phase / 0.55)) * (Math.PI / 2) * (cycle % 2 ? -1 : 1) };
  }
  const gather = state === "starting" ? (time % GATHER_MS) / GATHER_MS : 0;
  // gather in, hold whole, then let go: 0 is the cube, 1 the cloud
  const loose = state !== "starting" ? 0 : gather < 0.5 ? 1 - ease(gather / 0.5) : gather < 0.8 ? 0 : ease((gather - 0.8) / 0.2);
  // a loose cloud stays inside the box: it reaches out as the cube draws in
  const reach = span / (1 + loose * 0.55);
  const band = state === "waiting" ? ((time % BREATH_MS) / BREATH_MS) * 4 - 2 : 0;
  const dots = points.map((point, index): Dot => {
    let p: Point = point;
    let lift = 0;
    if (turning) {
      // a third of the cube: an outer slab, or the middle one
      const coordinate = p[turning.axis];
      if (turning.layer === 0 ? Math.abs(coordinate) <= 0.34 : coordinate * turning.layer >= 0.32) {
        p = rotate(p, turning.axis, turning.angle);
        lift = Math.sin((Math.abs(turning.angle) / (Math.PI / 2)) * Math.PI) * 0.45;
      }
    }
    if (loose) {
      const cloud = scatter(index);
      p = [p[0] + cloud[0] * loose * 0.55, p[1] + cloud[1] * loose * 0.55, p[2] + cloud[2] * loose * 0.55];
    }
    if (state === "waiting") lift = Math.max(0, 1 - Math.abs(p[1] - band) * 1.6) * 0.5;
    p = rotate(rotate(p, 1, yaw), 0, pitch);
    const perspective = 9 / (9 + p[2]);
    const near = clamp01((1 - p[2]) / 2);
    return {
      x: size / 2 + p[0] * reach * perspective,
      y: size / 2 + p[1] * reach * perspective,
      depth: p[2],
      size: dot * (0.75 + near * 0.45),
      alpha: Math.min(1, (0.28 + near * 0.6 + lift) * (state === "starting" ? 1 - loose * 0.55 : 1)),
    };
  });
  return dots.sort((a, b) => b.depth - a.depth);
}
