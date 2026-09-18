export const CUBED_VERSION = process.env.CUBED_VERSION?.trim() || "dev";
export const CUBED_COMMIT = process.env.CUBED_COMMIT?.trim() || "unknown";
export const CUBED_STATE_SCHEMA = 100;

export function versionInfo() {
  return { version: CUBED_VERSION, commit: CUBED_COMMIT, stateSchema: CUBED_STATE_SCHEMA };
}
