/** The model channel: how a claude-code thread's Claude Code reaches its
 * model. cubed runs `claude` on this host; its model requests go to
 * cube-gateway's loopback listener (`ANTHROPIC_BASE_URL`, with the thread
 * in the path), never straight to Anthropic, and it holds a placeholder
 * (`CLAUDE_CODE_OAUTH_TOKEN=cube_ph_claude_…`) instead of the host's
 * token. The gateway asks cubed's policy, which allows a request only with
 * the placeholder of the thread the path names, and substitutes the token
 * from `claude setup-token` (egress-policy.ts `claudeSecret`). There is no
 * fallback: without the listener or the token a turn fails before Claude
 * Code starts. */
import { newPlaceholder, type ModelSecrets, type SecretSource, CLAUDE_TOKEN_MISSING } from "./egress-policy.ts";

export class ModelChannelUnavailable extends Error {
  constructor(reason: string) { super(`claude code cannot reach its model: ${reason}`); this.name = "ModelChannelUnavailable"; }
}

/** What ClaudeAgent needs of the channel. */
export interface ModelChannel {
  /** The child's variables for the thread: the base URL and its
   * placeholder. Throws ModelChannelUnavailable. */
  environment(threadId: string): { ANTHROPIC_BASE_URL: string; CLAUDE_CODE_OAUTH_TOKEN: string };
  /** The thread's Claude Code is gone: its placeholder stops working. */
  release(threadId: string): void;
  /** Settles once the channel is up or has said why not (a starting gateway). */
  ready(): Promise<void>;
  /** Whether the host has the token the channel substitutes. */
  readonly configured: boolean;
}

export class ClaudeModelChannel implements ModelChannel, ModelSecrets {
  readonly secret: SecretSource;
  private readonly isConfigured: () => boolean;
  private readonly address: () => string | null;
  private readonly unavailable: () => string | null;
  private readonly started: () => Promise<unknown>;
  private readonly placeholders = new Map<string, string>();

  constructor(options: {
    secret: SecretSource & { configured(): boolean };
    /** The gateway's model listener (`127.0.0.1:PORT`), also while it restarts on the same port. */
    address: () => string | null;
    /** Why the gateway is not running, if it is not. */
    unavailable?: () => string | null;
    /** Waits for the gateway's first ready line. */
    started?: () => Promise<unknown>;
  }) {
    this.secret = options.secret;
    this.isConfigured = () => options.secret.configured();
    this.address = options.address;
    this.unavailable = options.unavailable ?? (() => null);
    this.started = options.started ?? (async () => {});
  }

  async ready(): Promise<void> {
    // A gateway that does not start is reported by environment(), as the turn's failure.
    await this.started().catch(() => {});
  }

  environment(threadId: string): { ANTHROPIC_BASE_URL: string; CLAUDE_CODE_OAUTH_TOKEN: string } {
    const address = this.address();
    if (!address) throw new ModelChannelUnavailable(this.unavailable() ?? "cube-gateway's model channel is not running");
    if (!this.isConfigured()) throw new ModelChannelUnavailable(CLAUDE_TOKEN_MISSING);
    let placeholder = this.placeholders.get(threadId);
    if (!placeholder) this.placeholders.set(threadId, placeholder = newPlaceholder(this.secret.name));
    return { ANTHROPIC_BASE_URL: `http://${address}/t/${encodeURIComponent(threadId)}`, CLAUDE_CODE_OAUTH_TOKEN: placeholder };
  }

  release(threadId: string): void { this.placeholders.delete(threadId); }

  get configured(): boolean { return this.isConfigured(); }

  placeholder(threadId: string): string | null { return this.placeholders.get(threadId) ?? null; }
}
