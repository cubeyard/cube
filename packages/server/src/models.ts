/** Host-only model catalog. Only public model identifiers cross the API. */
import os from "node:os";
import path from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ModelSelection {
  provider: string;
  id: string;
}

export function createModelRuntime() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
}

export function preferredModel(models: ModelSelection[]): ModelSelection | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  return models.find(model => model.provider === settings.getDefaultProvider() && model.id === settings.getDefaultModel()) ?? models[0] ?? null;
}
