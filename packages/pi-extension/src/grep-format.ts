/**
 * Turn the guest helper's grep result into a pi grep tool result (same
 * shape/notices as pi's gondolin example: byte-limit head truncation plus
 * bracketed notices for match/line limits).
 */
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type GrepToolDetails,
} from "@earendil-works/pi-coding-agent";

import type { GrepResult } from "./cube-fs.ts";

export interface GrepToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: GrepToolDetails | undefined;
}

export function formatGrepResult(result: GrepResult): GrepToolResult {
  if (result.matchCount === 0) {
    return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  }

  const truncation = truncateHead(result.lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  let output = truncation.content;

  if (result.matchLimitReached) {
    details.matchLimitReached = result.limit;
    notices.push(`${result.limit} matches limit reached`);
  }
  if (result.linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
