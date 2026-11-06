import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { codeGlass } from "./src/code-glass.mjs";
import { docsRef, repository } from "./src/release.mjs";

// `gh:PATH` in a page links to PATH in the repository at the release the
// site is built from, so a page never points at code newer than it
// describes. Rewritten in the built HTML, whatever Markdown processor ran.
// Code in a table cell may break only after `_`, `/`, `.` or `-`, so a
// phone wraps CUBED_STATE as CUBED_ and STATE, never mid-word.
function builtPages() {
  return {
    name: "cube-built-pages",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const root = fileURLToPath(dir);
        for (const file of await readdir(root, { recursive: true })) {
          if (!file.endsWith(".html")) continue;
          const page = path.join(root, file);
          const html = await readFile(page, "utf8");
          const linked = html
            .replaceAll('href="gh:', `href="${repository}/blob/${docsRef}/`)
            .replace(/<td[^>]*>(.*?)<\/td>/gs, (cell) => cell.replace(/(<code[^>]*>)([^<]*)<\/code>/g, (_, open, text) => `${open}${text.replace(/([_/.-])(?=\w)/g, "$1<wbr>")}</code>`));
          if (linked !== html) await writeFile(page, linked);
        }
      },
    },
  };
}

export default defineConfig({
  site: "https://cubeyard.github.io",
  base: "/cube",
  trailingSlash: "always",
  integrations: [
    builtPages(),
    starlight({
      title: "cube",
      description: "Self-hosted coding-agent threads, each in its own virtual machine.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "cube on GitHub", href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/packages/docs/` },
      customCss: [
        "@fontsource-variable/archivo/wght.css",
        "@fontsource-variable/archivo/wght-italic.css",
        "@fontsource/jetbrains-mono/400.css",
        "@fontsource/jetbrains-mono/600.css",
        "./src/styles/cube.css",
      ],
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      expressiveCode: codeGlass,
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#fbfaf6", media: "(prefers-color-scheme: light)" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#101013", media: "(prefers-color-scheme: dark)" } },
      ],
      sidebar: [
        {
          label: "get started",
          items: [
            { label: "your first thread", slug: "start/first-thread" },
            { label: "install on macOS", slug: "start/install-macos" },
            { label: "install on Linux", slug: "start/install-linux" },
            { label: "update cube", slug: "start/update" },
          ],
        },
        {
          label: "use cube",
          items: [
            { label: "the chat", slug: "use/chat" },
            { label: "threads", slug: "use/threads" },
            { label: "projects", slug: "use/projects" },
            { label: "models", slug: "use/models" },
            { label: "artifacts", slug: "use/artifacts" },
            { label: "web servers in a thread", slug: "use/services" },
            { label: "skills", slug: "use/skills" },
            { label: "project hooks", slug: "use/project-hooks" },
          ],
        },
        {
          label: "run cube",
          items: [
            { label: "runners", slug: "run/runners" },
            { label: "reach cube from other devices", slug: "run/private-network" },
            { label: "troubleshooting", slug: "run/troubleshooting" },
          ],
        },
        {
          label: "concepts",
          items: [
            { label: "how cube works", slug: "concepts/how-cube-works" },
            { label: "a thread's life", slug: "concepts/thread-lifecycle" },
            { label: "security model", slug: "concepts/security-model" },
          ],
        },
        {
          label: "reference",
          items: [
            { label: "command line", slug: "reference/cli" },
            { label: "configuration", slug: "reference/configuration" },
            { label: "platforms", slug: "reference/platforms" },
            { label: "usage and cost", slug: "reference/usage-and-cost" },
            { label: "maintainer docs", slug: "reference/internals" },
          ],
        },
      ],
    }),
  ],
});
