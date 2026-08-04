import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, findingsSubmit } from "./result-tools.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(findingsSubmit("design"));
  pi.registerTool(blocked);
}
