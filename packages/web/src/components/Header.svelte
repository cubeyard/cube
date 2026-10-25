<script lang="ts">
  import AuthBadge from "./AuthBadge.svelte";
  import Icon from "./Icon.svelte";
  import Wordmark from "./Wordmark.svelte";
  import { pagePanel } from "./PagePanel.svelte";

  // `closeKey`: in the panel over the chat, the row ends with the way back
  // to it (a thread's sidebar leaves it to the thread's own strip).
  let { section, closeKey = true }: { section: "chat" | "threads" | "artifacts" | "projects" | "settings"; closeKey?: boolean } = $props();
  const panel = pagePanel();

  // On a phone the destinations fold behind one key that names the current
  // one; the menu closes on a choice, Escape or a press outside it, and
  // Escape hands focus back to the key. Wider screens show the row as before.
  let menuOpen = $state(false);
  let header: HTMLElement;
  let menuKey: HTMLButtonElement;
  function closeMenu(focusKey = false): void {
    if (!menuOpen) return;
    menuOpen = false;
    if (focusKey) menuKey?.focus();
  }
  function onWindowKeydown(event: KeyboardEvent): void {
    if (menuOpen && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      closeMenu(true);
    }
  }
  function onWindowPointerdown(event: PointerEvent): void {
    if (menuOpen && !header.contains(event.target as Node)) closeMenu();
  }
  // Another page focuses its own heading; the page already open keeps
  // focus on the key rather than on a link that just folded away.
  function onNavClick(event: MouseEvent): void {
    const link = (event.target as Element).closest("a");
    if (link) closeMenu(link.getAttribute("href") === location.hash);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} onhashchange={() => closeMenu()} />

<!-- Tab out of the menu closes it, as a press outside does (the menu key and
     the menu itself keep it; the panel's close key after them does not) -->
<header class="main-header" bind:this={header} class:menu-open={menuOpen}
  onfocusout={(event) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !(menuKey?.contains(next) || header.querySelector("nav")?.contains(next))) closeMenu();
  }}>
  <Wordmark href="#/chat" />
  <button class="nav-menu-key" bind:this={menuKey} aria-expanded={menuOpen} aria-controls="main-nav" onclick={() => (menuOpen = !menuOpen)}>
    <span class="sr-only">menu, current page:</span>{section}<Icon name="chevron" size={12} />
  </button>
  <!-- a choice closes the menu, the current page's link included -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <nav id="main-nav" aria-label="main" onclick={onNavClick}>
    <a href="#/chat" class:active={section === "chat"} title="chat · press g then c">chat</a>
    <a href="#/threads" class:active={section === "threads"} title="threads · press g then t">threads</a>
    <a href="#/artifacts" class="nav-artifacts" class:active={section === "artifacts"}>artifacts</a>
    <a href="#/projects" class:active={section === "projects"} title="projects · press g then p">projects</a>
    <a href="#/settings/providers" class:active={section === "settings"}>settings</a>
  </nav>
  <span class="spacer"></span>
  <AuthBadge />
  {#if panel && closeKey}
    <button class="key icon panel-close" type="button" aria-label="close, back to the chat" title="back to the chat · esc" onclick={panel.close}><Icon name="close" size={14} /></button>
  {/if}
</header>
