import fs from "node:fs";
import type { AgentProcess } from "../app/ports/agents.ts";
import { errorOf } from "../domain/errors.ts";
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

export class PiProcess implements AgentProcess {
  readonly stream: PiStream;
  readonly pid: number;

  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 0;
  private closed = false;
  private abortRequested = false;
  private stderr = "";

  constructor(
    options: SpawnOptions,
    command = "pi",
    launch: string[] = [],
    onUsage: OnUsage = () => {},
    onCompaction: OnCompaction = () => {},
    onResult: OnResult = () => {},
  ) {
    this.stream = new PiStream(onUsage, onCompaction, onResult);
    fs.mkdirSync(options.sessionDir, { recursive: true });

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

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      this.stream.feed(text);
      if (this.stream.state.looping !== null) {
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
      this.proc.exitCode === null &&
      this.stream.state.failure === null
    );
  }

  send(command: Record<string, unknown>): Promise<PiResponse> {
    const id = String(++this.nextId);
    const expected = this.stream.expect(id);
    try {
      this.write({ id, ...command });
    } catch (err) {
      this.stream.reject(id, errorOf(err));
    }
    return expected;
  }

  private write(payload: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error("the pi process stdin is already closed");
    }
    if (!this.alive) {
      throw new Error(
        this.stream.state.failure ?? "the pi process has already exited",
      );
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    this.proc.stdin.flush();
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
    this.write({ type: "abort" });
  }

  abortBash(): void {
    this.write({ type: "abort_bash" });
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
    tokens: number | null;
    contextPercent: number | null;
  }> {
    const response = await this.send({ type: "get_session_stats" });
    const stats = SessionStats.parse(response.data ?? {});
    return {
      tokens: stats.tokens?.total ?? null,
      contextPercent: stats.contextUsage?.percent ?? null,
    };
  }

  async lastAssistantText(): Promise<string | null> {
    const response = await this.send({ type: "get_last_assistant_text" });
    const text = response.data?.text;
    return typeof text === "string" ? text : null;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.proc.stdin.end();
  }

  kill(): void {
    this.close();
    this.proc.kill();
  }
}
