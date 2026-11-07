import { Context } from "@deepseek-ai/cordis";
import { Agent, AgentHandle, AgentSetupCommit } from "@deepseek-ai/dsh-agent";
import { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import "@deepseek-ai/dsh-llm";
import { Session, SessionStore } from "@deepseek-ai/dsh-session";
//#region src/host/config/options.d.ts
interface Config {
  codexPath?: string;
  claudePath?: string;
  probeTimeoutMs?: number;
}
//#endregion
//#region src/shared/native-model.d.ts
interface NativeTurnOptions {
  model: string | null;
  reasoningEffort: string | null;
}
//#endregion
//#region src/shared/types.d.ts
type BackendId = 'dsh' | 'codex' | 'claude';
interface KernelBinding {
  backend: Exclude<BackendId, 'dsh'>;
  nativeSessionId: string;
  sessionId: string;
}
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    bridgeModel: NativeTurnOptions;
    bridgeKernel: KernelBinding | null;
  }
}
//#endregion
//#region src/host/types/index.d.ts
interface PlatformLoader {
  import: (id: string) => Promise<unknown>;
  unwrapExports: (value: unknown) => unknown;
}
interface NativeSessionBridge {
  create: (source: Session, create: (signal?: AbortSignal) => Promise<AgentHandle>) => Promise<AgentHandle>;
  prepare: (source: Session, agent: Agent, signal: AbortSignal) => Promise<AgentSetupCommit | void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeSessionBridge: NativeSessionBridge;
  }
}
type HostContext = Context & {
  sessions: SessionStore;
  connection: HostConnectionHandle;
  loader: PlatformLoader;
};
//#endregion
//#region src/host/apply.d.ts
declare function apply(ctx: HostContext, config?: Config): void;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-tauri-kernel";
declare const inject: string[];
//#endregion
export { type Config, apply, inject, name };