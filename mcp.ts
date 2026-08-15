#!/usr/bin/env bun
import { serve } from "./orchestrator/main/serve.ts";

if (import.meta.main) {
  await serve();
}
