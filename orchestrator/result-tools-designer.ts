import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, plainSubmit } from "./result-tools.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(plainSubmit("designing and hand in your design", "design"));
  pi.registerTool(blocked);
}
