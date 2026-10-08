/** The host's settings chosen in the UI, kept in `<CUBED_STATE>/settings.json`.
 * Only what the settings page offers is here: OptChat's compactor model. An
 * environment variable set for cubed still wins over a saved choice. */
import fs from "node:fs";
import path from "node:path";
import * as Schema from "effect/Schema";
import type { ModelSelection } from "./models.ts";

const Selection = Schema.Struct({ provider: Schema.String, id: Schema.String });
const isFile = Schema.is(Schema.Struct({ version: Schema.Literal(1), optchat: Schema.Struct({ compactor: Schema.NullOr(Selection) }) }));

export interface Settings {
  /** null: the compactor follows the chat's model. */
  compactor: ModelSelection | null;
}

export class SettingsStore {
  private current: Settings = { compactor: null };
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
    this.current = { compactor: compactor && { provider: compactor.provider, id: compactor.id } };
  }

  get(): Settings { return { compactor: this.current.compactor && { ...this.current.compactor } }; }

  /** Written whole and renamed into place, then applied. */
  setCompactor(compactor: ModelSelection | null): Settings {
    const next = { compactor: compactor && { provider: compactor.provider, id: compactor.id } };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    // A left-over temporary file would keep its own mode through the rename.
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, optchat: { compactor: next.compactor } }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.current = next;
    this.error = null;
    return this.get();
  }
}

/** An environment variable cubed read at startup; `error`: why it cannot be used. */
export interface EnvironmentValue { value: string; error: string | null }

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
    environment: EnvironmentValue | null;
    /** What decides the model the next node is written with. */
    source: "environment" | "saved" | "chat";
    /** That model; null while the chat's model is not known. */
    model: ModelSelection | null;
    /** The saved model, when no provider offers it now and the chat's is used instead. */
    unavailable: ModelSelection | null;
  };
}
