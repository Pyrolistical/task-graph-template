#!/usr/bin/env bun
import path from "node:path";
import { main } from "../adapters/tui.ts";

if (import.meta.main) {
  await main(path.resolve(process.argv[2] ?? process.cwd()), true);
}
