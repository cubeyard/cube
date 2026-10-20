/** The Claude Code mod's word that its hooks are in. cubed gives each
 * `claude` child a nonce of its own (CUBE_MOD_NONCE); the mod's last hook,
 * at `session.start`, posts it to the workspace socket (`…/claude-ready`,
 * under the child's lease token). Claude Code runs without a mod it cannot
 * load, and its `init` line names the plugin either way, so this is the
 * one sign cubed has that the mod, not Claude Code, answers the tools: no
 * prompt is written to a child before it. */
import { randomBytes } from "node:crypto";

const waiting = new Map<string, () => void>();

/** A new nonce and a promise that settles when the mod sends it. */
export function expectReady(): { nonce: string; ready: Promise<void>; cancel: () => void } {
  const nonce = randomBytes(32).toString("hex");
  let resolve!: () => void;
  const ready = new Promise<void>(settle => { resolve = settle; });
  waiting.set(nonce, () => { waiting.delete(nonce); resolve(); });
  return { nonce, ready, cancel: () => { waiting.delete(nonce); } };
}

/** True when a child was waiting on this nonce (it is ready now). */
export function markReady(nonce: unknown): boolean {
  const resolve = typeof nonce === "string" ? waiting.get(nonce) : undefined;
  resolve?.();
  return resolve !== undefined;
}
