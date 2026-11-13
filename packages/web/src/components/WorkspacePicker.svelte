<script lang="ts">
  import { onMount } from "svelte";
  import { chosenWorkspace, chooseWorkspace, fetchWorkspaces } from "../lib/api.ts";

  // Which workspace's chat this page shows. A workspace has one chat, and
  // cubed keeps no choice per browser: the page remembers one, and a change
  // mounts the chat page anew for that chat. Shown only when there is a choice.
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  const chosen = chosenWorkspace();

  onMount(async () => {
    try { workspaces = (await fetchWorkspaces()).filter(workspace => !workspace.archivedAt).sort((a, b) => a.createdAt - b.createdAt); }
    catch { return; }
    // None chosen yet, or the chosen one is gone or archived: the oldest.
    if (workspaces.length > 1 && !workspaces.some(workspace => workspace.id === chosen)) chooseWorkspace(workspaces[0]!.id);
    else if (workspaces.length <= 1 && chosen) chooseWorkspace(null);
  });
</script>

{#if workspaces.length > 1}
  <div class="strip-note">
    <label class="strip-note-text">workspace
      <select aria-label="workspace" value={chosen} onchange={(event) => chooseWorkspace(event.currentTarget.value)}>
        {#each workspaces as workspace (workspace.id)}<option value={workspace.id}>{workspace.name}</option>{/each}
      </select>
    </label>
  </div>
{/if}
