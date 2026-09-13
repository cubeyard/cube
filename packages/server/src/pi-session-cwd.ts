/** pi 0.85.1's CLI reopens sessions using the historical header cwd, even
 * when launched elsewhere. Bind its PUBLIC open(cwdOverride) API before the
 * CLI starts. This preserves the session bytes/id and also covers /resume.
 * Keep this compatibility shim under the real-CLI regression test. */
import path from "node:path";
import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const cwd = process.env.CUBE_AGENT_CWD;
if (!cwd || !path.isAbsolute(cwd) || path.resolve(process.cwd()) !== path.resolve(cwd) || !fs.lstatSync(cwd).isDirectory()) {
  throw new Error("invalid control-plane agent runtime directory");
}
const open = SessionManager.open;
SessionManager.open = (file, sessionDir) => open.call(SessionManager, file, sessionDir, cwd);
