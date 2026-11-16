import { describe, expect, it, vi } from "vitest";
import { freshLogin } from "@/lib/agents/provider-login-refresh";
import type { LoginRequest } from "@/lib/agents/provider-login-http";
import { readOAuthSecret, spendableSecret, writeOAuthSecret } from "@/lib/agents/provider-oauth";

describe("stored logins", () => {
    it("round-trips and never mistakes a key for a login", () => {
        const secret = writeOAuthSecret({ access: "a", refresh: "r", expires: 5 });
        expect(readOAuthSecret(secret)).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 5 });
        expect(spendableSecret(secret)).toBe("a");
        expect(spendableSecret("xai-abc")).toBe("xai-abc");
        expect(readOAuthSecret(JSON.stringify({ kind: "other" }))).toBeNull();
    });

    it("renews an xAI login once for concurrent chats and writes it back", async () => {
        let calls = 0;
        const request: LoginRequest = async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { status: 200, json: { access_token: "new", expires_in: 3600 } };
        };
        const written: string[] = [];
        const persist = async (secret: string) => {
            written.push(secret);
        };
        const login = { kind: "oauth" as const, access: "old", refresh: "r", expires: 1000 };
        const [one, two] = await Promise.all([
            freshLogin("row", "xai", login, persist, request, 0),
            freshLogin("row", "xai", login, persist, request, 0)
        ]);
        expect(calls).toBe(1);
        expect(one.access).toBe("new");
        expect(two.access).toBe("new");
        expect(one.refresh).toBe("r");
        expect(written).toHaveLength(1);
        expect(readOAuthSecret(written[0])?.access).toBe("new");
    });

    it("leaves a login with time left, a Copilot token, and a failed renewal alone", async () => {
        const request = vi.fn<LoginRequest>(async () => ({ status: 500, json: null }));
        const persist = vi.fn(async (_secret: string) => undefined);
        const later = { kind: "oauth" as const, access: "a", refresh: "r", expires: 60 * 60_000 };
        expect(await freshLogin("x", "xai", later, persist, request, 0)).toBe(later);
        const copilot = { kind: "oauth" as const, access: "gho", refresh: "", expires: 0 };
        expect(await freshLogin("y", "github-copilot", copilot, persist, request, 0)).toBe(copilot);
        expect(request).not.toHaveBeenCalled();
        const due = { kind: "oauth" as const, access: "a", refresh: "r", expires: 1 };
        expect(await freshLogin("z", "gitlab", due, persist, request, 0)).toBe(due);
        expect(persist).not.toHaveBeenCalled();
    });
});
