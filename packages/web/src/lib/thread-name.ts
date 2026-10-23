import type { ThreadIdentity } from "./types.ts";

/** A thread's name as text, "🦦 calm otter"; empty when it has none. */
export function nameText(identity: ThreadIdentity | null | undefined): string {
  return identity ? `${identity.emoji} ${identity.name}` : "";
}
