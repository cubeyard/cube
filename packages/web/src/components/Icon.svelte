<script lang="ts">
  // The instrument's icon set: one stroke family (2px, round joins) drawn
  // to match the cube glyph. Every icon is authored here — no unicode
  // glyphs standing in for controls anywhere in the app.
  const PATHS = {
    plus: "M12 5 V19 M5 12 H19",
    close: "M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5",
    pencil: "M4.5 19.5 5.3 16 15.8 5.5 a2.05 2.05 0 0 1 2.9 2.9 L8.2 18.9 4.5 19.5 Z M14.3 7 l2.9 2.9",
    trash: "M4.5 6.5 h15 M9.5 6.5 V4.2 h5 v2.3 M6.3 6.5 l0.9 13 h9.6 l0.9 -13 M10 10.2 v6 M14 10.2 v6",
    chevron: "M6.5 9.5 l5.5 5.5 5.5 -5.5",
    file: "M6.5 3.5 H14 l3.5 3.5 V20.5 H6.5 Z M14 3.5 V7 h3.5",
    refresh: "M20 7 V3 l-2.5 2.5 A8 8 0 0 0 4 10 M20 3 h-4 M4 17 v4 l2.5 -2.5 A8 8 0 0 0 20 14 M4 21 h4",
  } as const satisfies Record<string, string>;

  // keyof-typed: a misspelled icon name fails `pnpm typecheck` instead of
  // rendering an empty SVG on an icon-only control.
  let { name, size = 14 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>
