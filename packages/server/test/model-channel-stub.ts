/** Test only: the model channel for a fake `claude` that calls no model
 * (or one a check points elsewhere): cubed's own ClaudeModelChannel with a
 * stand-in token and a base URL nothing serves (port 9, discard). */
import { claudeSecret } from "../src/egress-policy.ts";
import { ClaudeModelChannel } from "../src/model-channel.ts";

export const STUB_CLAUDE_TOKEN = "stub-claude-token-not-sent-anywhere";

export function stubModelChannel(): ClaudeModelChannel {
  return new ClaudeModelChannel({ secret: claudeSecret({ CLAUDE_CODE_OAUTH_TOKEN: STUB_CLAUDE_TOKEN }), address: () => "127.0.0.1:9" });
}
