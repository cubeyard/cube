<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { errorText, fetchStartupLog, fetchThreadSteps } from "../lib/api.ts";
  import { duration, LOGGED_STEPS, longStep, memoryAdvice, size, stepLabel, stepLamp, stepMs, totalMs } from "../lib/startup.ts";
  import type { StartupLog, StartupStep, ThreadSummary } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { thread, onClose = null }: { thread: ThreadSummary; onClose?: (() => void) | null } = $props();

  const steps = $derived(thread.vm?.steps ?? []);
  const running = $derived(steps.findLast((step) => step.state === "running") ?? null);
  const logged = $derived(!!running && LOGGED_STEPS.has(running.name));

  // Durations of a running step count up; nothing ticks once all ended.
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // The running hook's log, read every few seconds while a hook runs.
  let live = $state<StartupLog | null>(null);
  let liveError = $state<string | null>(null);
  $effect(() => {
    if (!logged) { live = null; return; }
    const id = thread.id;
    let stopped = false;
    const read = async () => {
      try {
        const answer = await fetchStartupLog(id);
        if (stopped) return;
        if (answer && "error" in answer) { liveError = answer.error; return; }
        live = answer;
        liveError = null;
      } catch (cause) {
        if (!stopped) liveError = errorText(cause);
      }
    };
    untrack(() => void read());
    const timer = setInterval(() => void read(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  });

  const stepKey = (step: StartupStep) => `${step.name}:${step.attempt ?? ""}:${step.startedAt}`;
  // The ends of failed hooks' logs: the thread list leaves them out, so
  // they are read once for each step that has one.
  const logs = new SvelteMap<string, string>();
  const missingLogs = $derived(steps.filter((step) => step.hasLog && !logs.has(stepKey(step))).map(stepKey).join(" "));
  $effect(() => {
    if (!missingLogs) return;
    const id = thread.id;
    void fetchThreadSteps(id).then((full) => {
      for (const step of full) if (step.log) logs.set(stepKey(step), step.log);
    }, () => { /* the step says what failed; its log stays unread */ });
  });

  // A log window follows its end unless the reader scrolled up.
  let logWindow = $state<HTMLPreElement>();
  $effect(() => {
    void live?.text;
    const element = logWindow;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 48 || element.scrollTop === 0) element.scrollTop = element.scrollHeight;
  });

  // A step opens while its hook runs or when it failed with a log; the
  // reader's own choice holds through later polls.
  const chosen = new SvelteMap<string, boolean>();
  const openByDefault = (step: StartupStep) => (step === running && logged) || (step.state === "failed" && !running);
  function onToggle(event: Event, step: StartupStep): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (open !== (chosen.get(stepKey(step)) ?? openByDefault(step))) chosen.set(stepKey(step), open);
  }

  // A step that starts running is brought into the panel's view.
  let panel = $state<HTMLElement>();
  const runningKey = $derived(running ? stepKey(running) : null);
  $effect(() => {
    if (!runningKey || !panel) return;
    const key = runningKey;
    void tick().then(() => panel?.querySelector(`[data-step="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  const advice = $derived(memoryAdvice(steps));
  const long = $derived(longStep(steps, now));
</script>

<section class="startup" aria-label="machine startup" bind:this={panel}>
  <div class="startup-head">
    <span class="startup-title">machine startup</span>
    <span class="startup-total">{duration(totalMs(steps, now))}</span>
    <span class="spacer"></span>
    <a class="startup-link" href="#/projects/{thread.project.id}">hooks and machine size</a>
    {#if onClose}
      <button class="key icon startup-close" title="hide machine startup" aria-label="hide machine startup" onclick={onClose}><Icon name="close" size={12} /></button>
    {/if}
  </div>
  {#if advice}
    <div class="strip-note bad startup-note" role="status">
      <span class="strip-note-text">{advice}</span>
      <a class="key" href="#/projects/{thread.project.id}">machine size</a>
    </div>
  {/if}
  {#if long}
    <div class="strip-note startup-note" role="status"><span class="strip-note-text">{long}</span></div>
  {/if}
  <ol class="startup-steps">
    {#each steps as step (stepKey(step))}
      {@const showLive = step === running && logged}
      <!-- a failed step's whole error is printed; another's detail only when its line cuts it -->
      {@const fullDetail = !!step.detail && (step.state === "failed" || step.detail.length > 90)}
      {@const body = fullDetail || !!step.memory || !!step.log || !!step.hasLog || showLive}
      <li data-step={stepKey(step)}>
        <details class="tool-strip startup-step" open={chosen.get(stepKey(step)) ?? openByDefault(step)} ontoggle={(event) => onToggle(event, step)}>
          <summary title={step.detail ?? stepLabel(step)}>
            <span class="lamp mini {stepLamp(step)}" aria-hidden="true"></span><span class="sr-only">{step.state}</span>
            <code>{stepLabel(step)}</code>
            {#if step.detail}<span class="tool-summary">{step.detail}</span>{/if}
            <span class="startup-time">{duration(stepMs(step, now))}</span>
            {#if body}<span class="tool-chevron"><Icon name="chevron" size={12} /></span>{/if}
          </summary>
          {#if fullDetail}<p class="startup-detail" class:bad={step.state === "failed"}>{step.detail}</p>{/if}
          {#if step.memory}
            <p class="startup-detail">memory: this command used up to {size(step.memory.peakBytes)}; the machine has {size(step.memory.totalBytes)}{#if step.memory.oomKills}; {step.memory.oomKills} process{step.memory.oomKills === 1 ? " was" : "es were"} killed for want of memory{/if}</p>
          {/if}
          {#if showLive}
            {#if live?.hook}
              <p class="startup-log-head">{live.hook} log{live.machine === "build" ? " in the build machine" : ""}{live.truncated ? `, the end of ${size(live.bytes)}` : ""}</p>
              <pre class="startup-log" bind:this={logWindow}>{live.text || "(nothing written yet)"}</pre>
            {:else if liveError}
              <p class="startup-detail">the log could not be read: {liveError}</p>
            {/if}
          {:else if step.log ?? logs.get(stepKey(step))}
            <p class="startup-log-head">the end of the failed hook's log</p>
            <pre class="startup-log">{step.log ?? logs.get(stepKey(step))}</pre>
          {/if}
        </details>
      </li>
    {/each}
  </ol>
</section>
