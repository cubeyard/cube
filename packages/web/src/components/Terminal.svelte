<script lang="ts">
  import { Effect } from "effect";
  import EnvironmentProgressView from "./EnvironmentProgress.svelte";
  import type { EnvironmentProgress } from "../lib/types.ts";
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { terminalUrl } from "../lib/api.ts";
  import type { TerminalControlFrame } from "../lib/types.ts";

  let { threadId, waitingText = null }: {
    threadId: string;
    /** The thread's own waiting line ("waking this thread's environment…")
     * — printed while the socket connects, so the pane never says a bare
     * "connecting…" about a thread we already know is being started. */
    waitingText?: string | null;
  } = $props();

  // The pane's own state, shown as a silkscreen overlay on the glass. The
  // conversation itself is pi's — we only narrate the transport.
  type Pane =
    | { kind: "connecting"; text: string | null }
    | { kind: "status"; text: string }
    | { kind: "live" }
    | { kind: "lost"; retryAt: number } // transport gone twice in a row
    | { kind: "ended"; text: string } // pi exited — restart respawns it
    | { kind: "error"; text: string };
  let progress = $state<EnvironmentProgress | null>(null);
  let pane = $state<Pane>({ kind: "connecting", text: null });
  let now = $state(Date.now());

  let host: HTMLElement;
  let term: Terminal;
  let fit: FitAddon;
  let ws: WebSocket | null = null;
  let disposed = false;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // The latest server status line ("running .cube/setup — this can take a
  // while…"): kept across a dropped socket so a reconnect shows where the
  // host got to, not just that we are connecting.
  let lastStatus: string | null = null;
  // Focus is taken once per mount, on the first healthy connect; a
  // background reconnect must not pull the caret out of whatever the user
  // is doing elsewhere on the page. An explicit restart / retry now is
  // the user's own act on the terminal, so it asks for focus again.
  let focusTaken = false;
  let focusRequested = false;
  // A socket has been open in this mount: the next open is a reattach to a
  // process whose screen we still hold.
  let attached = false;
  /** This open follows an earlier one on the same mount (a transport drop). */
  let reattach = false;
  // Consecutive closes without a healthy open in between.
  let drops = 0;

  const countdown = $derived(pane.kind === "lost" ? Math.max(0, Math.ceil((pane.retryAt - now) / 1000)) : 0);
  $effect(() => {
    if (pane.kind !== "lost") return;
    const ticker = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(ticker);
  });

  function takeFocusOnce(): void {
    if (focusTaken && !focusRequested) return;
    focusTaken = true;
    focusRequested = false;
    term.focus();
  }

  function connect(): void {
    if (disposed) return;
    // One socket at a time: a retry while another attempt is pending or
    // open must not leave an orphan writing into the same xterm.
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const previous = ws;
    ws = null;
    previous?.close();
    pane = { kind: "connecting", text: lastStatus ?? waitingText };
    const socket = new WebSocket(terminalUrl(threadId, term.cols, term.rows));
    socket.binaryType = "arraybuffer";
    ws = socket;
    // A terminal-frame (exit/error) is final: pi is gone until the user
    // restarts. A close WITHOUT one is transport loss — auto-reconnect.
    let final = false;
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        term.write(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      const frame = JSON.parse(event.data) as TerminalControlFrame;
      if (frame.t === "status") {
        // Several arrive in sequence while the environment is prepared;
        // the latest is the truth.
        Effect.runSync(Effect.sync(() => { if (frame.progress) progress = frame.progress; }));
        lastStatus = frame.text;
        pane = { kind: "status", text: frame.text };
      } else if (frame.t === "spawned") {
        // A fresh process: whatever is on the glass belonged to one that
        // is gone. This is the one moment a clean frame is honest.
        term.reset();
        lastStatus = null;
        pane = { kind: "live" };
        retryDelay = 1000;
        takeFocusOnce();
      } else if (frame.t === "attached") {
        // Joined a live process. When the server replays its tail, the
        // glass is cleared first so nothing is drawn twice; when it has
        // nothing to replay, the seam marks where the link came back.
        if (frame.replay) term.reset();
        else if (reattach) term.write("\r\n\x1b[2m— reconnected —\x1b[0m\r\n");
        lastStatus = null;
        pane = { kind: "live" };
        retryDelay = 1000;
        takeFocusOnce();
      } else if (frame.t === "exit") {
        final = true;
        lastStatus = null;
        pane = {
          kind: "ended",
          text:
            frame.code === null || frame.code === 0
              ? "session ended"
              : `the agent process stopped unexpectedly (exit ${frame.code})`,
        };
      } else if (frame.t === "error") {
        final = true;
        lastStatus = null;
        pane = { kind: "error", text: frame.text };
      }
    };
    socket.onopen = () => {
      drops = 0;
      retryDelay = 1000; // a healthy link earns back the fast retry
      // The seam (or a clean frame) is written when the server says how it
      // is attaching — see the `attached` frame — not on open.
      reattach = attached;
      attached = true;
      // A process may already be live server-side; the replay starts
      // flowing immediately either way. Treat open as live unless a
      // status/error frame says otherwise.
      if (pane.kind === "connecting") pane = { kind: "live" };
      takeFocusOnce();
    };
    socket.onclose = () => {
      if (ws !== socket || disposed || final) return;
      drops += 1;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 10_000);
      retryTimer = setTimeout(connect, delay);
      // One drop is a blip worth nothing but a quiet retry; the second in
      // a row is worth saying out loud, with a way to hurry it.
      pane =
        drops >= 2
          ? { kind: "lost", retryAt: Date.now() + delay }
          : { kind: "connecting", text: lastStatus ?? waitingText };
    };
  }

  /** The user asked: retry at once, from the fast delay. The key they
   * pressed is about to disappear with the veil, so the caret goes to the
   * glass on the next healthy connect rather than to the page. */
  function retryNow(): void {
    focusRequested = true;
    retryDelay = 1000;
    connect();
  }

  /** After an exit: a new process, so no "reconnected" seam. */
  function restart(): void {
    attached = false;
    drops = 0;
    retryNow();
  }

  function sendInput(data: string): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ t: "input", data }));
    return true;
  }

  /** Touch devices have no Escape, Tab, or Ctrl on the soft keyboard; the
   * key row above the glass sends the bytes pi expects. */
  const TOUCH_KEYS: Array<{ label: string; data: string }> = [
    { label: "esc", data: "\x1b" },
    { label: "tab", data: "\t" },
    { label: "ctrl-c", data: "\x03" },
  ];

  /** Submit a complete prompt through the same live TUI connection as
   * keyboard input. Bracketed paste keeps the long multi-line Ship prompt
   * inside pi's editor until the final carriage return submits it. */
  export function submitPrompt(text: string): boolean {
    if (pane.kind !== "live" || !sendInput(`\x1b[200~${text}\x1b[201~\r`)) return false;
    term.focus();
    return true;
  }

  onMount(() => {
    let observer: ResizeObserver | undefined;
    // JetBrains Mono must be measurable before xterm takes its cell
    // metrics, or every glyph draws on a wrong grid.
    void document.fonts.load('13px "JetBrains Mono"').then(() => {
      if (disposed) return;
      term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, SF Mono, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        // The dark-glass material (DESIGN.md): one finish in both themes,
        // signal orange for the caret — the one control that is yours.
        theme: {
          background: "#17181c",
          foreground: "#d9dae2",
          cursor: "#ff5a14",
          cursorAccent: "#17181c",
          selectionBackground: "rgba(255, 90, 20, 0.30)",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      term.onData((data) => {
        sendInput(data);
      });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols, rows }));
      });
      observer = new ResizeObserver(() => fit.fit());
      observer.observe(host);
      connect();
    });
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      observer?.disconnect();
      term?.dispose();
    };
  });
