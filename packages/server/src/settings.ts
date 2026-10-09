/** The host's settings, kept in `<CUBED_STATE>/settings.json`: OptChat's
 * compactor model (the settings page) and the user's skill sources
 * (`PUT /api/settings/skills`, docs/skills.md). */
import fs from "node:fs";
import path from "node:path";
import * as Schema from "effect/Schema";
import type { ModelSelection } from "./models.ts";
import { NO_SKILLS_CONFIG, parseSkillsConfig, type SkillsConfig } from "./skills.ts";

const Selection = Schema.Struct({ provider: Schema.String, id: Schema.String });
const isFile = Schema.is(Schema.Struct({ version: Schema.Literal(1), optchat: Schema.Struct({ compactor: Schema.NullOr(Selection) }), skills: Schema.optional(Schema.Unknown) }));

export interface Settings {
  /** null: the compactor follows the chat's model. */
  compactor: ModelSelection | null;
  skills: SkillsConfig;
}

export class SettingsStore {
  private current: Settings = { compactor: null, skills: NO_SKILLS_CONFIG };
  /** Why the file could not be read; the defaults apply until a save replaces it. */
  error: string | null = null;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = `${path.basename(file)} could not be read (${(error as Error).message}); the defaults apply`;
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!isFile(parsed)) { this.error = `${path.basename(file)} could not be read; the defaults apply until a choice is saved`; return; }
    const compactor = parsed.optchat.compactor;
    let skills = NO_SKILLS_CONFIG;
    try { if (parsed.skills !== undefined) skills = parseSkillsConfig(parsed.skills); }
    catch (error) { this.error = `${path.basename(file)}: ${(error as Error).message}; only the default skills apply until skills are saved`; }
    this.current = { compactor: compactor && { provider: compactor.provider, id: compactor.id }, skills };
  }

  get(): Settings { return structuredClone(this.current); }

  setCompactor(compactor: ModelSelection | null): Settings {
    return this.save({ ...this.current, compactor: compactor && { provider: compactor.provider, id: compactor.id } });
  }

  setSkills(skills: SkillsConfig): Settings { return this.save({ ...this.current, skills: structuredClone(skills) }); }

  /** Written whole and renamed into place, then applied. */
  private save(next: Settings): Settings {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    // A left-over temporary file would keep its own mode through the rename.
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, optchat: { compactor: next.compactor },
      ...next.skills.sources.length || next.skills.disabled.length || next.skills.defaultCommit ? { skills: next.skills } : {} }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.current = next;
    this.error = null;
    return this.get();
  }
}

/** `GET /api/settings`: the saved choice beside what is in effect. */
export interface SettingsView {
  /** The chat's own model; null until the chat is open. */
  chat: ModelSelection | null;
  /** The models a compactor may be chosen from: those a connected provider
   * offers; null when they could not be listed (`error` says why). */
  models: ModelSelection[] | null;
  /** Why settings.json could not be read, if it could not. */
  error: string | null;
  compactor: {
    saved: ModelSelection | null;
    /** CUBED_OPTCHAT_COMPACTOR when cubed was started with it: no longer read. */
    ignored: string | null;
    /** What decides the model the next node is written with. */
    source: "saved" | "chat";
    /** That model; null while the chat's model is not known. */
    model: ModelSelection | null;
    /** The saved model, when no provider offers it now and the chat's is used instead. */
    unavailable: ModelSelection | null;
  };
}
