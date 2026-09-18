<script lang="ts">
  import { onMount } from "svelte";
  import { checkRunner, errorText, fetchRunners, retireRunner } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { RunnerStatus } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { onChanged = () => {} }: { onChanged?: () => void } = $props();
  let runners = $state<RunnerStatus[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let checking = $state<string[]>([]);
  let retiring = $state<string | null>(null);
  let confirm = $state("");
  let reason = $state("");

  const replace = (runner: RunnerStatus) => {
    runners = runners.map((item) => item.id === runner.id ? runner : item);
  };

  async function load(): Promise<void> {
    try {
      runners = await fetchRunners();
      error = null;
    } catch (cause) {
      error = errorText(cause);
    } finally {
      loaded = true;
    }
  }

  async function check(runner: RunnerStatus): Promise<void> {
    if (checking.includes(runner.id) || runner.retiredAt) return;
    checking = [...checking, runner.id];
    try {
      replace(await checkRunner(runner.id));
      error = null;
    } catch (cause) {
      error = errorText(cause);
    } finally {
      checking = checking.filter((id) => id !== runner.id);
    }
  }

  async function checkAll(): Promise<void> {
    await Promise.all(runners.filter((runner) => !runner.retiredAt).map(check));
  }

  function openRetirement(runner: RunnerStatus): void {
    retiring = runner.id;
    confirm = "";
    reason = "";
  }

  async function retire(runner: RunnerStatus): Promise<void> {
    if (confirm !== runner.nodeId || !reason.trim()) return;
    checking = [...checking, runner.id];
    try {
      replace(await retireRunner(runner.id, confirm, reason.trim()));
      retiring = null;
      error = null;
      onChanged();
    } catch (cause) {
      error = errorText(cause);
    } finally {
      checking = checking.filter((id) => id !== runner.id);
    }
  }

  const canRetire = (runner: RunnerStatus) => runner.allocationState === "available" &&
    (runner.contactStatus === "stale" || (runner.contactStatus === "reachable" && !runner.health?.active && runner.health?.activeWorkspaces === 0));
  const lampClass = (runner: RunnerStatus) => runner.contactStatus === "reachable" ? "on-green"
    : runner.contactStatus === "unreachable" || runner.contactStatus === "stale" ? "on-red"
    : "off";
  const contactCopy = (runner: RunnerStatus) => runner.contactStatus === "reachable"
    ? "authenticated contact succeeded"
    : runner.contactStatus === "unreachable" ? "latest authenticated check failed"
    : runner.contactStatus === "stale" ? "unreachable continuously for at least 7 days"
    : runner.contactStatus === "retired" ? "retired bindings are never scheduled"
    : "not checked since this registry learned runner observations";

  onMount(async () => {
    await load();
    await checkAll();
  });
</script>

<section class="runner-panel" aria-labelledby="runner-heading">
  <div class="board-head">
    <div>
      <h2 id="runner-heading">global runner pool</h2>
      <p>reachable is the latest authenticated check; stale means continuously unreachable for 7 days</p>
    </div>
    <button class="key" onclick={checkAll} disabled={!loaded || checking.length > 0 || !runners.some((runner) => !runner.retiredAt)}>
      <Icon name="refresh" size={13} />{checking.length ? "checking…" : "check runners"}
    </button>
  </div>

  {#if error}<div class="banner" role="alert"><span class="banner-text">{error}</span></div>{/if}
  {#if !loaded}
    <p class="hint">reading runner bindings…</p>
  {:else if !runners.length}
    <div class="runner-board well"><p class="hint">no trusted runners are registered for this installation</p></div>
  {:else}
    <div class="runner-board well">
      {#each runners as runner (runner.id)}
        <article class="runner-row">
          <div class="runner-identity">
            <span class="lamp {lampClass(runner)}" aria-hidden="true"></span>
            <span>
              <strong>{runner.nodeId}</strong>
              <small>environment {runner.environmentId} · {runner.allocationState}{runner.allocationProjectName ? ` · ${runner.allocationProjectName}` : " · unallocated"}</small>
            </span>
          </div>
          <div class="runner-evidence">
            <strong>{runner.contactStatus}</strong> · {contactCopy(runner)}
            <span>
              last contact:
              {#if runner.lastContactAt}
                <time datetime={new Date(runner.lastContactAt).toISOString()} title={new Date(runner.lastContactAt).toLocaleString()}>{relTime(runner.lastContactAt)} ago</time>
              {:else}never observed{/if}
              {#if runner.health} · active commands {runner.health.active ? 1 : 0} · active workspaces {runner.health.activeWorkspaces}{/if}
            </span>
            {#if runner.error}<span class="error">{runner.error}</span>{/if}
            {#if runner.retiredAt}
              <span>retired <time title={new Date(runner.retiredAt).toLocaleString()}>{relTime(runner.retiredAt)} ago</time> · {runner.retirementReason}</span>
            {/if}
          </div>
          <div class="runner-controls">
            {#if !runner.retiredAt}
              <button class="key" onclick={() => check(runner)} disabled={checking.includes(runner.id)}>check</button>
              <button class="key danger-text" onclick={() => openRetirement(runner)} disabled={!canRetire(runner)}>retire</button>
            {/if}
          </div>
          {#if !runner.retiredAt && !canRetire(runner)}
            <p class="runner-blocked">{runner.allocationState !== "available" || runner.allocationProjectId
              ? "retirement is blocked while the global allocation snapshot records a thread or workspace"
              : runner.contactStatus === "reachable" && (runner.health?.active || runner.health?.activeWorkspaces)
                ? "retirement is blocked while the runner reports active work or workspace"
                : "an unavailable runner must remain unreachable for 7 days before retirement"}</p>
          {/if}
          {#if retiring === runner.id}
            <form class="runner-retire" onsubmit={(event) => { event.preventDefault(); void retire(runner); }}>
              <p><strong>retirement is permanent.</strong> cube stops scheduling this binding and removes its capacity. host audit, thread records, runner journal, operations and retained workspaces are not deleted.</p>
              <label class="config-field">
                <span class="silk">reason for audit</span>
                <input class="compose-input" bind:value={reason} maxlength="500" placeholder="why this binding is being retired" />
              </label>
              <label class="config-field">
                <span class="silk">type {runner.nodeId} to confirm</span>
                <input class="compose-input" bind:value={confirm} autocomplete="off" spellcheck="false" />
              </label>
              <div class="runner-retire-actions">
                <button type="button" class="key" onclick={() => (retiring = null)}>cancel</button>
                <button class="key danger-text" disabled={confirm !== runner.nodeId || !reason.trim() || checking.includes(runner.id)}>retire binding</button>
              </div>
            </form>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
