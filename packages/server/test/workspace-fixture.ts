/** A workspace for tests that need a chat: a workspace's chat is the only chat there is. */
import { randomUUID } from "node:crypto";
import type { Project, Registry } from "../src/registry.ts";

export function addWorkspace(registry: Registry, name = "demo", id: string = randomUUID()): Project {
  registry.saveProject({ id, name, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  return registry.getProject(id)!;
}
