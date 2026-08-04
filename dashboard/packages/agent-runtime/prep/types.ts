interface PrepResultBase {
  dependenciesInstalled: boolean;
  issues: string[];
}

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";

export interface NodePrepResult extends PrepResultBase {
  language: "node";
  packageManager: NodePackageManager;
}

export type PythonPackageManager = "pip" | "pipenv" | "poetry";

export interface PythonPrepResult extends PrepResultBase {
  language: "python";
  packageManager: PythonPackageManager;
  configFile: string;
}

export interface UnknownLanguagePrepResult extends PrepResultBase {
  language: "unknown";
}

export type PrepResult = NodePrepResult | PythonPrepResult | UnknownLanguagePrepResult;

export type PrepOptions = {
  /** when true, lifecycle scripts (postinstall, etc.) are suppressed */
  ignoreScripts: boolean;
  /** directory the corepack shim is installed into (see `packageManagerBinDir`) */
  binDir: string;
};

export interface PrepDefinition {
  name: string;
  shouldRun: () => Promise<boolean> | boolean;
  run: (options: PrepOptions) => Promise<PrepResult>;
}
