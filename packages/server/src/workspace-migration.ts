/** From one chat to one chat per workspace, once, when cubed starts.
 *
 * Before workspaces cubed had one chat store, `<state>/optchat`. Each
 * project is now a workspace with its own, `<state>/workspaces/<id>/chat`,
 * and every workspace that existed then starts with a copy of the old chat:
 * its whole log, summaries and images. The original is only read (once
 * more opened as a chat if a turn was under way, to let it end) and stays
 * where it is, as the backup.
 *
 * `workspaces/migration.json` is the record. It names the workspaces that
 * get a copy, written before the first copy, so a workspace made later
 * starts empty however often the migration is tried. A copy is made in a
 * temporary directory, bound to its workspace there, and renamed into place
 * last: a directory at the final path is a finished copy, and a temporary
 * one a crash left is deleted. Every step reads what exists and does only
 * what is missing, so a run after a crash at any point ends where an
 * uninterrupted one does (docs/workspaces.md). */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { ArtifactStore } from "./artifacts.ts";
import { openStorage } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { settleCompactor, SettingsDoc, storeIdle, storeUsage } from "./optchat.ts";
import { RESTART_LIMIT } from "./pi-sends.ts";
import type { Registry } from "./registry.ts";
import type { OptChatUsage } from "./usage-service.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("workspaces");

/** How long the chat before workspaces may take to end its turn and queue. */
export const MIGRATION_IDLE_MS = 5 * 60_000;
/** What besides `pi.sqlite` makes a chat store: its images, the user's instructions, the skills baseline. */
const STORE_FILES = ["media", "AGENTS.md", "skills-section.json"];
const COPYING = ".chat-copy-";

export type MigrationRecord = {
  version: 1;
  state: "copying" | "done";
  startedAt: number;
  finishedAt?: number;
  /** The workspaces that existed when the migration began: each gets a copy. */
  workspaces: string[];
  /** The chat before workspaces: its identity and what it had used when it
   * was copied, reported once as usage before workspaces. null: there was none. */
  source: { identity: string; usage: OptChatUsage } | null;
  /** Artifacts of the old chat that belonged to no project, deleted; and the copy of artifacts.sqlite taken before. */
  deletedArtifacts?: number;
  artifactsBackup?: string;
};

/** The chat before workspaces was still working when the wait ran out. */
export class MigrationNotIdle extends Error {}

export const workspacesDirectory = (state: string) => path.join(state, "workspaces");
/** A workspace's chat store. */
export const chatDirectory = (state: string, workspace: string) => path.join(workspacesDirectory(state), workspace, "chat");
const recordFile = (state: string) => path.join(workspacesDirectory(state), "migration.json");