</script>

<div class="term-keys" aria-label="terminal keys">
  {#each TOUCH_KEYS as key (key.label)}
    <button class="key" onpointerdown={(event) => event.preventDefault()} onclick={() => sendInput(key.data)}>{key.label}</button>
  {/each}
</div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions: xterm owns the keyboard inside -->
<div class="term-pane" role="application" aria-label="agent terminal">
  <div class="term-host" bind:this={host}></div>
  {#if pane.kind !== "live" || progress?.failed}
    <!-- an exit keeps the last frame readable behind the note: what the
         process printed before it stopped is the first clue -->
    <div class="term-veil" class:opaque={pane.kind === "status" || pane.kind === "error" || !!progress?.failed}>
      {#if pane.kind === "connecting"}
        {#if pane.text}
          <span class="lamp on-amber blink" aria-hidden="true"></span>
          <span class="term-note">{pane.text}</span>
        {:else}
          <span class="term-note">connecting…</span>
        {/if}
      {:else if pane.kind === "status"}
        <span class="lamp on-amber blink" aria-hidden="true"></span>
        <span class="term-note">{pane.text}</span>
      {:else if pane.kind === "lost"}
        <span class="term-note">lost connection to the host — retrying in {countdown}s</span>
        <button class="key" onclick={retryNow}>retry now</button>
      {:else if pane.kind === "ended"}
        <span class="term-note">{pane.text}</span>
        <button class="key" onclick={restart}>restart</button>
      {:else if pane.kind === "live"}
        <span class="term-note bad" role="alert">{progress?.phase}</span>
        <button class="key" onclick={() => Effect.runSync(Effect.sync(() => { progress = null; term.focus(); }))}>continue to thread</button>
      {:else}
        <span class="term-note bad" role="alert">{pane.text}</span>
        <button class="key" onclick={restart}>retry</button>
      {/if}
      {#if progress}
        <EnvironmentProgressView {progress} waiting={pane.kind === "status"} />
      {/if}
    </div>
  {/if}
</div>
