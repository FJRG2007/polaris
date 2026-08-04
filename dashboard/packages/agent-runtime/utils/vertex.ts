import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERTEX_MODEL_ID_ENV } from "../models.ts";

export const VERTEX_SERVICE_ACCOUNT_JSON_ENV = "VERTEX_SERVICE_ACCOUNT_JSON";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";
export const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
export const VERTEX_LOCATION_ENV = "VERTEX_LOCATION";

export type VertexCredentials = {
  credentialsPath: string;
  secretDir: string;
};

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

export function isVertexRoute(model: string | undefined): boolean {
  const vertexId = process.env[VERTEX_MODEL_ID_ENV]?.trim();
  return model !== undefined && vertexId !== undefined && vertexId === model;
}

export function readProjectIdFromVertexServiceAccountJson(): string | undefined {
  const blob = process.env[VERTEX_SERVICE_ACCOUNT_JSON_ENV];
  if (!blob) return undefined;

  try {
    const parsed: unknown = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object" || !("project_id" in parsed)) {
      return undefined;
    }
    const projectId = parsed.project_id;
    return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
  } catch {
    return undefined;
  }
}

function createSecretDir(): string {
  const base = process.env.POLARIS_SECRET_HOME || process.env.HOME || homedir();
  const secretDir = join(base, ".polaris", "secrets", randomUUID());
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  return secretDir;
}

export function materializeVertexCredentials(params: {
  model: string | undefined;
}): VertexCredentials | undefined {
  if (!isVertexRoute(params.model)) return undefined;

  const blob = process.env[VERTEX_SERVICE_ACCOUNT_JSON_ENV];
  if (!blob) return undefined;

  const secretDir = createSecretDir();
  const credentialsPath = join(secretDir, "vertex-sa.json");
  writeFileSync(credentialsPath, blob, { mode: 0o600 });
  process.env[GOOGLE_APPLICATION_CREDENTIALS_ENV] = credentialsPath;

  const projectId = readProjectIdFromVertexServiceAccountJson();
  if (projectId && !hasEnvVar(GOOGLE_CLOUD_PROJECT_ENV)) {
    process.env[GOOGLE_CLOUD_PROJECT_ENV] = projectId;
  }

  return { credentialsPath, secretDir };
}

export function cleanupVertexCredentials(credentials: VertexCredentials | undefined): void {
  if (!credentials) return;
  rmSync(credentials.secretDir, { recursive: true, force: true });
  delete process.env[GOOGLE_APPLICATION_CREDENTIALS_ENV];
}

export function applyClaudeVertexEnv(env: Record<string, string | undefined>): void {
  env.CLAUDE_CODE_USE_VERTEX = "1";
  env.ANTHROPIC_VERTEX_PROJECT_ID ??= env[GOOGLE_CLOUD_PROJECT_ENV];
  env.CLOUD_ML_REGION ??= env[VERTEX_LOCATION_ENV];
}

export function resolveVertexOpenCodeModel(model: string | undefined): string | undefined {
  return isVertexRoute(model) && model ? `google-vertex/${model}` : undefined;
}
