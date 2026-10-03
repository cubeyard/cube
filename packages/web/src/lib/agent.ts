/** Agent wording shared by thread creation and the thread view. */
import type { ModelSelection } from "./types.ts";

/** The provider id of Claude Code models; choosing one makes a claude · max thread. */
export const CLAUDE_PROVIDER = "claude-code";

export const isClaude = (model: Pick<ModelSelection, "provider"> | null | undefined) => model?.provider === CLAUDE_PROVIDER;

/** How a model menu names a provider. */
export const providerLabel = (provider: string) => (provider === CLAUDE_PROVIDER ? "claude · max" : provider);

/** The honest difference from pi, said where a claude thread starts and runs. */
export const CLAUDE_DURABILITY =
  "claude code runs this thread with your own max login on this host. it is less durable than pi: a turn cut off by a host restart is not continued, though no tool call runs twice.";
