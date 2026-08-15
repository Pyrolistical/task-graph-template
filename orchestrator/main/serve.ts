import path from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { messageOf } from "../kernel/domain/errors.ts";
import { Paced } from "../kernel/adapters/paced.ts";
import { Runtime, defaultTasksDir } from "../runtime/adapters/runtime.ts";
import { type App, type WiringOptions, wire } from "./compose.ts";
import { type Startup, build } from "./mcp.ts";

const TICK_MS = 500;

export interface Ticking {
  done: Promise<void>;
  stop(): Promise<void>;
}

export function startTicking(app: App): Ticking {
  const ticker: Paced = new Paced(TICK_MS, app.server.pending);
  const done = ticker.run(async () => {
    try {
      await app.server.tick();
    } catch (err) {
      await app.health.fail(`tick failed: ${messageOf(err)}`);
    }
  });
  return {
    done,
    stop: async () => {
      ticker.stop();
      await done;
    },
  };
}

export async function boot(options: WiringOptions): Promise<Startup> {
  try {
    const app = await wire(options);
    await app.server.start();
    return { app, error: undefined };
  } catch (err) {
    return {
      app: undefined,
      error: `the server failed to start: ${messageOf(err)}`,
    };
  }
}

function start(runtime: Runtime): Promise<Startup> {
  return boot({
    runtime,
    tasksDir: !process.argv[2]
      ? defaultTasksDir(runtime.repo)
      : path.resolve(process.argv[2]),
  });
}

async function run(runtime: Runtime): Promise<void> {
  const log = (line: string): void => {
    void runtime.log(line).catch((err: unknown) => {
      console.error(`log failed: ${messageOf(err)}`);
    });
  };
  const startup = await start(runtime);

  if (!startup.app) {
    log(startup.error ?? "the server failed to start");
    serveStdio(() => build(startup), {
      onerror: (err) => log(`mcp failed: ${err.message}`),
    });
    return;
  }

  const app = startup.app;
  const ticking = startTicking(app);

  const detach = async () => {
    try {
      await ticking.stop();
      await app.server.detach();
    } catch (err) {
      console.error(`the manager could not detach: ${messageOf(err)}`);
    }
    process.exit(0);
  };
  const handleSignal = (): void => {
    void detach();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  serveStdio(() => build(startup), {
    onerror: (err) => log(`mcp failed: ${err.message}`),
  });

  await ticking.done;
}

export async function serve(): Promise<void> {
  const runtime: Runtime = await Runtime.open(
    process.cwd(),
    process.env.TASK_GRAPH_SERVER_ROOT,
  );
  try {
    await run(runtime);
  } catch (err) {
    await runtime.log(`the server crashed: ${messageOf(err)}`);
    throw err;
  }
}
