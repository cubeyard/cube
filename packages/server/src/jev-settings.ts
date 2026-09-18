import fs from "node:fs";
import path from "node:path";

export interface JevStatus {
  configured: boolean;
}

/** Host-owned JEV credential. The browser can observe only its presence. */
export class JevSettings {
  private readonly filename: string;

  constructor(stateDirectory: string) {
    this.filename = path.join(stateDirectory, "jev-key.json");
  }

  status(): JevStatus { return { configured: this.apiKey() !== null }; }

  apiKey(): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, "utf8")) as { apiKey?: unknown };
      return typeof parsed.apiKey === "string" && parsed.apiKey.length > 0 ? parsed.apiKey : null;
    } catch { return null; }
  }

  save(apiKey: string): void {
    const key = apiKey.trim();
    if (!key || key.length > 10_000) throw new Error("JEV key is required and must be at most 10000 characters");
    const directory = path.dirname(this.filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ apiKey: key }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filename);
      fs.chmodSync(this.filename, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch { /* Rename normally consumed the temporary file. */ }
    }
  }

  remove(): void {
    try { fs.unlinkSync(this.filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
