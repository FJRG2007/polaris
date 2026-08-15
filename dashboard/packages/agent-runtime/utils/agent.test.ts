import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgent, resolveModel } from "./agent.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { cleanupVertexCredentials, materializeVertexCredentials } from "./vertex.ts";

const savedEnv = { ...process.env };

const STRIPPED = [
  /_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^AWS_REGION$/,
  /^BEDROCK_MODEL_ID$/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^GOOGLE_CLOUD_PROJECT$/,
  /^VERTEX_SERVICE_ACCOUNT_JSON$/,
  /^VERTEX_LOCATION$/,
  /^VERTEX_MODEL_ID$/,
  /^POLARIS_SECRET_HOME$/,
  /^POLARIS_MODEL$/,
  /^POLARIS_AGENT$/,
];

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (STRIPPED.some((re) => re.test(key))) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveAgent", () => {
  it("returns opencode by default", () => {
    expect(resolveAgent({}).name).toBe("opencode");
  });

  it("routes anthropic/* to claude when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(resolveAgent({ model: "anthropic/claude-opus-4-7" }).name).toBe("claude");
  });

  it("falls back to opencode for anthropic/* without claude-code creds", () => {
    expect(resolveAgent({ model: "anthropic/claude-opus-4-7" }).name).toBe("opencode");
  });

  describe("bedrock routing", () => {
    it("routes Anthropic Bedrock IDs to claude", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("claude");
    });

    it("routes Anthropic Bedrock IDs (no region prefix) to claude", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
      expect(resolveAgent({ model: "anthropic.claude-haiku-4-5-20251001-v1:0" }).name).toBe(
        "claude"
      );
    });

    it("routes non-Anthropic Bedrock IDs to opencode", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "amazon.nova-pro-v1:0";
      expect(resolveAgent({ model: "amazon.nova-pro-v1:0" }).name).toBe("opencode");
    });

    it("routes Llama IDs to opencode", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.meta.llama4-scout-17b-instruct-v1:0";
      expect(resolveAgent({ model: "us.meta.llama4-scout-17b-instruct-v1:0" }).name).toBe(
        "opencode"
      );
    });

    it("accepts AWS access keys as auth", () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIA-test";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("claude");
    });

    it("POLARIS_AGENT override wins over Anthropic auto-routing", () => {
      process.env.POLARIS_AGENT = "opencode";
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("opencode");
    });
  });

  describe("vertex routing", () => {
    it("routes Anthropic Vertex IDs to claude", () => {
      process.env.VERTEX_SERVICE_ACCOUNT_JSON = "{}";
      process.env.VERTEX_MODEL_ID = "claude-opus-4-1@20250805";
      expect(resolveAgent({ model: "claude-opus-4-1@20250805" }).name).toBe("claude");
    });

    it("routes Gemini Vertex IDs to opencode", () => {
      process.env.VERTEX_SERVICE_ACCOUNT_JSON = "{}";
      process.env.VERTEX_MODEL_ID = "gemini-2.5-pro";
      expect(resolveAgent({ model: "gemini-2.5-pro" }).name).toBe("opencode");
    });
  });
});

describe("resolveModel", () => {
  it("POLARIS_MODEL override wins", () => {
    process.env.POLARIS_MODEL = "anthropic/claude-opus";
    expect(resolveModel({ slug: "openai/gpt" })).toBe("anthropic/claude-opus-5");
  });

  it("POLARIS_MODEL bypasses bedrock routing entirely", () => {
    process.env.POLARIS_MODEL = "openai/gpt";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "bedrock/byok" })).toBe("openai/gpt-5.6-sol");
  });

  it("resolves bedrock/byok to BEDROCK_MODEL_ID", () => {
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "bedrock/byok" })).toBe("us.anthropic.claude-opus-4-7");
  });

  it("throws when bedrock/byok is selected without BEDROCK_MODEL_ID", () => {
    expect(() => resolveModel({ slug: "bedrock/byok" })).toThrow("BEDROCK_MODEL_ID");
  });

  it("returns the alias resolve for normal slugs", () => {
    expect(resolveModel({ slug: "openai/gpt" })).toBe("openai/gpt-5.6-sol");
  });

  it("returns undefined for no slug + no POLARIS_MODEL", () => {
    expect(resolveModel({})).toBeUndefined();
  });

  // regression: PR #720 review caught that `resolveCliModel("bedrock/byok")`
  // returns the literal sentinel `"bedrock"` from the alias's `resolve`
  // field. Without routing-aware handling, POLARIS_MODEL=bedrock/byok would
  // leak that sentinel downstream and break agent dispatch.
  it("POLARIS_MODEL=bedrock/byok defers to BEDROCK_MODEL_ID, not the sentinel", () => {
    process.env.POLARIS_MODEL = "bedrock/byok";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "openai/gpt" })).toBe("us.anthropic.claude-opus-4-7");
  });

  it("POLARIS_MODEL=bedrock/byok throws if BEDROCK_MODEL_ID is missing", () => {
    process.env.POLARIS_MODEL = "bedrock/byok";
    expect(() => resolveModel({ slug: "openai/gpt" })).toThrow("BEDROCK_MODEL_ID");
  });

  it("resolves vertex/byok to VERTEX_MODEL_ID", () => {
    process.env.VERTEX_MODEL_ID = "claude-opus-4-1@20250805";
    expect(resolveModel({ slug: "vertex/byok" })).toBe("claude-opus-4-1@20250805");
  });

  it("throws when vertex/byok is selected without VERTEX_MODEL_ID", () => {
    expect(() => resolveModel({ slug: "vertex/byok" })).toThrow("VERTEX_MODEL_ID");
  });

  it("POLARIS_MODEL=vertex/byok defers to VERTEX_MODEL_ID, not the sentinel", () => {
    process.env.POLARIS_MODEL = "vertex/byok";
    process.env.VERTEX_MODEL_ID = "gemini-2.5-pro";
    expect(resolveModel({ slug: "openai/gpt" })).toBe("gemini-2.5-pro");
  });
});

describe("materializeVertexCredentials", () => {
  it("writes service-account JSON outside tmpdir and defaults project from project_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "vertex-creds-test-"));
    process.env.VERTEX_MODEL_ID = "claude-opus-4-1@20250805";
    process.env.POLARIS_SECRET_HOME = dir;
    process.env.VERTEX_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "test-project",
      client_email: "polaris@test-project.iam.gserviceaccount.com",
    });

    try {
      const credentials = materializeVertexCredentials({ model: "claude-opus-4-1@20250805" });

      if (!credentials) throw new Error("expected vertex credentials");
      expect(credentials.credentialsPath).toContain(join(dir, ".polaris", "secrets"));
      expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(credentials.credentialsPath);
      expect(process.env.GOOGLE_CLOUD_PROJECT).toBe("test-project");
      expect(readFileSync(credentials.credentialsPath, "utf8")).toBe(
        process.env.VERTEX_SERVICE_ACCOUNT_JSON
      );
      // this runtime only ever runs in a GitHub Actions job / Polaris runner
      // (both POSIX); NTFS has no POSIX permission bits, so writeFileSync's
      // mode is not honored on Windows and this assertion is meaningless there.
      if (process.platform !== "win32") {
        expect(statSync(credentials.credentialsPath).mode & 0o777).toBe(0o600);
      }
      cleanupVertexCredentials(credentials);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
