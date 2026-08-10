import path from "node:path";
import type { AgentProcess, AgentSpec, Agents } from "../app/ports/agents.ts";
import type { Paths } from "../app/ports/paths.ts";
import type { Slot } from "../domain/agents.ts";
import type { Sample } from "../domain/rates.ts";
import type { ResultCall } from "../domain/results.ts";
import { STAGE_OF } from "../domain/state-machine.ts";
import { agentWrite } from "./agent-pool.ts";
import { exists } from "./files.ts";
import { PiProcess } from "./pi-process.ts";
import { AGENT_OOM_SCORE_ADJUST, overlays, sandbox } from "./sandbox.ts";

export class PiAgents implements Agents {
  constructor(
    private readonly paths: Paths,
    private readonly pool: Slot[],
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
