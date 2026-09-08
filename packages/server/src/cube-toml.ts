/**
 * Minimal reader for the `.cube/cube.toml` keys cubed needs:
 *
 *   [wake]
 *   hooks = [
 *     "docker compose up -d",   # run in /workspace as dev, in order
 *   ]
 *
 *   [services.web]
 *   command = "pnpm dev --host 0.0.0.0 --port $PORT"  # must listen on $PORT
 *   cwd = "app"            # relative to /workspace (default ".")
 *   port = 3000            # optional; omitted = cubed assigns one
 *   health = "/healthz"    # optional; GET 2xx/3xx = ready, else TCP accept
 *   [services.web.env]
 *   API_MODE = "development"
 *
 * This is deliberately NOT a TOML parser (no dep, no scope creep): only
 * double-quoted basic strings (`\\`, `\"`, `\n`, `\t` escapes), bare
 * integers, `#` comments, and the sections above are supported. Anything
 * unexpected is a parse error — the caller treats that as a failed
 * wake/ensure, never a bricked cube. The file lives in the workspace, i.e.
 * it is agent-writable by design: hooks and services run INSIDE the cube,
 * so a malicious entry gains nothing the agent's bash tool did not already
 * have.
 */
import fs from "node:fs";
import path from "node:path";

/** One `[services.<name>]` declaration. */
export interface ServiceSpec {
  name: string;
  command: string;
  /** Working directory relative to /workspace (default "."). */
  cwd: string;
  /** Fixed in-cube port; null = cubed assigns (and persists) one. */
  port: number | null;
  /** HTTP readiness path; null = plain TCP-accept readiness. */
  health: string | null;
  env: Record<string, string>;
}

export interface CubeConfig {
  wakeHooks: string[];
  services: ServiceSpec[];
}

/** Also the portal hostname label piece: `<service>--<cube>` must be a
 * clean DNS label, so no leading/trailing hyphen and no `--` inside. */
export const SERVICE_NAME_RE = /^[a-z](?:-?[a-z0-9])*$/;
const SERVICE_NAME_MAX = 20;

export function parseCubeToml(toml: string): CubeConfig {
  return { wakeHooks: parseWakeHooks(toml), services: parseServices(toml) };
}

/** Config for a cube, read host-side from `<workspace>/.cube/cube.toml`. */
export function readCubeConfig(workspacePath: string): CubeConfig {
  const file = path.join(workspacePath, ".cube", "cube.toml");
  if (!fs.existsSync(file)) return { wakeHooks: [], services: [] };
  return parseCubeToml(fs.readFileSync(file, "utf8"));
}

export function parseWakeHooks(toml: string): string[] {
  const body = sectionBody(toml, "wake");
  if (body === null) return [];
  const array = extractHooksArray(body);
  if (array === null) return [];
  const hooks: string[] = [];
  // Strings out (marked \x00), then the remaining shape must be exactly
  // comma-separated markers with an optional trailing comma — `["a" "b"]`
  // and stray tokens are errors, not silently-accepted variants.
  const marked = array.replace(/"((?:[^"\\\n]|\\.)*)"/g, (_, raw: string) => {
    hooks.push(unescapeBasic(raw));
    return "\x00";
  });
  if (!/^(\x00(,\x00)*,?)?$/.test(marked.replace(/\s+/g, ""))) {
    throw new Error("cube.toml: wake.hooks must be a comma-separated array of double-quoted strings");
  }
  return hooks;
}

/** Hooks for a cube, read host-side from `<workspace>/.cube/cube.toml`. */
export function readWakeHooks(workspacePath: string): string[] {
  const file = path.join(workspacePath, ".cube", "cube.toml");
  if (!fs.existsSync(file)) return [];
  return parseWakeHooks(fs.readFileSync(file, "utf8"));
}

// ------------------------------------------------------------- [services.*]

const SERVICE_KEYS = new Set(["command", "cwd", "port", "health"]);

