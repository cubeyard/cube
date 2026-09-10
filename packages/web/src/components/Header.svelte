<script lang="ts">
  import AuthBadge from "./AuthBadge.svelte";
  import Wordmark from "./Wordmark.svelte";

  let { section }: { section: "threads" | "projects" } = $props();
</script>

<header>
  <Wordmark href="#/threads" />
  <nav aria-label="main">
    <a href="#/threads" class:active={section === "threads"} title="threads · press g then t">threads</a>
    <a href="#/projects" class:active={section === "projects"} title="projects · press g then p">projects</a>
  </nav>
  <span class="spacer"></span>
  <AuthBadge />
</header>
