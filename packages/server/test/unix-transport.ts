/** The Claude Code mod's workspace transport for Node tests: one HTTP
 * exchange over cubed's workspace socket, as `$.http.fetch` makes it with
 * `socketPath` inside Claude Code. */
import http from "node:http";
import type { WorkspaceTransport } from "../../claude-mod/hooks/workspace.ts";

export function unixTransport(socketPath: string): WorkspaceTransport {
  return request => new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath, path: request.path, method: request.method, headers: request.headers }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}
