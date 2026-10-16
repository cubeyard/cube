<script lang="ts">
  import { onMount } from "svelte";
  import { checkRunner, discardThreadMachine, errorText, fetchObservedRunners, fetchRunners, fetchThreads, retireRunner } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { CapacityGroup, RunnersObservation, RunnerStatus, ThreadSummary } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { onChanged = () => {} }: { onChanged?: () => void } = $props();
  let runners = $state<RunnerStatus[]>([]);
  let observed = $state<RunnersObservation | null>(null);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let checking = $state<string[]>([]);
  let retiring = $state<string | null>(null);
  let confirm = $state("");
  let reason = $state("");
  let retained = $state<ThreadSummary[]>([]);
  let discarding = $state<string | null>(null);
  let confirmDiscard = $state<string | null>(null);

  const replace = (runner: RunnerStatus) => {
    runners = runners.map((item) => item.id === runner.id ? runner : item);
  };

  async function loadRetained(): Promise<void> {
    retained = (await fetchThreads(true)).filter((thread) => thread.archived && thread.vm?.retain && !thread.vm.discarded);
  }

  async function discard(thread: ThreadSummary): Promise<void> {
    discarding = thread.id;
    try {
      await discardThreadMachine(thread.id);
      confirmDiscard = null;
      error = null;
      await Promise.all([loadRetained(), checkAll()]);
    } catch (cause) {
      error = errorText(cause);
    } finally {
      discarding = null;
    }
  }

  async function observe(): Promise<void> {
    observed = await fetchObservedRunners();
  }

  async function load(): Promise<void> {
    try {
      [runners] = await Promise.all([fetchRunners(), loadRetained(), observe()]);
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
      await observe();
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

  const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(value / 1e6))} MB`;
  const canRetire = (runner: RunnerStatus) => runner.allocationState === "available" && runner.activeThreads === 0 &&
    (runner.contactStatus === "stale" || (runner.contactStatus === "reachable" && runner.health?.activeVms === 0));
  const lampClass = (runner: RunnerStatus) => runner.contactStatus === "reachable" ? "on-green"
    : runner.contactStatus === "unreachable" || runner.contactStatus === "stale" ? "on-red"
    : "off";
  const contactCopy = (runner: RunnerStatus) => runner.contactStatus === "reachable"
    ? "authenticated contact succeeded"
    : runner.contactStatus === "unreachable" ? "latest authenticated check failed"
    : runner.contactStatus === "stale" ? "unreachable continuously for at least 7 days"
    : runner.contactStatus === "retired" ? "retired bindings are never scheduled"
    : "not checked since this registry learned runner observations";

  const observation = (runner: RunnerStatus) => observed?.runners.find((item) => item.id === runner.id);
  /** The runner's protocol, and whether it is in the pool or takes only threads started on it by name. */
  const protocolLabel = (runner: RunnerStatus) => {
    const item = observation(runner);
    return !item ? null : item.protocol === 3 ? "p3 · by name only" : item.kind === "host" ? "p4 host · unsandboxed, by name only" : "p4 vm · pool";
  };
  const nodeOf = (id: string) => observed?.runners.find((item) => item.id === id)?.nodeId ?? id;
  const slotsCopy = (group: CapacityGroup) => `${group.free} free of ${group.slots} ${group.slots === 1 ? "slot" : "slots"}`;
  /** Runners whose numbers are their last report's, or not from a report at all. */
  const notCurrent = (...groups: CapacityGroup[]) => [
    ...groups.flatMap((group) => group.stale.map((id) => `${nodeOf(id)} (stale report)`)),
    ...groups.flatMap((group) => group.unreported.map((id) => `${nodeOf(id)} (never reported)`)),
  ];

  onMount(async () => {
    await load();
    await checkAll();
  });
</script>

<section class="runner-panel" aria-labelledby="runner-heading">
  <div class="board-head">
    <div>
      <h2 id="runner-heading">runners</h2>
      <p>reachable is the latest authenticated check; stale means continuously unreachable for 7 days</p>
    </div>
    <button class="key" onclick={checkAll} disabled={!loaded || checking.length > 0 || !runners.some((runner) => !runner.retiredAt)}>
      <Icon name="refresh" size={13} />{checking.length ? "checking…" : "check runners"}
    </button>
  </div>

  {#if observed && runners.length}
    {@const { p3, p4 } = observed.capacity}
    {@const late = notCurrent(p3, p4.vm, p4.host)}
    <div class="runner-capacity" aria-label="capacity">
      <p class="capacity-p3">p3 by name · {slotsCopy(p3)} on {p3.runners} {p3.runners === 1 ? "runner" : "runners"} · open p3 threads: {p3.openThreads}</p>
      <p class="capacity-p4">p4 · {p4.vm.runners || p4.host.runners
        ? [p4.vm.runners ? `vm pool ${slotsCopy(p4.vm)}` : "", p4.host.runners ? `host by name ${slotsCopy(p4.host)}` : ""].filter(Boolean).join(" · ")
        : "no runners"}</p>
      {#if late.length}<p class="capacity-late">not current: {late.join(", ")}</p>{/if}
      <p class="capacity-note">a new thread goes to the pool, the p4 vm runners; p3 and p4 host runners take only threads started on them by name. a slot is an open thread in cube, not a machine on the runner.</p>
    </div>
  {/if}

  {#if error}<div class="banner" role="alert"><span class="banner-text">{error}</span></div>{/if}
  {#if !loaded}
    <p class="hint">reading runner bindings…</p>
  {:else if !runners.length}
    <div class="runner-board well"><p class="hint">no runners are registered for this installation</p></div>
  {:else}
    <div class="runner-board well">
      {#each runners as runner (runner.id)}
        <article class="runner-row">
          <div class="runner-identity">
            <span class="lamp {lampClass(runner)}" aria-hidden="true"></span>
            <span>
              <strong>{runner.nodeId}</strong>
              {#if protocolLabel(runner)}<small class="runner-protocol">{protocolLabel(runner)}</small>{/if}
              <small>environment {runner.environmentId} · {runner.allocationState} · {runner.activeThreads
                ? `${runner.activeThreads} of ${runner.maxActiveVms} thread machines in use`
                : `unallocated · ${runner.maxActiveVms} thread ${runner.maxActiveVms === 1 ? "machine" : "machines"}`}</small>
            </span>
          </div>
          <div class="runner-evidence">
            <strong>{runner.contactStatus}</strong> · {contactCopy(runner)}
            <span>
              last contact:
              {#if runner.lastContactAt}
                <time datetime={new Date(runner.lastContactAt).toISOString()} title={new Date(runner.lastContactAt).toLocaleString()}>{relTime(runner.lastContactAt)} ago</time>
              {:else}never observed{/if}
              {#if runner.health} · machines {runner.health.activeVms} of {runner.health.maxActiveVms} · running {runner.health.runningVms} · retained {runner.health.retainedVms ? `${runner.health.retainedVms} (${bytes(runner.health.retainedBytes)})` : 0}{/if}
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
            <p class="runner-blocked">{runner.activeThreads || runner.allocationState !== "available" || runner.allocationProjectId
              ? "retirement is blocked while the global allocation snapshot records a thread"
              : runner.contactStatus === "reachable" && runner.health?.activeVms
                ? "retirement is blocked while the runner reports an active thread machine"
                : "an unavailable runner must remain unreachable for 7 days before retirement"}</p>
          {/if}
          {#if retiring === runner.id}
            <form class="runner-retire" onsubmit={(event) => { event.preventDefault(); void retire(runner); }}>
              <p><strong>retirement is permanent.</strong> cube stops scheduling this binding and removes its capacity. host audit, thread records, the runner journal and retained machine disks are not deleted.</p>
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

  {#if retained.length}
    <div class="board-head">
      <div>
        <h2 id="retained-heading">retained machines</h2>
        <p>archived threads whose disk was kept as evidence; discarding deletes the disk on its runner</p>
      </div>
    </div>
    <div class="runner-board well" aria-labelledby="retained-heading">
      {#each retained as thread (thread.id)}
        <article class="runner-row">
          <div class="runner-identity">
            <span class="lamp off" aria-hidden="true"></span>
            <span>
              <strong>{thread.title ?? thread.id.slice(0, 8)}</strong>
              <small>{thread.project.name}{thread.createdAt ? ` · created ${relTime(thread.createdAt)} ago` : ""}</small>
            </span>
          </div>
          <div class="runner-evidence">
            <span>{thread.vm?.retainReason ?? "kept"}</span>
          </div>
          <div class="runner-controls">
            {#if confirmDiscard === thread.id}
              <button class="key" onclick={() => (confirmDiscard = null)} disabled={discarding === thread.id}>keep</button>
              <button class="key danger-text" onclick={() => discard(thread)} disabled={discarding === thread.id}>{discarding === thread.id ? "discarding…" : "delete disk"}</button>
            {:else}
              <button class="key danger-text" onclick={() => (confirmDiscard = thread.id)}>discard</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
