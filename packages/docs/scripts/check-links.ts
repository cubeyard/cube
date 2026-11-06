// Checks every link in the built site (dist/): a link inside the site must
// reach a built page or file, and its #fragment an id on that page; a link
// into the repository (`gh:` in the source) must name a file or directory
// that exists in this checkout. External links are not fetched.
import fs from "node:fs";
import path from "node:path";

const docs = path.resolve(import.meta.dirname, "..");
const root = path.resolve(docs, "../..");
const dist = path.join(docs, "dist");
const base = "/cube/";
const repository = /^https:\/\/github\.com\/cubeyard\/cube\/(?:blob|tree|edit)\/[^/]+\/([^#?]*)/;

const pages = fs.readdirSync(dist, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".html"));
const ids = new Map<string, Set<string>>();
const html = new Map<string, string>();
for (const page of pages) {
  const text = fs.readFileSync(path.join(dist, page), "utf8");
  html.set(page, text);
  ids.set(page, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)));
}

function target(pathname: string): string | null {
  const relative = decodeURIComponent(pathname.slice(base.length));
  for (const candidate of [relative, path.join(relative, "index.html")]) {
    const file = path.join(dist, candidate);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return candidate;
  }
  return null;
}

const problems: string[] = [];
let checked = 0;
for (const [page, text] of html) {
  if (page === "404.html") continue;
  for (const [, href] of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const link = href!.replaceAll("&amp;", "&");
    if (link.startsWith("gh:")) {
      problems.push(`${page}: ${link} was not rewritten`);
      continue;
    }
    const inRepository = repository.exec(link);
    if (inRepository) {
      checked++;
      if (link.includes("/edit/")) continue;
      if (!fs.existsSync(path.join(root, decodeURIComponent(inRepository[1]!)))) problems.push(`${page}: ${link} names no file in the repository`);
      const anchor = link.split("#")[1];
      if (anchor && inRepository[1]!.endsWith(".md")) {
        const heading = fs.readFileSync(path.join(root, inRepository[1]!), "utf8").split("\n").filter(line => /^#+ /.test(line))
          .map(line => line.replace(/^#+ /, "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-"));
        if (!heading.includes(anchor)) problems.push(`${page}: ${link} names no heading in ${inRepository[1]}`);
      }
      continue;
    }
    if (/^(?:[a-z]+:|\/\/)/i.test(link)) continue;
    const [pathname, fragment] = link.split("#") as [string, string | undefined];
    const here = "/" + path.posix.join(base.slice(1), path.posix.dirname(page.split(path.sep).join("/")), "/");
    const absolute = pathname === "" ? "/" + path.posix.join(base.slice(1), page) : new URL(pathname, `http://site${here}`).pathname;
    checked++;
    if (!absolute.startsWith(base)) {
      problems.push(`${page}: ${link} leaves the site's base ${base}`);
      continue;
    }
    const file = target(absolute);
    if (!file) {
      problems.push(`${page}: ${link} reaches no built page`);
      continue;
    }
    if (fragment && file.endsWith(".html") && !ids.get(file)?.has(decodeURIComponent(fragment))) problems.push(`${page}: ${link} names no id on ${file}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`check-links: ${problems.length} broken of ${checked} links`);
  process.exit(1);
}
console.log(`check-links: ${checked} links in ${pages.length} pages, none broken`);
