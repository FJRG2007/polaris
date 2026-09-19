/**
 * Asking somebody outside the mailbox about a sender, and surviving the answer.
 *
 * A phishing message reached an inbox from an address a reputation provider
 * Polaris already integrates with had on file as fraudulent, and nothing asked
 * it. This pins the wiring that now does - and, far more importantly, every way
 * it is allowed to fail.
 *
 * The rule is one sentence: **an answer can accuse, and silence can never.**
 * Nothing configured, no key, a refusal, a malformed answer, a provider having a
 * bad afternoon - all of them leave the filter with exactly the verdict it would
 * have reached on its own. The failure this is written against is not a phish
 * that gets through; it is somebody's invoice in Junk because a lookup timed
 * out.
 */

import { SPAM_THRESHOLDS } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the operator has switched on, for the case being run. */
let enabled = true;
let apiKey: string | null = "key";
/** What the shared cache already holds, keyed by what was asked about. */
let remembered = new Map<string, { allow: boolean; reason: string | null }>();

const verifyDomain = vi.fn(async (_key: string, _domain: string) => ({ fraud: false }));
const verifyEmail = vi.fn(async (_key: string, _address: string) => ({
    allow: true,
    reasons: [] as string[]
}));
const rememberReputation = vi.fn(async () => undefined);

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async (name: string) =>
        name === "dymo" ? { enabled, config: {} } : { enabled: false, config: {} },
    getIntegrationSecret: async () => apiKey
}));

vi.mock("@/lib/reputation", () => ({
    knownReputation: async (kind: string, value: string) => remembered.get(`${kind}:${value}`) ?? null,
    rememberReputation: (...args: unknown[]) => rememberReputation(...(args as [])),
    forgetReputation: async () => 0
}));

vi.mock("@/lib/integrations/virustotal", () => ({
    lookupDomain: async () => ({ kind: "unknown" as const })
}));

vi.mock("@/lib/integrations/dymo", () => ({
    MAIL_DENY_RULES: ["FRAUD", "INVALID", "NO_MX_RECORDS", "HIGH_RISK_SCORE"],
    verifyDomain: (...args: unknown[]) => verifyDomain(...(args as [string, string])),
    verifyEmail: (...args: unknown[]) => verifyEmail(...(args as [string, string]))
}));

const { senderReputation } = await import("@/lib/mailbox/sender-reputation");

beforeEach(() => {
    enabled = true;
    apiKey = "key";
    remembered = new Map();
    verifyDomain.mockReset().mockResolvedValue({ fraud: false });
    verifyEmail.mockReset().mockResolvedValue({ allow: true, reasons: [] });
    rememberReputation.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("nothing configured", () => {
    it("asks nobody and says nothing", async () => {
        enabled = false;
        expect(await senderReputation("recordings@sender.example")).toEqual([]);
        expect(verifyDomain).not.toHaveBeenCalled();
        expect(verifyEmail).not.toHaveBeenCalled();
    });

    it("says nothing when the provider is switched on but holds no key", async () => {
        // The one screen-free way this feature turns itself off. No message is
        // shown, nothing is logged at somebody, and the filter simply judges on
        // what it can read for itself.
        apiKey = null;
        expect(await senderReputation("recordings@sender.example")).toEqual([]);
        expect(verifyDomain).not.toHaveBeenCalled();
    });
});

describe("a sender the provider has on file", () => {
    it("files the message on the domain alone", async () => {
        verifyDomain.mockResolvedValue({ fraud: true });
        const found = await senderReputation("recordings@sender.example");
        expect(found).toHaveLength(1);
        expect(found[0]?.id).toBe("domain_fraud");
        // Strong enough to be a verdict on its own, and no stronger.
        expect(found[0]?.score).toBe(SPAM_THRESHOLDS.junk);
        expect(found[0]?.reason).toContain("sender.example");
    });

    it("does not buy an answer about the address once the domain has answered", async () => {
        // A campaign writes from a different address at the same domain every
        // hour. The domain's answer covers all of them, and the second lookup
        // would be a second charge for a question already answered.
        verifyDomain.mockResolvedValue({ fraud: true });
        await senderReputation("recordings@sender.example");
        expect(verifyEmail).not.toHaveBeenCalled();
    });

    it("files the message on the address when the domain is not itself flagged", async () => {
        verifyEmail.mockResolvedValue({ allow: false, reasons: ["FRAUD"] });
        const found = await senderReputation("recordings@sender.example");
        expect(found.map((one) => one.id)).toContain("address_fraud");
        expect(found.find((one) => one.id === "address_fraud")?.score).toBe(SPAM_THRESHOLDS.junk);
    });

    it("keeps the softer answers soft", async () => {
        // An address that cannot exist or whose domain has nowhere to deliver is
        // evidence, not a verdict. Filing a message on it alone would throw away
        // every message from a misconfigured mail server on earth.
        verifyEmail.mockResolvedValue({ allow: false, reasons: ["NO_MX_RECORDS"] });
        const found = await senderReputation("recordings@sender.example");
        const said = found.find((one) => one.id === "address_reputation_flagged");
        expect(said).toBeDefined();
        expect(said?.score).toBeLessThan(SPAM_THRESHOLDS.junk);
    });
});

describe("what is remembered", () => {
    it("answers a domain it has already asked about without asking again", async () => {
        remembered.set("domain:sender.example", {
            allow: false,
            reason: "this domain is known for fraud"
        });
        const found = await senderReputation("recordings@sender.example");
        expect(found[0]?.id).toBe("domain_fraud");
        expect(verifyDomain).not.toHaveBeenCalled();
    });

    it("recognises a remembered fraud answer about an address for what it is", async () => {
        // The cache keeps what the provider said in the reader's words rather
        // than the rule name behind it, so a remembered fraud verdict has to
        // come back out as a verdict and not as the ordinary flagged weight.
        remembered.set("email:recordings@sender.example", {
            allow: false,
            reason: "this address is known for fraud"
        });
        const found = await senderReputation("recordings@sender.example");
        expect(found.find((one) => one.id === "address_fraud")?.score).toBe(SPAM_THRESHOLDS.junk);
        expect(verifyEmail).not.toHaveBeenCalled();
    });

    it("writes a clean answer down so the next message is free", async () => {
        await senderReputation("recordings@sender.example");
        expect(rememberReputation).toHaveBeenCalled();
    });
});

describe("a provider having a bad afternoon", () => {
    it("says nothing when it refuses", async () => {
        verifyDomain.mockRejectedValue(new Error("upstream"));
        verifyEmail.mockRejectedValue(new Error("upstream"));
        expect(await senderReputation("recordings@sender.example")).toEqual([]);
    });

    it("says nothing when it never answers, rather than holding the mail up", async () => {
        // The one that decides whether a broken provider is a slow sync or a
        // stopped one.
        vi.useFakeTimers();
        verifyDomain.mockImplementation(() => new Promise(() => undefined));
        const asking = senderReputation("recordings@sender.example");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await asking).toEqual([]);
    });

    it("says nothing about an address that is not one", async () => {
        expect(await senderReputation("")).toEqual([]);
        expect(await senderReputation("not-an-address")).toEqual([]);
        expect(verifyDomain).not.toHaveBeenCalled();
    });
});
