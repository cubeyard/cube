<script lang="ts">
  import AuthBadge from "./AuthBadge.svelte";
  import Icon from "./Icon.svelte";
  import Wordmark from "./Wordmark.svelte";

  let { section }: { section: "chat" | "threads" | "artifacts" | "projects" | "models" | "system" } = $props();

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
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} onhashchange={() => closeMenu()} />

<header class="main-header" bind:this={header} class:menu-open={menuOpen}>
  <Wordmark href="#/chat" />
  <button class="nav-menu-key" bind:this={menuKey} aria-expanded={menuOpen} aria-controls="main-nav" onclick={() => (menuOpen = !menuOpen)}>
    <span class="sr-only">menu, current page:</span>{section}<Icon name="chevron" size={12} />
  </button>
  <!-- a choice closes the menu, the current page's link included -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <nav id="main-nav" aria-label="main" onclick={(event) => { if ((event.target as Element).closest("a")) closeMenu(); }}>
    <a href="#/chat" class:active={section === "chat"} title="chat · press g then c">chat</a>
    <a href="#/threads" class:active={section === "threads"} title="threads · press g then t">threads</a>
    <a href="#/artifacts" class="nav-artifacts" class:active={section === "artifacts"}>artifacts</a>
    <a href="#/projects" class:active={section === "projects"} title="projects · press g then p">projects</a>
    <a href="#/models" class:active={section === "models"}>models</a>
    <a href="#/system" class:active={section === "system"}>system</a>
  </nav>
  <span class="spacer"></span>
  <AuthBadge />
</header>
