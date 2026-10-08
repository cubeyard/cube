<script lang="ts">
  import AuthBadge from "./AuthBadge.svelte";
  import Wordmark from "./Wordmark.svelte";

  let { section }: { section: "chat" | "threads" | "artifacts" | "projects" | "models" | "system" | "settings" } = $props();
  let nav: HTMLElement;
  // A phone's row of destinations scrolls; the current one is kept in sight.
  $effect(() => {
    void section;
    void document.fonts.ready.then(() => {
      if (nav && nav.scrollWidth > nav.clientWidth) nav.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
</script>

<header>
  <Wordmark href="#/chat" />
  <nav aria-label="main" bind:this={nav}>
    <a href="#/chat" class:active={section === "chat"} title="chat · press g then c">chat</a>
    <a href="#/threads" class:active={section === "threads"} title="threads · press g then t">threads</a>
    <a href="#/artifacts" class="nav-artifacts" class:active={section === "artifacts"}>artifacts</a>
    <a href="#/projects" class:active={section === "projects"} title="projects · press g then p">projects</a>
    <a href="#/models" class:active={section === "models"}>models</a>
    <a href="#/system" class:active={section === "system"}>system</a>
    <a href="#/settings" class="nav-settings" class:active={section === "settings"}>settings</a>
  </nav>
  <span class="spacer"></span>
  <AuthBadge />
</header>
