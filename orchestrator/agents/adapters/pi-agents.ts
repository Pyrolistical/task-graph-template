import path from "node:path";
import type { AgentProcess, AgentSpec, Agents } from "../ports/agents.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { Slot } from "../domain/slots.ts";
import { HEALTH_TIMEOUT_MS, probe } from "../domain/health.ts";
import type { Sample } from "../../kernel/domain/rates.ts";
import type { ResultCall } from "../domain/results.ts";
import { STAGE_OF } from "../../vocabulary/state-machine.ts";
import { AGENT_OOM_SCORE_ADJUST, agentWrite } from "./agent-pool.ts";
import { exists } from "../../kernel/adapters/files.ts";
import { PiProcess } from "./pi-process.ts";
import { overlays, sandbox } from "../../kernel/adapters/sandbox.ts";

export interface ModelInfo {
  api: string;
  baseUrl: string;
}

export interface ModelAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
}

export interface Catalog {
  getModel(provider: string, model: string): ModelInfo | undefined;
  getAuth(model: ModelInfo): Promise<{ auth: ModelAuth } | undefined>;
}

function sent(headers?: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

export class PiAgents implements Agents {
  constructor(
    private readonly paths: Paths,
    private readonly pool: Slot[],
    private readonly models: Catalog,
    private readonly repo: string,
    private readonly orchestratorDir: string,
    private readonly piCommand: string,
    private readonly sandboxCommand: string,
  ) {}

  slots(): Slot[] {
    return this.pool;
  }

  hasSession(sessionPath: string): Promise<boolean> {
    return exists(sessionPath);
  }

  async healthy(slot: Slot): Promise<boolean> {
    const model = this.models.getModel(slot.provider, slot.model);
    if (!model) {
      throw new Error(
        `pi knows no model "${slot.model}" on provider "${slot.provider}"`,
      );
    }
    const auth = await this.models.getAuth(model);
    const { url, headers } = probe(
      auth?.auth.baseUrl ?? model.baseUrl,
      model.api,
      auth?.auth.apiKey,
    );

    try {
      const response = await fetch(url, {
        headers: { ...headers, ...sent(auth?.auth.headers) },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async spawn(
    spec: AgentSpec,
    onUsage: (sample: Sample) => void,
    onCompaction: () => void,
    onResult: (call: ResultCall) => void,
  ): Promise<AgentProcess> {
    return PiProcess.open(
      {
        provider: spec.slot.provider,
        model: spec.slot.model,
        sessionDir: this.paths.sessionDir(spec.taskId, spec.role),
        name: `${spec.taskId} ${spec.state}`,
        cwd: spec.cwd,
        extension: path.join(
          this.orchestratorDir,
          `result-tools-${STAGE_OF[spec.state].tools}.ts`,
        ),
      },
      this.piCommand,
      await sandbox(
        {
          cwd: spec.cwd,
          writable: [this.paths.taskRoot(spec.taskId)],
          readable: [this.repo, this.orchestratorDir],
          overlay: await overlays(agentWrite(spec.slot)),
          oomScoreAdjust: AGENT_OOM_SCORE_ADJUST,
        },
        this.sandboxCommand,
      ),
      onUsage,
      onCompaction,
      onResult,
    );
  }
}
