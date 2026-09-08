<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    section,
    onNewThread,
  }: {
    section: "threads" | "projects";
    onNewThread?: () => void;
  } = $props();
</script>

<header>
  <a class="name" href="#/threads">
    <span class="glyph" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <path d="M12 2 21 7 V17 L12 22 3 17 V7 Z" />
        <path d="M3 7 L12 12 21 7 M12 12 V22" />
      </svg>
    </span>
    cube
  </a>
  <nav aria-label="main">
    <a href="#/threads" class:active={section === "threads"}>threads</a>
    <a href="#/projects" class:active={section === "projects"}>projects</a>
  </nav>
  <span class="spacer"></span>
  {#if onNewThread}
    <button class="key" onclick={onNewThread}><Icon name="plus" size={13} />new thread</button>
  {/if}
</header>
