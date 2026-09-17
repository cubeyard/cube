/** Transient GUI interaction only. Pi owns credentials, OAuth and persistence. */
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, AuthType, Models } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";

type Prompt = Omit<AuthPrompt, "signal"> & { id: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
export interface LoginView {
  id: string;
  state: "pending" | "connected" | "cancelled" | "error";
  prompt: Prompt | null;
  events: AuthEvent[];
  error: string | null;
}
type Flow = { view: LoginView; controller: AbortController; done: Promise<void>; answer?: (value: string) => void };

export class ModelAuth {
  private readonly flows = new Map<string, Flow>();
  private readonly models: Models;
  constructor(models: Models) { this.models = models; }

  async list() {
    return Promise.all(this.models.getProviders().map(async provider => {
      let connected = false;
      let checkError = false;
      let type: AuthType | undefined;
      try { const auth = await this.models.checkAuth(provider.id, { signal: AbortSignal.timeout(10000) }); connected = !!auth; type = auth?.type; }
      catch { checkError = true; }
      return { id: provider.id, name: provider.name, connected, type, checkError,
        methods: [
          ...(provider.auth.apiKey?.login ? [{ type: "api_key" as const, label: "api key" }] : []),
          ...(provider.auth.oauth ? [{ type: "oauth" as const, label: provider.auth.oauth.loginLabel ?? "log in" }] : []),
        ],
        flow: this.flows.get(provider.id)?.view ?? null,
      };
    }));
  }

  start(providerId: string, type: AuthType): LoginView {
    const provider = this.models.getProvider(providerId);
    if (!provider || !(type === "oauth" ? provider.auth.oauth : type === "api_key" && provider.auth.apiKey?.login)) throw new Error("this login method is not supported by the provider");
    if (this.flows.get(providerId)?.view.state === "pending") throw new Error("finish or cancel the current login first");
    const controller = new AbortController();
    const flow: Flow = { controller, done: Promise.resolve(), view: { id: randomUUID(), state: "pending", prompt: null, events: [], error: null } };
    this.flows.set(providerId, flow);
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
    timeout.unref();
    flow.done = (async () => {
      try {
        // Never retain or return the credential returned by Pi.
        await this.models.login(providerId, type, {
          signal: controller.signal,
          notify: event => { if (!controller.signal.aborted) flow.view.events = [...flow.view.events.filter(previous => previous.type !== event.type), event]; },
          prompt: prompt => new Promise<string>((resolve, reject) => {
            const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
            if (signal.aborted) { reject(new Error("cancelled")); return; }
            const { signal: _signal, ...publicPrompt } = prompt;
            const id = randomUUID();
            flow.view.prompt = { ...publicPrompt, id };
            const finish = () => {
              signal.removeEventListener("abort", abort);
              flow.view.prompt = null; flow.answer = undefined;
            };
            const abort = () => { finish(); reject(new Error("cancelled")); };
            flow.answer = value => { finish(); resolve(value); };
            signal.addEventListener("abort", abort, { once: true });
          }),
        });
        flow.view.state = "connected";
        // Credential commit and network catalog refresh are distinct outcomes.
        try { await this.refresh(providerId); }
        catch { flow.view.error = "login saved; model catalog refresh failed — use refresh models to retry"; }
      } catch (error) {
        flow.view.state = controller.signal.aborted ? "cancelled" : "error";
        // Provider errors may contain submitted credentials or token responses.
        flow.view.error = error instanceof CredentialSynchronizationError
          ? "login saved, but local provider state could not synchronize — check connection status before trying again"
          : controller.signal.aborted ? null : "login could not finish — check connection status and try again; this provider may require another login method";
      } finally { clearTimeout(timeout); flow.view.prompt = null; flow.view.events = []; flow.answer = undefined; }
    })();
    return flow.view;
  }

  answer(providerId: string, flowId: string, promptId: string, value: string): void {
    const flow = this.flows.get(providerId);
    if (!flow || flow.view.id !== flowId || flow.view.prompt?.id !== promptId || !flow.answer) throw new Error("login prompt expired — refresh and try again");
    const prompt = flow.view.prompt;
    if (prompt.type === "select" && !prompt.options?.some(option => option.id === value)) throw new Error("select one of the offered options");
    flow.answer(value);
  }

  async cancel(providerId: string): Promise<void> {
    const flow = this.flows.get(providerId);
    if (flow?.view.state === "pending") { flow.controller.abort(); await flow.done; }
  }
  async refresh(providerId: string): Promise<void> {
    if (!this.models.getProvider(providerId)) throw new Error("provider not found");
    try {
      const result = await this.models.refresh({ providers: [providerId], allowNetwork: true, force: true, signal: AbortSignal.timeout(10000) });
      if (result?.aborted || result?.errors.size) throw new Error("refresh failed");
      const flow = this.flows.get(providerId);
      if (flow?.view.state === "connected") flow.view.error = null;
    } catch { throw new Error("could not refresh models — check provider access and try again"); }
  }
  async disconnect(providerId: string): Promise<void> {
    if (!this.models.getProvider(providerId)) throw new Error("provider not found");
    await this.cancel(providerId);
    try { await this.models.logout(providerId, { signal: AbortSignal.timeout(10000) }); }
    catch (error) { throw new Error(error instanceof CredentialSynchronizationError
      ? "saved login removed, but local provider state could not synchronize — check connection status before retrying"
      : "could not finish disconnect — check connection status before retrying"); }
    this.flows.delete(providerId);
  }
  async close(): Promise<void> { await Promise.all([...this.flows.keys()].map(id => this.cancel(id))); }
}
