<script lang="ts">
  import AuthBadge from "./AuthBadge.svelte";
  import Wordmark from "./Wordmark.svelte";

  let { section }: { section: "chat" | "threads" | "artifacts" | "projects" | "models" | "system" } = $props();
</script>

<header>
  <Wordmark href="#/chat" />
  <nav aria-label="main">
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