export function parseServices(toml: string): ServiceSpec[] {
  const sections = allSections(toml);
  const services = new Map<string, ServiceSpec>();
  for (const section of sections) {
    const match = /^services\.([^.]+)(\.env)?$/.exec(section.name);
    if (!match) {
      if (section.name === "services" || section.name.startsWith("services.")) {
        throw new Error(`cube.toml: unsupported section [${section.name}]`);
      }
      continue;
    }
    const name = match[1]!;
    if (!SERVICE_NAME_RE.test(name) || name.length > SERVICE_NAME_MAX) {
      throw new Error(
        `cube.toml: invalid service name ${JSON.stringify(name)} — need ${SERVICE_NAME_RE}, max ${SERVICE_NAME_MAX} chars`,
      );
    }
    let spec = services.get(name);
    if (!spec) {
      spec = { name, command: "", cwd: ".", port: null, health: null, env: {} };
      services.set(name, spec);
    }
    const pairs = sectionPairs(section.name, section.body);
    if (match[2]) {
      for (const [key, value] of pairs) {
        if (value.kind !== "string") {
          throw new Error(`cube.toml: services.${name}.env.${key} must be a string`);
        }
        spec.env[key] = value.value;
      }
      continue;
    }
    for (const [key, value] of pairs) {
      if (!SERVICE_KEYS.has(key)) {
        throw new Error(`cube.toml: unknown key services.${name}.${key}`);
      }
      if (key === "port") {
        if (value.kind !== "int" || value.value < 1 || value.value > 65535) {
          throw new Error(`cube.toml: services.${name}.port must be an integer in 1-65535`);
        }
        spec.port = value.value;
        continue;
      }
      if (value.kind !== "string") {
        throw new Error(`cube.toml: services.${name}.${key} must be a double-quoted string`);
      }
      if (key === "command") spec.command = value.value;
      else if (key === "health") {
        if (!value.value.startsWith("/")) {
          throw new Error(`cube.toml: services.${name}.health must be a path starting with "/"`);
        }
        spec.health = value.value;
      } else if (key === "cwd") {
        const rel = value.value;
        if (path.posix.isAbsolute(rel) || rel.split("/").includes("..")) {
          // cwd stays inside /workspace: that is the boundary bash already
          // has, and a service must not get a wider one.
          throw new Error(`cube.toml: services.${name}.cwd must be relative, inside the workspace`);
        }
        spec.cwd = rel === "" ? "." : rel;
      }
    }
  }
  for (const spec of services.values()) {
    if (spec.command === "") {
      throw new Error(`cube.toml: services.${spec.name} is missing command`);
    }
  }
  return [...services.values()];
}

type TomlValue = { kind: "string"; value: string } | { kind: "int"; value: number };

/** `key = value` pairs of one section body; strings and integers only. */
function sectionPairs(sectionName: string, body: string): Array<[string, TomlValue]> {
  const pairs: Array<[string, TomlValue]> = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const key = /^\s*([A-Za-z0-9_-]+)\s*=\s*/.exec(line);
    if (!key) throw new Error(`cube.toml: [${sectionName}] has a malformed line: ${line.trim()}`);
    const rest = line.slice(key[0].length);
    if (rest.startsWith('"')) {
      const str = /^"((?:[^"\\\n]|\\.)*)"\s*(?:#.*)?$/.exec(rest);
      if (!str) {
        // Multiline strings/arrays are wake.hooks-only; here a line must
        // close its own value or the config is ambiguous.
        throw new Error(`cube.toml: [${sectionName}].${key[1]} has an unterminated or trailing-junk string`);
      }
      pairs.push([key[1]!, { kind: "string", value: unescapeBasic(str[1]!) }]);
      continue;
    }
    const int = /^(\d+)\s*(?:#.*)?$/.exec(rest);
    if (!int) {
      throw new Error(`cube.toml: [${sectionName}].${key[1]} must be a double-quoted string or integer`);
    }
    pairs.push([key[1]!, { kind: "int", value: Number(int[1]) }]);
  }
  return pairs;
}

interface TomlSection {
  name: string;
  body: string;
}

/** All `[name]` sections with their bodies (top-level keys are ignored). */
function allSections(toml: string): TomlSection[] {
  const sections: TomlSection[] = [];
  const lines = toml.split("\n");
  let current: { name: string; start: number } | null = null;
  const flush = (end: number) => {
    if (current) sections.push({ name: current.name, body: lines.slice(current.start, end).join("\n") });
  };
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(lines[i]!);
    if (!header) continue;
    flush(i);
    current = { name: header[1]!.trim(), start: i + 1 };
  }
  flush(lines.length);
  return sections;
}

/** Text between `[name]` and the next `[section]` header (null = no section). */
function sectionBody(toml: string, name: string): string | null {
  for (const section of allSections(toml)) {
    if (section.name === name) return section.body;
  }
  return null;
}

/** Contents of `hooks = [ ... ]`, comments stripped (null = no key). */
function extractHooksArray(body: string): string | null {
  const key = /(?:^|\n)[ \t]*hooks[ \t]*=[ \t]*/.exec(body);
  if (!key) return null;
  const start = key.index + key[0].length;
  if (body[start] !== "[") {
    // A configured-but-wrong key must complain, not report a clean wake
    // with zero hooks (sol review).
    throw new Error("cube.toml: wake.hooks must be an array ([...])");
  }
  let out = "";
  let inString = false;
  for (let i = start + 1; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += body[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "#") {
      while (i < body.length && body[i] !== "\n") i++;
      out += "\n";
    } else if (c === "]") {
      return out;
    } else {
      out += c;
    }
  }
  throw new Error("cube.toml: unterminated wake.hooks array");
}

function unescapeBasic(raw: string): string {
  return raw.replace(/\\(.)/g, (_, c: string) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === '"' || c === "\\") return c;
    // TOML rejects unknown escapes; silently dropping the backslash would
    // corrupt the configured command instead.
    throw new Error(`cube.toml: unsupported escape \\${c}`);
  });
}
