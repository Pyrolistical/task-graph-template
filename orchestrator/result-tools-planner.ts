import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, plainSubmit } from "./result-tools.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(plainSubmit("planning and hand in your plan", "plan"));
  pi.registerTool(blocked);
}
