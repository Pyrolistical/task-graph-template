import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiProcess } from "./rpc.ts";
import { STATE_ROLE, type ClaimState } from "./runtime.ts";

interface Scenario {
  name: string;
  tool: string;
  prompt: string;
}

const SCENARIOS: Record<ClaimState, Scenario[]> = {
  PLANNING: [
    {
      name: "submit",
      tool: "submit",
      prompt:
        "Plan this task: add a greeting to hello.txt. Write a short numbered todo list, then finish by calling the submit tool. Do not use any other tools.",
    },
    {
      name: "blocked",
      tool: "blocked",
      prompt:
        "Plan this task: add a greeting to hello.txt, but the acceptance criteria are empty. If you genuinely cannot plan it, finish by calling the blocked tool with a message naming the wall. Do not use any other tools.",
    },
  ],
  PLAN_REVIEWING: [
    {
      name: "approve",
      tool: "submit",
      prompt:
        "Review this plan: '## Todos\\n\\n1. write hello.txt\\n2. run the check' against the goal 'add a greeting'. It is complete and correctly numbered. Finish by calling the submit tool with an empty findings list. Do not use any other tools.",
    },
    {
      name: "reject",
      tool: "submit",
      prompt:
        "Review this plan: '## Todos\\n\\n1. write hello.txt' against the goal 'add a greeting and a farewell'. It misses the farewell. Finish by calling the submit tool with that gap in findings. Do not use any other tools.",
    },
    {
      name: "blocked",
      tool: "blocked",
      prompt:
        "Review this plan: '## Todos\\n\\n1. write hello.txt' against the goal 'add a greeting', but the goal contradicts itself. If you genuinely cannot review it, finish by calling the blocked tool with a message naming the wall. Do not use any other tools.",
    },
  ],
  WORKING: [
    {
      name: "submit",
      tool: "submit",
      prompt:
        "Implement this task: write hello.txt containing 'hello'. You have done it and committed it. Finish by calling the submit tool. Do not use any other tools.",
    },
    {
      name: "blocked",
      tool: "blocked",
      prompt:
        "Implement this task: write hello.txt containing 'hello', but the file is owned by root. If you genuinely cannot finish, call the blocked tool with a message naming the wall. Do not use any other tools.",
    },
  ],
  WORK_REVIEWING: [
    {
      name: "approve",
      tool: "submit",
      prompt:
        "Review this work: the commit adds hello.txt with 'hello' and the notes address every todo. It is correct. Finish by calling the submit tool with empty findings and delegations. Do not use any other tools.",
    },
    {
      name: "reject",
      tool: "submit",
      prompt:
        "Review this work: the commit adds hello.txt, but the notes ignore todo 2 and hello.txt says 'hola'. Finish by calling the submit tool with those defects in findings. Do not use any other tools.",
    },
    {
      name: "delegate",
      tool: "submit",
      prompt:
        "Review this work: the commit is correct, but the same bug lives in fetch.ts outside this task. Finish by calling the submit tool with that in delegations. Do not use any other tools.",
    },
    {
      name: "blocked",
      tool: "blocked",
      prompt:
        "Review this work, but the range names a commit that is not in the worktree. If you genuinely cannot review it, finish by calling the blocked tool with a message naming the wall. Do not use any other tools.",
    },
  ],
};

const STATES: ClaimState[] = [
  "PLANNING",
  "PLAN_REVIEWING",
  "WORKING",
  "WORK_REVIEWING",
];

interface Counts {
  ok: number;
  mismatch: number;
  missing: number;
  failures: string[];
}

function classify(scenario: Scenario, calls: { tool: string }[]): keyof Counts {
  const last = calls[calls.length - 1];
  if (last === undefined) {
    return "missing";
  }
  if (last.tool === scenario.tool) {
    return "ok";
  }
  return "mismatch";
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function trial(
  state: ClaimState,
  scenario: Scenario,
  trialNumber: number,
  provider: string,
  model: string,
): Promise<{ verdict: keyof Counts; calls: { tool: string }[] }> {
  const root =
    process.env.CLAUDE_JOB_DIR === undefined
      ? os.tmpdir()
      : path.join(process.env.CLAUDE_JOB_DIR, "tmp");
  const sessionDir = path.join(
    root,
    "tools-jig",
    state,
    scenario.name,
    String(trialNumber),
  );
  const log = path.join(sessionDir, "agent-rpc.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "ASSIGNMENT.md"),
    `\n\n${scenario.prompt}\n`,
  );

  const pi = new PiProcess({
    provider,
    model,
    sessionDir,
    name: `${state} ${scenario.name}`,
    cwd: sessionDir,
    systemPrompt: path.join(import.meta.dir, "prompts", `${state}.md`),
    extension: path.join(
      import.meta.dir,
      `result-tools-${STATE_ROLE[state]}.ts`,
    ),
    log,
  });

  try {
    await pi.newSession();
    await pi.prompt(scenario.prompt);
    await pi.stream.settled();
    return {
      verdict: classify(scenario, pi.stream.state.resultCalls),
      calls: pi.stream.state.resultCalls,
    };
  } finally {
    pi.kill();
  }
}

async function main(): Promise<void> {
  const provider = flag("--provider");
  const model = flag("--model");
  if (provider === undefined || model === undefined) {
    console.error(
      "usage: bun orchestrator/tools-jig.ts --provider <provider> --model <model> [--trials N] [--states PLANNING,WORKING]",
    );
    process.exit(2);
  }

  const trials = Number(flag("--trials") ?? "5");
  if (!Number.isInteger(trials) || trials < 1) {
    console.error("--trials must be a positive integer");
    process.exit(2);
  }
  const wanted = (flag("--states") ?? STATES.join(",")).split(",");
  const unknown = wanted.filter(
    (state) => !STATES.includes(state as ClaimState),
  );
  if (unknown.length > 0) {
    console.error(`unknown state(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const states = STATES.filter((state) => wanted.includes(state));

  let allFailed = false;

  for (const state of states) {
    console.log(`\n=== ${state} ===`);
    for (const scenario of SCENARIOS[state]) {
      const counts: Counts = {
        ok: 0,
        mismatch: 0,
        missing: 0,
        failures: [],
      };

      for (let n = 0; n < trials; n++) {
        const { verdict, calls } = await trial(
          state,
          scenario,
          n,
          provider,
          model,
        );
        counts[verdict]++;
        if (verdict !== "ok") {
          const made = calls.map((call) => call.tool).join(", ");
          counts.failures.push(
            `  [${verdict}] ${made === "" ? "no result tool" : made}`,
          );
        }
      }

      const rate = `${counts.ok}/${trials}`;
      console.log(
        `  ${scenario.name.padEnd(10)} ${rate.padStart(4)} ok` +
          (counts.mismatch > 0 ? `, ${counts.mismatch} mismatch` : "") +
          (counts.missing > 0 ? `, ${counts.missing} missing` : ""),
      );
      for (const failure of counts.failures.slice(0, 3)) {
        console.log(failure);
      }
      if (counts.ok === 0) {
        allFailed = true;
      }
    }
  }

  process.exit(allFailed ? 1 : 0);
}

if (import.meta.main) {
  void main();
}
