import fs from "node:fs";
import path from "node:path";

/** One first-run decision per VM, independent of GitHub's login state. */
export function isOnboardingComplete(file: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))?.completed === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function completeOnboarding(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, '{"completed":true}\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
