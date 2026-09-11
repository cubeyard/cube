<script lang="ts">
  import { DateTime, Effect, Fiber, Schedule } from "effect";
  import type { EnvironmentProgress } from "../lib/types.ts";

  let { progress, waiting }: { progress: EnvironmentProgress; waiting: boolean } = $props();
  let now = $state(Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))));
  let expanded = $state(false);
  const elapsed = $derived(Math.max(0, Math.floor(((waiting ? now : progress.updatedAt) - progress.startedAt) / 1000)));
  const quiet = $derived(Math.max(0, Math.floor((now - progress.updatedAt) / 1000)));
  const lines = $derived(progress.log.trim().split("\n"));
  const preview = $derived(lines.slice(-8).join("\n"));

  $effect(() => {
    if (!waiting) return;
    const fiber = Effect.runFork(DateTime.now.pipe(Effect.tap((time) => Effect.sync(() => { now = DateTime.toEpochMillis(time); }))).pipe(
      Effect.repeat(Schedule.spaced("1 second")),
    ));
    return () => { Effect.runFork(Fiber.interrupt(fiber)); };
  });
</script>

<section class="startup-progress" aria-label="Environment startup">
  <p class="term-note">{elapsed}s elapsed{waiting && quiet >= 10 ? ` · no new log for ${quiet}s` : ""}</p>
  {#if waiting && quiet >= 30}
    <p class="term-note">Still waiting for this step to finish. No new output does not necessarily mean it has stopped.</p>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: scrollable logs must be keyboard accessible -->
  <pre tabindex="0" aria-label="Latest startup output">{expanded ? progress.log.trim() : preview}</pre>
  <button class="key" aria-expanded={expanded} onclick={() => Effect.runSync(Effect.sync(() => { expanded = !expanded; }))}>
    {expanded ? "show recent lines" : "show full captured log"}
  </button>
  {#if progress.truncated}
    <p class="term-note">Earlier output omitted. Only the latest 32,768 characters is retained.</p>
  {/if}
</section>

<style>
  .startup-progress { width: min(100%, 48rem); min-height: 0; overflow: auto; }
  pre {
    text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 45vh; overflow: auto; padding: 0.8rem;
    background: var(--glass-head); color: var(--glass-chrome);
    font: 12px/1.5 var(--font-mono);
  }
  p { margin: 0.5rem auto; }
</style>
