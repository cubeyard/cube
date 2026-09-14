/** Host-only model catalog. Only public model identifiers cross the API. */
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ModelSelection {
  provider: string;
  id: string;
}

export async function availableModels() {
  const cwd = process.cwd();
  const agentDir = path.join(os.homedir(), ".pi/agent");
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const models = (await runtime.getAvailable()).map(({ provider, id }) => ({ provider, id }));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Let Pi resolve its default without duplicating its provider priorities.
  // Deliberately do not reload this empty loader: catalog reads load no
  // extensions, repository context, skills, or tools and send no prompt.
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: new DefaultResourceLoader({ cwd, agentDir, settingsManager }),
    tools: [],
  });
  try {
    const model = session.model;
    const defaultModel = models.find((available) => available.provider === model?.provider && available.id === model?.id) ?? null;
    return { models, defaultModel };
  } finally {
    session.dispose();
  }
}
