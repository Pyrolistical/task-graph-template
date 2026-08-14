import fs from "node:fs/promises";
import type { AgentProcess } from "../ports/agents.ts";
import { errorOf } from "../../kernel/domain/errors.ts";
import {
  type OnCompaction,
  type OnResult,
  type OnUsage,
  type PiResponse,
  type SpawnOptions,
  PiStream,
  SessionStats,
  spawnArgs,
} from "../domain/protocol.ts";

function ignored(): void {}

export class PiProcess implements AgentProcess {
  readonly stream: PiStream;
  readonly pid: number;

  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 0;
  private closed = false;
  private abortRequested = false;
  private stderr = "";

  private constructor(
    options: SpawnOptions,
    command: string,
    launch: string[],
    onUsage: OnUsage,
    onCompaction: OnCompaction,
    onResult: OnResult,
  ) {
    this.stream = new PiStream(onUsage, onCompaction, onResult);

    this.proc = Bun.spawn([...launch, command, ...spawnArgs(options)], {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: { ...process.env },
    });

    this.pid = this.proc.pid;
    void this.pump();
    void this.pumpErrors();
  }

  static async open(
    options: SpawnOptions,
    command = "pi",
    launch: string[] = [],
    onUsage: OnUsage = () => {},
    onCompaction: OnCompaction = () => {},
    onResult: OnResult = () => {},
  ): Promise<PiProcess> {
    await fs.mkdir(options.sessionDir, { recursive: true });
    return new PiProcess(
      options,
      command,
      launch,
      onUsage,
      onCompaction,
      onResult,
    );
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      this.stream.feed(text);
      if (this.stream.state.looping) {
        this.interrupt();
      }
    }
    this.stream.fail(
      `the pi process closed its stdout${this.stderr === "" ? "" : `: ${this.stderr.trim()}`}`,
    );
  }

  private async pumpErrors(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr += decoder.decode(chunk, { stream: true });
    }
  }

  get alive(): boolean {
    return (
      !this.closed &&
      typeof this.proc.exitCode !== "number" &&
      !this.stream.state.failure
    );
  }

  send(command: Record<string, unknown>): Promise<PiResponse> {
    const id = String(++this.nextId);
    const expected = this.stream.expect(id);
    this.write({ id, ...command }).catch((err: unknown) => {
      this.stream.reject(id, errorOf(err));
    });
    return expected;
  }

  private async write(payload: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      throw new Error("the pi process stdin is already closed");
    }
    if (!this.alive) {
      throw new Error(
        this.stream.state.failure ?? "the pi process has already exited",
      );
    }
    await this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    await this.proc.stdin.flush();
  }

  private signal(payload: Record<string, unknown>): void {
    this.write(payload).catch((err: unknown) => {
      this.stream.fail(errorOf(err).message);
    });
  }

  async newSession(): Promise<string> {
    await this.send({ type: "new_session" });
    const state = await this.send({ type: "get_state" });
    const file = state.data?.sessionFile;
    if (typeof file !== "string") {
      throw new Error("pi started a session with no sessionFile");
    }
    return file;
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
  }

  async prompt(message: string): Promise<void> {
    this.abortRequested = false;
    this.stream.starting();
    await this.send({ type: "prompt", message });
  }

  get aborting(): boolean {
    return this.abortRequested;
  }

  abort(): void {
    this.abortRequested = true;
    this.signal({ type: "abort" });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  private interrupt(): void {
    if (this.aborting || !this.alive) {
      return;
    }
    this.abort();
  }

  async stats(): Promise<{
    tokens?: number;
    cost?: number;
    contextPercent?: number;
  }> {
    const response = await this.send({ type: "get_session_stats" });
    const stats = SessionStats.parse(response.data ?? {});
    return {
      tokens: stats.tokens?.total,
      cost: stats.cost,
      contextPercent: stats.contextUsage?.percent,
    };
  }

  async lastAssistantText(): Promise<string | undefined> {
    const response = await this.send({ type: "get_last_assistant_text" });
    const text = response.data?.text;
    if (typeof text !== "string") {
      return;
    }
    return text;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    Promise.resolve(this.proc.stdin.end()).catch(ignored);
  }

  kill(): void {
    this.close();
    this.proc.kill();
  }
}
