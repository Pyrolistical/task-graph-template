export interface ServerConfig {
  repo: string;
  base: string;
  tasksDir: string;
  agentsPath: string;
  promptDirs: { orchestrator: string; overrides: string };
}
