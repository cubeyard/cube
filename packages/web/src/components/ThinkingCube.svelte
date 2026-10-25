<script lang="ts">
  import { onMount } from "svelte";
  import { frame, lattice, type CubeState } from "../lib/thinking-cube.ts";

  // The thinking cube: square dots in a cube that move while the agent or
  // its machine does something, always beside the words that say what
  // (the words keep the state's accessible name; the cube is hidden from
  // screen readers). Ink, never the signal; one shared clock; still under
  // reduced motion, offscreen and in a hidden tab.
  // `state` is read as `kind`: a binding named `state` would turn `$state` into a store
  let { state: kind = "working", size = 20 }: { state?: CubeState; size?: 20 | 64 } = $props();

  let canvas = $state<HTMLCanvasElement>();
  const points = $derived(lattice(size >= 40 ? 6 : 4));

  function draw(time: number): void {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== size * ratio) { canvas.width = size * ratio; canvas.height = size * ratio; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    context.fillStyle = getComputedStyle(canvas).color;
    for (const dot of frame(kind, time, size, points)) {
      context.globalAlpha = dot.alpha;
      context.fillRect(dot.x - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
    }
    context.globalAlpha = 1;
  }

  // a new state shows at once, also as the still frame
  $effect(() => { void kind; void points; draw(kind === "starting" ? 1300 : 600); });

  onMount(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const dark = matchMedia("(prefers-color-scheme: dark)");
    let seen = true;
    let handle = 0;
    // the still frame: the cube whole, at rest
    const rest = () => draw(kind === "starting" ? 1300 : 600);
    const loop = (time: number) => { draw(time); handle = requestAnimationFrame(loop); };
    const update = () => {
      cancelAnimationFrame(handle);
      handle = 0;
      if (still.matches) rest();
      else if (seen && !document.hidden) handle = requestAnimationFrame(loop);
    };
    const observer = new IntersectionObserver(([entry]) => { seen = !!entry?.isIntersecting; update(); });
    if (canvas) observer.observe(canvas);
    still.addEventListener("change", update);
    dark.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    rest();
    update();
    return () => {
      cancelAnimationFrame(handle);
      observer.disconnect();
      still.removeEventListener("change", update);
      dark.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  });
</script>

<canvas class="thinking-cube" class:large={size >= 40} bind:this={canvas} width={size} height={size} style:width="{size}px" style:height="{size}px" aria-hidden="true" data-state={kind}></canvas>
