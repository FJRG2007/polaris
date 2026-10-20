/**
 * What a provider's answer means for a key somebody just pasted.
 *
 * The classifier is the whole safety of checking keys at all: read one code too
 * broadly and a deployment that cannot reach the provider becomes a deployment
 * where nobody can add a key. Only the two codes that mean "not you" may refuse.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    checkProviderKey,
    classify,
    providerIsCheckable,
    providerMessage
} from "@/lib/agents/provider-key-check";

describe("classify", () => {
    it("accepts any success", () => {
        expect(classify(200).state).toBe("valid");
        expect(classify(204).state).toBe("valid");
    });

    it("refuses only a credential the provider rejected", () => {
        expect(classify(401).state).toBe("rejected");
        expect(classify(403).state).toBe("rejected");
    });

    it("treats a rate limit as unknown, not as a bad key", () => {
        // 429 is the account's ceiling, and the key that hit it is working.
        expect(classify(429).state).toBe("unverified");
    });

    it("treats a moved endpoint and a broken provider as unknown", () => {
        expect(classify(404).state).toBe("unverified");
        expect(classify(500).state).toBe("unverified");
        expect(classify(503).state).toBe("unverified");
    });
});

describe("providerIsCheckable", () => {
    it("knows the providers it can ask", () => {
        expect(providerIsCheckable("openai")).toBe(true);
        expect(providerIsCheckable("anthropic")).toBe(true);
    });

    it("does not claim to check an endpoint of somebody's own", () => {
        // The gateway is whatever address its owner points it at, frequently one
        // on their own network. Polaris does not make requests to those.
        expect(providerIsCheckable("enigma")).toBe(false);
    });
});

/** The body Anthropic answered a `sk-ant-usr-` key with on 2026-10-20. */
const NOT_SCOPED = JSON.stringify({
    type: "error",
    error: {
        type: "invalid_request_error",
        message:
            "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."
    }
});

describe("what the provider said", () => {
    it("asks for the workspace ID when Anthropic says the key needs one", () => {
        const check = classify(400, providerMessage(NOT_SCOPED));
        expect(check).toMatchObject({
            state: "rejected",
            code: "workspace",
            reason: "This key needs the ID of the Anthropic workspace to use. Add it under Workspace ID."
        });
    });

    it("reads the documented wording the same way", () => {
        const message =
            "anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.";
        expect(classify(400, message)).toMatchObject({ state: "rejected", code: "workspace" });
    });

    it("says a malformed workspace ID and an unknown one apart", () => {
        expect(
            classify(400, "anthropic-workspace-id header must be a valid workspace ID.").reason
        ).toContain("not a workspace ID");
        expect(classify(404, "Workspace `wrkspc_01abc` not found.")).toMatchObject({
            state: "rejected",
            code: "workspace"
        });
    });

    it("still treats a bare 404 as an endpoint that moved", () => {
        expect(classify(404, "Not found").state).toBe("unverified");
    });

    it("shows any other provider sentence instead of only the number", () => {
        const check = classify(400, "max_tokens: field required");
        expect(check).toMatchObject({ state: "unverified", code: "unknown" });
        expect(check.state === "valid" ? "" : check.reason).toContain("max_tokens: field required");
    });

    it("never echoes the key, and caps what it shows", () => {
        const secret = "sk-ant-usr-SECRETSECRET";
        const echoed = JSON.stringify({
            error: {
                message: `Key ${secret} is
bad`
            }
        });
        expect(providerMessage(echoed, secret)).toBe("Key [key] is bad");
        const long = JSON.stringify({ error: { message: "x".repeat(5000) } });
        expect(providerMessage(long)!.length).toBeLessThanOrEqual(200);
    });

    it("reads nothing out of a body that is not JSON", () => {
        expect(providerMessage("<html>Bad gateway</html>")).toBeNull();
        expect(classify(502, null).reason).toContain("502");
    });
});

describe("checkProviderKey and the workspace header", () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubFetch(status: number, body = "{}") {
        const fetch = vi.fn(async () => new Response(body, { status }));
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }

    function sentHeaders(fetch: ReturnType<typeof stubFetch>): Record<string, string> {
        const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
        return (init?.headers ?? {}) as Record<string, string>;
    }

    it("sends the workspace to Anthropic when one is named", async () => {
        const fetch = stubFetch(200);
        const check = await checkProviderKey("anthropic", "sk-ant-usr-abcdefgh", {
            workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
        });
        expect(check.state).toBe("valid");
        expect(sentHeaders(fetch)["anthropic-workspace-id"]).toBe(
            "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
        );
    });

    it("sends no workspace header when none is named", async () => {
        const fetch = stubFetch(200);
        await checkProviderKey("anthropic", "sk-ant-api-abcdefgh");
        expect(sentHeaders(fetch)).not.toHaveProperty("anthropic-workspace-id");
    });

    it("never sends it to another provider", async () => {
        const fetch = stubFetch(200);
        await checkProviderKey("openai", "sk-proj-abcdefgh", { workspaceId: "wrkspc_01abc" });
        expect(sentHeaders(fetch)).not.toHaveProperty("anthropic-workspace-id");
    });

    it("refuses a key Anthropic says needs a workspace, in words", async () => {
        stubFetch(400, NOT_SCOPED);
        const check = await checkProviderKey("anthropic", "sk-ant-usr-abcdefgh");
        expect(check).toMatchObject({ state: "rejected", code: "workspace" });
        expect(check.state === "valid" ? "" : check.reason).toMatch(/Workspace ID/);
    });
});
