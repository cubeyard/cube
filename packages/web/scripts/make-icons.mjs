/**
 * Generates the shipping PWA rasters in ../public from the cube glyph:
 * signal-orange stroke (#cc3f00) on the putty enclosure (#ece8df), the
 * bench-instrument identity (seed 1a30da04). Maskable uses the smaller
 * glyph for the Android safe zone.
 *
 * Needs a playwright install reachable from the CURRENT directory (not a
 * package dependency — this is a design-time tool, not a build step): run
 * it from any directory whose node_modules holds playwright.
 *
 *   node <repo>/packages/web/scripts/make-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(path.join(process.cwd(), "noop.js"))("playwright");

const OUT = path.resolve(import.meta.dirname, "../public");

const html = (size, frac) => {
  const g = Math.round(size * frac);
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:#ece8df;display:grid;place-items:center">
  <svg width="${g}" height="${g}" viewBox="0 0 24 24" fill="none" stroke="#cc3f00" stroke-width="2" stroke-linejoin="round">
    <path d="M12 2 21 7 V17 L12 22 3 17 V7 Z"/><path d="M3 7 L12 12 21 7 M12 12 V22"/>
  </svg></body></html>`;
};

const JOBS = [
  ["icon-192.png", 192, 0.56],
  ["icon-512.png", 512, 0.56],
  ["icon-maskable-512.png", 512, 0.44],
  ["apple-touch-icon.png", 180, 0.56],
];

const browser = await chromium.launch();
for (const [name, size, frac] of JOBS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html(size, frac));
  await page.screenshot({ path: path.join(OUT, name) });
  await page.close();
}
await browser.close();

fs.writeFileSync(
  path.join(OUT, "icons.provenance.json"),
  JSON.stringify(
    {
      generator: "packages/web/scripts/make-icons.mjs",
      identity: "bench instrument (seed 1a30da04)",
      source: "cube wireframe glyph, stroke #cc3f00 on enclosure #ece8df",
      files: JOBS.map(([name]) => name),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log("icons + provenance written to", OUT);
