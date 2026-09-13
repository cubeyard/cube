/** Durable operator admission, resolved lazily: missing configuration, native
 * addon or node contact must not prevent conversations from starting. */
import type { Duplex } from "node:stream";
import type { Registry } from "./registry.ts";
import { ExecutionNodeError, type ExecutionNodeClient, type NodeContact } from "./execution-node-contract.ts";
import type { HostExecSpec, IrohExecutionNodeClient } from "./iroh-node.ts";

export class AdmittedHostNode implements ExecutionNodeClient {
  readonly locality = "remote" as const;
  readonly nodeId: string;
  readonly binding: Readonly<{ nodeId: string; environmentId: number; threadId: string }>;
  private client?: IrohExecutionNodeClient;
  private failed = false;
  private readonly registry: Registry;
  private readonly admission: ReturnType<Registry["hostNodeAdmissions"]>[number];
  constructor(registry: Registry, admission: ReturnType<Registry["hostNodeAdmissions"]>[number]) {
    this.registry = registry; this.admission = { ...admission };
    this.nodeId = admission.nodeId;
    this.binding = Object.freeze({ nodeId: admission.nodeId, environmentId: admission.environmentId, threadId: admission.threadId });
  }
  get contact(): NodeContact { return this.failed ? "unavailable" : this.client?.contact ?? "unobserved"; }
  private async load() {
    try {
      if (!this.client) {
        const { IrohExecutionNodeClient } = await import("./iroh-node.ts");
        const client = new IrohExecutionNodeClient({ configPath: this.admission.configPath, configHash: this.admission.configHash,
          observe: (id, observation) => this.registry.observeEnvironment(id, observation) });
        if (client.binding.nodeId !== this.nodeId || client.binding.environmentId !== this.binding.environmentId
          || client.binding.threadId !== this.binding.threadId) throw new ExecutionNodeError("WRONG_NODE");
        this.client ??= client;
      }
      this.failed = false;
      return this.client;
    } catch (error) {
      this.failed = true;
      if (error instanceof ExecutionNodeError) throw error;
      throw new ExecutionNodeError("NODE_UNAVAILABLE");
    }
  }
  async status(id: number) { return (await this.load()).status(id); }
  async check(id: number) { return (await this.load()).check(id); }
  async wake(_id: number): Promise<void> { throw new ExecutionNodeError("OPERATION_UNSUPPORTED"); }
  async sleep(_id: number): Promise<void> { throw new ExecutionNodeError("OPERATION_UNSUPPORTED"); }
  async openPortal(_id: number, _port: number): Promise<Duplex> { throw new ExecutionNodeError("OPERATION_UNSUPPORTED"); }
  async prepareExec(id: number, spec: HostExecSpec, signal?: AbortSignal) { return (await this.load()).prepareExec(id, spec, signal); }
  async submitExec(id: number, operationId: string, signal?: AbortSignal) { return (await this.load()).submitExec(id, operationId, signal); }
  async operation(id: number, operationId: string, signal?: AbortSignal) { return (await this.load()).operation(id, operationId, signal); }
}
