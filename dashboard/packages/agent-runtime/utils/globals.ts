import { existsSync } from "node:fs";

export const isCloudflareSandbox =
  !!process.env.CLOUDFLARE_APPLICATION_ID && !!process.env.SANDBOX_VERSION;

export const isGitHubActions = !!process.env.GITHUB_ACTIONS;

// detect if running inside Docker container (CI tests run in Docker with host env vars)
export const isInsideDocker = existsSync("/.dockerenv");
