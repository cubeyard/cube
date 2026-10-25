/** The thinking cube's frames: the dots are the cube's surface, every frame
 * of every state stays inside its box (turned on a corner, mid quarter
 * turn, as a loose cloud), the same time gives the same frame (one clock
 * for every cube; the reduced-motion frame is one of them) and a working
 * cube's layer clicks back into the lattice after its quarter turn. */
import assert from "node:assert/strict";
import { frame, lattice, type CubeState } from "../src/lib/thinking-cube.ts";

assert.equal(lattice(4).length, 4 ** 3 - 2 ** 3, "the surface of a 4×4×4 cube");
assert.equal(lattice(6).length, 6 ** 3 - 4 ** 3, "the surface of a 6×6×6 cube");
assert.ok(lattice(4).every(point => point.some(value => Math.abs(value) === 1)), "every dot on a face");
console.log("ok: the lattice is the cube's surface");

for (const size of [20, 64]) {
  const points = lattice(size >= 40 ? 6 : 4);
  for (const state of ["working", "starting", "waiting"] as CubeState[]) {
    for (let time = 0; time < 12_000; time += 37) {
      for (const dot of frame(state, time, size, points)) {
        assert.ok(dot.x - dot.size / 2 >= 0 && dot.x + dot.size / 2 <= size && dot.y - dot.size / 2 >= 0 && dot.y + dot.size / 2 <= size,
          `${state} at ${time} ms in ${size}px: a dot at ${dot.x.toFixed(1)},${dot.y.toFixed(1)} leaves the box`);
        assert.ok(dot.alpha > 0 && dot.alpha <= 1, `${state} at ${time} ms: alpha ${dot.alpha}`);
      }
    }
    assert.deepEqual(frame(state, 4321, size, points), frame(state, 4321, size, points), "the same time, the same frame");
  }
}
console.log("ok: every frame of every state stays in its box, the same for the same time");

// After a quarter turn (55% of the 1.5 s cycle) the turned layer is back on
// the lattice: the frame equals the frame of a cube that never turned
// there, at the same yaw.
const points = lattice(4);
const key = (dots: ReturnType<typeof frame>) => dots.map(dot => `${dot.x.toFixed(3)},${dot.y.toFixed(3)}`).sort().join(" ");
assert.equal(key(frame("working", 1500 * 7 + 1400, 20, points)), key(frame("waiting", 1500 * 7 + 1400, 20, points)),
  "the turned layer clicks back into place");
console.log("ok: a quarter turn clicks back into the lattice");
