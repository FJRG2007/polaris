/**
 * What a provider's answer means for a key somebody just pasted.
 *
 * The classifier is the whole safety of checking keys at all: read one code too
 * broadly and a deployment that cannot reach the provider becomes a deployment
 * where nobody can add a key. Only the two codes that mean "not you" may refuse.
 */

import { describe, expect, it } from "vitest";
import { classify, providerIsCheckable } from "@/lib/agents/provider-key-check";

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
