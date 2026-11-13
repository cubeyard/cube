/** Screenshots of the prototype for a look: node shots.ts URL OUT [route...]
 * at desktop (1440x900) and phone (390x844) sizes. */
import path from "node:path";
const { chromium } = await import(path.resolve(import.meta.dirname, "../../web/node_modules/playwright/index.mjs")) as typeof import("../../web/node_modules/playwright");
const [url, out, ...routes] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  const page = await browser.newPage({ viewport });
  page.on("console", message => { if (message.type() === "error") console.log(`console error: ${message.text()}`); });
  page.on("pageerror", error => console.log(`page error: ${error.message}`));
  for (const route of routes.length ? routes : ["/"]) {
    await page.goto(`${url}/#${route}`);
    await page.waitForTimeout(2500);
    const file = path.join(out!, `${name}${route.replace(/\//g, "-")}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await page.close();
}
await browser.close();