export function migrationRecord(state: string): MigrationRecord | null {
  try { return JSON.parse(fs.readFileSync(recordFile(state), "utf8")) as MigrationRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function writeRecord(state: string, record: MigrationRecord): void {
  fs.mkdirSync(workspacesDirectory(state), { recursive: true, mode: 0o700 });
  const file = recordFile(state), temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}

/** A store's Harness for the migration: read and written, never resumed, so
 * nothing of the chat runs. */
async function openStore(directory: string, models: Models): Promise<Harness> {
  const storage = await openStorage(path.join(directory, "pi.sqlite"));
  try { return await Harness.open(storage, { models, registry: createRegistry(), settings: { restartLimit: RESTART_LIMIT } }, context); }
  catch (error) { await storage.close(context).catch(() => {}); throw error; }
}

/** Copies the store at `from` into the new directory `to`: the database by
 * SQLite's backup (a consistent image whatever its WAL holds, the source
 * only read), then its files. */
async function copyStore(from: string, to: string): Promise<void> {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(path.join(from, "pi.sqlite"), { readOnly: true });
  try { await backup(source, path.join(to, "pi.sqlite")); }
  finally { source.close(); }
  for (const name of STORE_FILES) {
    if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
  }
}

/** One workspace's copy, made beside its final place and renamed there
 * once it is bound. Answers the source as the copy held it. */
async function copyFor(options: { original: string; target: string; workspace: string; threads: ReadonlySet<string>; models: Models; now: number }): Promise<NonNullable<MigrationRecord["source"]>> {
  const temporary = path.join(path.dirname(options.target), `${COPYING}${randomUUID()}`);
  try {
    await copyStore(options.original, temporary);
    const harness = await openStore(temporary, options.models);
    let source: NonNullable<MigrationRecord["source"]>;
    try {
      if (!await storeIdle(harness)) throw new MigrationNotIdle("the chat before workspaces has a message waiting or a turn under way");
      // A summary request that was out when the old chat's process stopped
      // is counted here, in the copy, before the usage every copy starts
      // from is read: it is part of the past, once, and no copy counts it
      // again at its first open. (A chat request out at a stop leaves a task
      // that is not ended, so such a store is not idle and is settled by
      // opening the original.)
      await settleCompactor(harness);
      const usage = await storeUsage(harness);
      source = await harness.commit(async tx => {
        const settings = await tx.doc(SettingsDoc);
        if (settings.workspace) throw new Error(`the chat before workspaces is bound to workspace ${settings.workspace}; not copied`);
        const identity = `optchat-${settings.cache}`;
        settings.workspace = options.workspace;
        // A new identity: the copies' request keys (artifacts, hooks) and
        // prompt caches never meet.
        settings.cache = randomUUID();
        settings.copiedFrom = { identity, at: options.now, usage: usage as unknown as JsonRepresentation<OptChatUsage> };
        // Only this workspace's threads are this chat's: it watches, tells
        // and reports those, so a run reports to one chat.
        for (const id of Object.keys(settings.threads)) if (!options.threads.has(id)) delete settings.threads[id];
        // Replay records of archive calls: none is under way in an idle store.
        delete settings.archives;
        return { identity, usage };
      }, context);
    } finally { await harness.close(context).catch(() => {}); }
    fs.renameSync(temporary, options.target);
    return source;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export type MigrationOptions = {
  state: string;
  registry: Pick<Registry, "listProjects" | "listThreads">;
  models: Models;
  artifacts: Pick<ArtifactStore, "countUnownedChatArtifacts" | "deleteUnownedChatArtifacts" | "backupTo">;
  /** Opens the chat before workspaces once more, lets its turn and queue
   * end, and closes it; throws MigrationNotIdle when that takes too long. */
  settle: (directory: string) => Promise<void>;
  now?: () => number;
};

/** Brings the installation to one chat per workspace; a no-op once done. */
export async function migrateWorkspaces(options: MigrationOptions): Promise<MigrationRecord> {
  const { state } = options;
  const now = options.now ?? Date.now;
  let record = migrationRecord(state);
  if (record?.state === "done") return record;
  const original = path.join(state, "optchat");
  if (!fs.existsSync(path.join(original, "pi.sqlite"))) {
    // No chat before workspaces: every workspace's chat starts empty.
    record = { version: 1, state: "done", startedAt: now(), finishedAt: now(), workspaces: [], source: null };
    writeRecord(state, record);
    return record;
  }
  if (!record) {
    record = { version: 1, state: "copying", startedAt: now(), workspaces: options.registry.listProjects().map(project => project.id), source: null };
    writeRecord(state, record);
    log.info("workspaces begin: each existing project gets a copy of the chat", { workspaces: record.workspaces.length });
  }
  const existing = new Set(options.registry.listProjects().map(project => project.id));
  const sweep = (directory: string) => { for (const name of fs.readdirSync(directory)) if (name.startsWith(COPYING)) fs.rmSync(path.join(directory, name), { recursive: true, force: true }); };
  sweep(workspacesDirectory(state));
  let settled = false;
  const copy = async (target: string, workspace: string, threads: ReadonlySet<string>) => {
    const attempt = () => copyFor({ original, target, workspace, threads, models: options.models, now: now() });
    try { return await attempt(); }
    catch (error) {
      if (!(error instanceof MigrationNotIdle) || settled) throw error;
      settled = true;
      await options.settle(original);
      return attempt();
    }
  };
  for (const workspace of record.workspaces) {
    // A workspace deleted since the plan was written needs no chat.
    if (!existing.has(workspace)) continue;
    const parent = path.join(workspacesDirectory(state), workspace);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    sweep(parent);
    const target = chatDirectory(state, workspace);
    if (fs.existsSync(target)) continue;
    const threads = new Set(options.registry.listThreads().filter(thread => thread.projectId === workspace).map(thread => thread.id));
    const started = performance.now();
    record.source = await copy(target, workspace, threads);
    log.info("chat copied to its workspace", { workspace, threads: threads.size, ms: Math.round(performance.now() - started) });
  }
  if (!record.source) {
    // No workspace took a copy: the old chat's usage is still read, for the report.
    const scratch = path.join(workspacesDirectory(state), `${COPYING}source`);
    fs.rmSync(scratch, { recursive: true, force: true });
    try { record.source = await copy(scratch, "", new Set()); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  // The old chat's artifacts for no project have no workspace to belong to.
  // The copy of the file is taken first and never replaced: it is the state
  // before the deletion, whichever run made it.
  if (options.artifacts.countUnownedChatArtifacts() > 0) {
    const saved = path.join(state, "artifacts.sqlite.before-workspaces");
    if (!fs.existsSync(saved)) options.artifacts.backupTo(saved);
    record.artifactsBackup = saved;
    record.deletedArtifacts = (record.deletedArtifacts ?? 0) + options.artifacts.deleteUnownedChatArtifacts();
    log.info("the old chat's artifacts without a project deleted", { artifacts: record.deletedArtifacts, backup: saved });
  }
  record = { ...record, state: "done", finishedAt: now() };
  writeRecord(state, record);
  log.info("workspaces ready: one chat each", { workspaces: record.workspaces.length });
  return record;
}
