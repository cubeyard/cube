<script lang="ts">
  import { onMount } from "svelte";
  import { errorText, fetchUsage } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { SubjectUsage, UsageLine, UsageReport } from "../lib/types.ts";
  import { gapsText, spendText, tokensText } from "../../../server/src/usage.ts";
  import Icon from "./Icon.svelte";

  /** Without a project: every thread, by project, plus optchat's own. */
  let { projectId = null }: { projectId?: string | null } = $props();
  let report = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let allThreads = $state(false);
  const SHOWN = 8;

  async function load(): Promise<void> {
    loading = true;
    try {
      report = await fetchUsage(projectId);
      error = null;
    } catch (cause) {
      error = errorText(cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => { void load(); });

  const subjectCost = (item: SubjectUsage) => item.coverage === "unavailable" ? "usage unknown" : spendText(item.spend);
  const subjectMeta = (item: SubjectUsage) => [
    !projectId && report?.projects.find((project) => project.id === item.projectId)?.name,
    item.agent === "claude-code" ? "claude · max" : item.agent,
    item.archived ? "archived" : null,
    item.read === "snapshot" ? `last read ${item.readAt ? `${relTime(item.readAt)} ago` : "earlier"}` : null,
    item.unknownTurns ? `${item.unknownTurns} ${item.unknownTurns === 1 ? "turn" : "turns"} without a usage report` : null,
  ].filter(Boolean).join(" · ");
  const pricingText = (line: UsageLine) => !line.pricing ? ""
    : line.pricing.input || line.pricing.output ? ` · catalog now: $${line.pricing.input} in / $${line.pricing.output} out per million tokens`
    : " · the catalog lists no price for this model";
  const threads = $derived(report ? (allThreads ? report.threads : report.threads.slice(0, SHOWN)) : []);
</script>

<section class="usage-panel" aria-labelledby="usage-heading">
  <div class="board-head">
    <div>
      <h2 id="usage-heading">usage</h2>
      <p>tokens from the agents' own records · amounts are estimates, never charges</p>
    </div>
    <button class="key" onclick={load} disabled={loading}>
      <Icon name="refresh" size={13} />{loading ? "reading…" : "refresh"}
    </button>
  </div>

  {#if error}<div class="banner" role="alert"><span class="banner-text">{error}</span></div>{/if}
  {#if !report}
    {#if !error}<p class="hint">reading usage…</p>{/if}
  {:else}
    <div class="runner-board well">
      <article class="runner-row usage-total">
        <div class="runner-identity">
          <span class="lamp {report.totals.coverage === 'complete' ? 'on-green' : report.totals.coverage === 'unavailable' ? 'on-red' : 'off'}" aria-hidden="true"></span>
          <span>
            <strong>{report.totals.coverage === "unavailable" ? "usage unknown" : spendText(report.totals.spend)}</strong>
            <small>{report.totals.subjects} {report.totals.subjects === 1 ? "record" : "records"}{report.totals.coverage === "complete" ? " · complete" : ""}</small>
          </span>
        </div>
        <div class="runner-evidence">
          <span>{tokensText(report.totals.spend.tokens)}</span>
          {#if gapsText(report.totals)}<span class="usage-gap">{gapsText(report.totals)}</span>{/if}
          <span>billed: not available</span>
        </div>
      </article>
      {#if report.optchat}
        <article class="runner-row">
          <div class="runner-identity">
            <span class="lamp off" aria-hidden="true"></span>
            <span><strong>optchat</strong><small>its own model calls, compactor and wish finder</small></span>
          </div>
          <div class="runner-evidence">
            <strong>{subjectCost(report.optchat)}</strong>
            {#if report.optchatThreads?.count}<span>its {report.optchatThreads.count} threads: {spendText(report.optchatThreads.totals.spend)}, counted with the threads</span>{/if}
            {#if report.optchat.coverage === "unavailable"}<span class="usage-gap">{report.optchat.notes.join(" · ")}</span>{/if}
          </div>
        </article>
      {/if}
    </div>

    {#if !projectId && report.projects.length}
      <h3 class="usage-subhead">by project</h3>
      <div class="runner-board well">
        {#each report.projects as project (project.id)}
          <article class="runner-row">
            <div class="runner-identity">
              <span class="lamp off" aria-hidden="true"></span>
              <span><a href="#/projects/{project.id}"><strong>{project.name}</strong></a><small>{project.totals.subjects} {project.totals.subjects === 1 ? "thread" : "threads"}</small></span>
            </div>
            <div class="runner-evidence">
              <strong>{project.totals.coverage === "unavailable" ? "usage unknown" : spendText(project.totals.spend)}</strong>
              {#if gapsText(project.totals)}<span class="usage-gap">{gapsText(project.totals)}</span>{/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}

    {#if report.models.length}
      <h3 class="usage-subhead">by model</h3>
      <div class="runner-board well">
        {#each report.models as line (`${line.source}/${line.provider}/${line.model}`)}
          <article class="runner-row">
            <div class="runner-identity">
              <span class="lamp off" aria-hidden="true"></span>
              <span><strong title={`${line.provider}/${line.model}`}>{line.model}</strong><small>{line.provider === "claude-code" ? "claude · max" : line.provider}{line.source.startsWith("optchat") ? ` · ${line.source.replace("-", " ")}` : ""}{line.calls !== null ? ` · ${line.calls} calls` : ""}</small></span>
            </div>
            <div class="runner-evidence">
              <strong>{spendText(line.spend)}</strong>
              <span>{tokensText(line.spend.tokens)}</span>
              <span class="usage-basis">{line.basis}{pricingText(line)}</span>
            </div>
          </article>
        {/each}
      </div>
    {/if}

    {#if report.threads.length}
      <h3 class="usage-subhead">by thread</h3>
      <div class="runner-board well">
        {#each threads as item (item.subject)}
          <article class="runner-row">
            <div class="runner-identity">
              <span class="lamp {item.archived ? 'off' : 'on-green'}" aria-hidden="true"></span>
              <span>
                {#if item.archived}<strong>{item.title ?? item.subject.slice(0, 8)}</strong>
                {:else}<a href="#/t/{item.subject}"><strong>{item.title ?? item.subject.slice(0, 8)}</strong></a>{/if}
                <small>{subjectMeta(item)}</small>
              </span>
            </div>
            <div class="runner-evidence">
              <strong>{subjectCost(item)}</strong>
              {#if item.coverage !== "unavailable"}<span>{tokensText(item.spend.tokens)}</span>{/if}
              {#if item.coverage === "unavailable"}<span class="usage-gap">{item.notes.join(" · ")}</span>{/if}
            </div>
          </article>
        {/each}
      </div>
      {#if report.threads.length > SHOWN}
        <button class="key usage-more" onclick={() => (allThreads = !allThreads)}>{allThreads ? "show fewer" : `show all ${report.threads.length} threads`}</button>
      {/if}
    {/if}

    <ul class="usage-notes">
      {#each report.notes as note}<li>{note}</li>{/each}
    </ul>
  {/if}
</section>

<style>
  .usage-panel { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 1.35rem; }
  .usage-subhead { margin: 0.4rem 0 0; color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  .usage-panel :global(.runner-row) { grid-template-columns: minmax(11rem, 0.8fr) minmax(15rem, 1.5fr); }
  .usage-panel a { color: inherit; text-decoration: none; }
  .usage-panel a:hover strong { color: var(--signal); }
  .usage-gap { color: var(--ink-2); }
  .usage-basis { font-size: 10px; }
  .usage-more { align-self: flex-start; }
  .usage-notes { margin: 0; padding-left: 1.1rem; color: var(--ink-3); font: 11px/1.5 var(--font-mono); overflow-wrap: anywhere; }
  @media (max-width: 40rem) {
    .usage-panel :global(.runner-row) { grid-template-columns: 1fr; }
  }
</style>
