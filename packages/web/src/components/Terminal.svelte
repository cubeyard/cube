<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { terminalUrl } from "../lib/api.ts";
  import type { TerminalControlFrame } from "../lib/types.ts";

  let { threadId }: { threadId: string } = $props();

  // The pane's own state, shown as a silkscreen overlay on the glass. The
  // conversation itself is pi's — we only narrate the transport.
  type Pane =
    | { kind: "connecting" }
    | { kind: "status"; text: string }
    | { kind: "live" }
    | { kind: "ended"; text: string } // pi exited — restart respawns it
    | { kind: "error"; text: string };
  let pane = $state<Pane>({ kind: "connecting" });

  let host: HTMLElement;
  let term: Terminal;
  let fit: FitAddon;
  let ws: WebSocket | null = null;
  let disposed = false;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (disposed) return;
    pane = { kind: "connecting" };
    // The server replays its scrollback tail on attach — start from a
    // clean frame so a reconnect doesn't stack two copies of the screen.
    term.reset();
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
      if (frame.t === "status") pane = { kind: "status", text: frame.text };
      else if (frame.t === "spawned") {
        pane = { kind: "live" };
        retryDelay = 1000;
        term.focus();
      } else if (frame.t === "exit") {
        final = true;
        pane = { kind: "ended", text: "session ended" };
      } else if (frame.t === "error") {
        final = true;
        pane = { kind: "error", text: frame.text };
      }
    };
    socket.onopen = () => {
      // A process may already be live server-side; the replay starts
      // flowing immediately either way. Treat open as live unless a
      // status/error frame says otherwise.
      if (pane.kind === "connecting") pane = { kind: "live" };
      term.focus();
    };
    socket.onclose = () => {
      if (ws !== socket || disposed || final) return;
      pane = { kind: "connecting" };
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };
  }

  function restart(): void {
    retryDelay = 1000;
    connect();
  }

  /** Submit a complete prompt through the same live TUI connection as
   * keyboard input. Bracketed paste keeps the long multi-line Ship prompt
   * inside pi's editor until the final carriage return submits it. */
  export function submitPrompt(text: string): boolean {
    if (pane.kind !== "live" || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ t: "input", data: `\x1b[200~${text}\x1b[201~\r` }));
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
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data }));
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

<div class="term-pane">
  <div class="term-host" bind:this={host}></div>
  {#if pane.kind !== "live"}
    <div class="term-veil" class:opaque={pane.kind !== "connecting"}>
      {#if pane.kind === "connecting"}
        <span class="term-note">connecting…</span>
      {:else if pane.kind === "status"}
        <span class="lamp on-amber blink" aria-hidden="true"></span>
        <span class="term-note">{pane.text}</span>
      {:else if pane.kind === "ended"}
        <span class="term-note">{pane.text}</span>
        <button class="key" onclick={restart}>resume</button>
      {:else}
        <span class="term-note bad">{pane.text}</span>
        <button class="key" onclick={restart}>retry</button>
      {/if}
    </div>
  {/if}
</div>
