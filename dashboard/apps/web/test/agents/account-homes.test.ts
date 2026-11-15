/**
 * Codex's per-account home: where it is, what the launch is told, and the
 * script that links everything but the sign-in back to the session's home and
 * only replaces the account's own sign-in when its owner linked it again.
 */

import { describe, expect, it } from "vitest";
import * as homes from "@/lib/agents/account-homes";

const ID = "00000000-0000-4000-8000-00000000000a";
const DIGEST = "a".repeat(64);

describe("account homes", () => {
    it("names a home per account for Codex and none for a tool that signs in by variable", () => {
        expect(homes.accountHomeFor("codex")?.env).toBe("CODEX_HOME");
        expect(homes.accountHomeFor("claude")).toBeNull();
        expect(homes.accountHomeEnvs()).toEqual(["CODEX_HOME"]);
        expect(homes.accountHomeDir("/home/node", "codex", ID)).toBe(`/home/node/.polaris-accounts/codex/${ID}`);
    });

    it("refuses an id, a home or a file name that could leave its directory", () => {
        expect(() => homes.accountHomeDir("/home/node", "codex", "../x")).toThrow();
        expect(() => homes.accountHomeDir("/home/node; rm -rf /", "codex", ID)).toThrow();
        expect(() => homes.accountHomeDir("/home/node", "claude", ID)).toThrow();
        const base = {
            cliId: "codex",
            userHome: "/home/node",
            accountId: ID,
            stateDir: "/session/polaris",
            digest: DIGEST
        };
        expect(() => homes.accountHomeCommand({ ...base, part: "../auth.json" })).toThrow();
        expect(() => homes.accountHomeCommand({ ...base, part: "account.abcdef12.part", digest: "$(id)" })).toThrow();
    });

    it("links the shared entries, keeps the sign-in private, and copies it only when new", () => {
        const script = homes.accountHomeCommand({
            cliId: "codex",
            userHome: "/home/node",
            accountId: ID,
            stateDir: "/session/polaris",
            part: "account.abcdef12.part",
            digest: DIGEST
        });
        expect(script).toContain(`a="/home/node/.polaris-accounts/codex/${ID}"`);
        expect(script).toContain("for n in sessions archived_sessions");
        expect(script).toContain("for n in config.toml history.jsonl");
        expect(script).toMatch(/case "\$n" in auth\.json\|models_cache\.json\|[^)]*\.polaris-stored\) continue/);
        expect(script).toContain('ln -s "$e" "$a/$n"');
        expect(script).toContain(`!= "${DIGEST}" ]; then`);
        expect(script).toContain('mv "$p" "$a/auth.json"');
        expect(script).toContain('chmod 0600 "$a/auth.json"');
        // Carries no credential: the file travels separately.
        expect(script).not.toMatch(/base64/);
    });

    it("digests the stored sign-in as hex, never the value", () => {
        const digest = homes.storedDigest(Buffer.from('{"tokens":{"refresh_token":"x"}}'));
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });
});
