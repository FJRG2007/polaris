import { describe, expect, it } from "vitest";
import { detectCodexRefresh } from "./codexRefreshDetect.ts";

// installCodexAuth touches the filesystem (mkdir + writeFile) - leaving it
// untested here per AGENTS.md guidance ("be highly dubious of any test that
// relies on mocks"). The conversion math is what we actually want to
// protect; the disk write is one writeFileSync call.

describe("detectCodexRefresh", () => {
  const original = "rt_original_chain";

  it("returns Codex-shape JSON when openai.refresh advanced", () => {
    const authFileContent = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "rt_new_chain",
        access: "at_new",
        expires: 9_999_999_999_999,
        accountId: "acc_123",
      },
    });
    const result = detectCodexRefresh({ authFileContent, originalRefresh: original });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.auth_mode).toBe("chatgpt");
    expect(parsed.tokens.refresh_token).toBe("rt_new_chain");
    expect(parsed.tokens.access_token).toBe("at_new");
    expect(parsed.tokens.account_id).toBe("acc_123");
    expect(typeof parsed.last_refresh).toBe("string");
  });

  it("omits account_id when accountId is absent from OpenCode shape", () => {
    const authFileContent = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "rt_new",
        access: "at_new",
        expires: 0,
      },
    });
    const result = detectCodexRefresh({ authFileContent, originalRefresh: original });
    const parsed = JSON.parse(result ?? "{}");
    expect("account_id" in parsed.tokens).toBe(false);
  });

  it("returns null when refresh token unchanged (no rotation happened)", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", refresh: original, access: "at_same", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null when openai entry is missing", () => {
    const authFileContent = JSON.stringify({
      anthropic: { type: "oauth", refresh: "rt_other", access: "at_other", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null when openai is api-key type (no refresh chain)", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "api", key: "sk-something" },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(
      detectCodexRefresh({ authFileContent: "{not json", originalRefresh: original })
    ).toBeNull();
  });

  it("returns null for non-object content", () => {
    expect(
      detectCodexRefresh({ authFileContent: '"a string"', originalRefresh: original })
    ).toBeNull();
  });

  it("returns null when refresh field is missing", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", access: "at_new", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });
});
