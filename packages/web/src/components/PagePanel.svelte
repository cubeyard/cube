<script lang="ts" module>
  import { getContext } from "svelte";

  const KEY = Symbol("page-panel");
  /** The panel a page sits in, if any: its header offers the way back to the chat. */
  export const pagePanel = () => getContext<{ close: () => void } | undefined>(KEY);
</script>

<script lang="ts">
  import { onMount, setContext, type Snippet } from "svelte";

  // The chat is home and stays mounted underneath; every other place
  // (threads, a thread, artifacts, projects, settings) opens over it in one
  // modal panel: a sheet from the right on a wide screen, the whole screen
  // on a phone. Its address is the place's own (deep links and back work);
  // closing it goes to the chat. Escape closes it unless a field has the
  // focus (a draft is never lost to Escape); a press on the chat beside it
  // closes it too. Focus goes back to where it was in the chat.
  let { label, children }: { label: string; children: Snippet } = $props();

  let dialog = $state<HTMLDialogElement>();
  // A press closes it only if it began on the backdrop too: a selection
  // dragged out of the panel ends there without meaning to leave.
  let downOnBackdrop = false;
  const close = () => { location.hash = "#/chat"; };
  setContext(KEY, { close });

  const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
  function onCancel(event: Event): void {
    event.preventDefault();
    if (document.activeElement?.closest(EDITABLE)) return;
    close();
  }

  onMount(() => {
    // What had focus in the chat (a link, an index row's key, the composer):
    // it has it again once the panel goes. The dialog may already be out of
    // the page when this runs, so the browser's own return cannot be relied on.
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected && !opener.closest("dialog:not([open])")) opener.focus({ preventScroll: true });
    };
  });
</script>

<!-- a press on the backdrop (the chat beside the panel) closes it; escape and the close key do too -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="page-panel" bind:this={dialog} aria-label={label} oncancel={onCancel}
  onpointerdown={(event) => { downOnBackdrop = event.target === dialog; }}
  onclick={(event) => { if (downOnBackdrop && event.target === dialog) close(); downOnBackdrop = false; }}>
  {@render children()}
</dialog>
