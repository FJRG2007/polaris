/**
 * The check that runs on a chat message's links after it is sent.
 *
 * What is pinned is what keeps it affordable and quiet: a link is bought once
 * however many messages carry it, a provider is never sent more than its budget,
 * nothing at all happens when no provider is on, and an edit replaces what the
 * previous version of the message was flagged for.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MESSAGE = "018f2b7a-0000-7000-8000-0000000000a1";

const state = vi.hoisted(() => ({
    settings: null as string | null,
    enabled: new Set<string>(),
    bodies: new Map<string, string[]>(),
    cache: new Map<string, { allow: boolean; reason: string | null }>(),
    flags: [] as { messageId: string; url: string; provider: string; reason: string | null }[]
}));

const lookupDomain = vi.fn();
const verifyUrl = vi.fn();

vi.mock("@polaris/db", () => {
    const chatMessageLinkFlag = {
        deleteMany: vi.fn(({ where }: { where: { messageId: string } }) => {
            const before = state.flags.length;
            state.flags = state.flags.filter((flag) => flag.messageId !== where.messageId);
            return Promise.resolve({ count: before - state.flags.length });
        }),
        createMany: vi.fn(({ data }: { data: typeof state.flags }) => {
            state.flags.push(...data);
            return Promise.resolve({ count: data.length });
        }),
        findMany: vi.fn(async () => state.flags)
    };
    return {
        prisma: {
            chatMessage: {
                // Each read takes the next body queued for the message, keeping
                // the last one: two reads per check, the second to see an edit.
                findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
                    const queue = state.bodies.get(where.id);
                    if (!queue?.length) return null;
                    const body = queue.length > 1 ? queue.shift()! : queue[0]!;
                    return { channelId: "c1", body, deletedAt: null };
                })
            },
            chatMessageLinkFlag,
            $transaction: vi.fn(async (work: Promise<unknown>[]) => Promise.all(work))
        }
    };
});
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => state.settings),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: vi.fn(async (provider: string) =>
        state.enabled.has(provider) ? { enabled: true } : null
    ),
    getIntegrationSecret: vi.fn(async (provider: string) =>
        state.enabled.has(provider) ? "test-key" : null
    )
}));
vi.mock("@/lib/reputation", () => ({
    knownReputation: vi.fn(
        async (kind: string, value: string, provider: string) =>
            state.cache.get(`${kind}:${value}:${provider}`) ?? null
    ),
    rememberReputation: vi.fn(
        async (
            kind: string,
            value: string,
            provider: string,
            verdict: { allow: boolean; reason: string | null }
        ) => {
            state.cache.set(`${kind}:${value}:${provider}`, verdict);
        }
    )
}));
vi.mock("@/lib/integrations/virustotal", () => ({ lookupDomain }));
vi.mock("@/lib/integrations/dymo", () => ({ verifyUrl }));
vi.mock("@/lib/domain-edge", () => ({
    dashboardHosts: vi.fn(async () => ["polaris.example"])
}));
const publishChatChange = vi.fn();
vi.mock("../../src/lib/chat/live", () => ({ publishChatChange }));

const { checkMessageLinks, flaggedLinksFor, isOutsideHost, resetLinkSafetyBudget } = await import(
    "../../src/lib/chat/link-safety"
);
const { takeLookup } = await import("../../src/lib/reputation-budget");

const { prisma } = await import("@polaris/db");

function turnOn(providers: string[]): void {
    state.settings = JSON.stringify({ enabled: true, providers });
    for (const provider of providers) state.enabled.add(provider);
}

beforeEach(() => {
    vi.clearAllMocks();
    resetLinkSafetyBudget();
    state.settings = null;
    state.enabled.clear();
    state.bodies.clear();
    state.cache.clear();
    state.flags = [];
    lookupDomain.mockImplementation(async (_key: string, host: string) =>
        host.startsWith("bad.")
            ? { kind: "malicious", malicious: 7, suspicious: 1 }
            : { kind: "clean", malicious: 0, suspicious: 0 }
    );
    verifyUrl.mockImplementation(async (_key: string, url: string) => ({
        fraud: url.includes("/scam")
    }));
});

describe("normalizeLink", () => {
    it("files one page under one address", () => {
        expect(core.normalizeLink("HTTPS://Example.COM.:443/Path?a=1&utm_source=x#top")).toBe(
            "https://example.com/Path?a=1"
        );
        expect(core.normalizeLink("http://example.com")).toBe("http://example.com/");
    });

    it("never sends credentials pasted into an address", () => {
        expect(core.normalizeLink("https://user:secret@example.com/x")).toBe(
            "https://example.com/x"
        );
    });

    it("refuses what is not a web address", () => {
        expect(core.normalizeLink("javascript:alert(1)")).toBeNull();
        expect(core.normalizeLink("not a link")).toBeNull();
        expect(core.normalizeLink(`https://example.com/${"a".repeat(600)}`)).toBeNull();
    });

    it("finds every link once, outside code", () => {
        const body =
            "see https://a.example/x, and `https://code.example` then https://a.example/x and https://b.example.";
        expect(core.linksIn(body, 10)).toEqual(["https://a.example/x", "https://b.example"]);
        expect(core.linksIn(body, 1)).toEqual(["https://a.example/x"]);
    });
});

describe("isOutsideHost", () => {
    it("answers for public hosts only", () => {
        expect(isOutsideHost("example.com", ["polaris.example"])).toBe(true);
        expect(isOutsideHost("8.8.8.8", [])).toBe(true);
        expect(isOutsideHost("notpolaris.example", ["polaris.example"])).toBe(true);
        expect(isOutsideHost("polaris.example", ["polaris.example"])).toBe(false);
        expect(isOutsideHost("172.16.0.1", [])).toBe(false);
        expect(isOutsideHost("[fd00::1]", [])).toBe(false);
        expect(isOutsideHost("box.internal", [])).toBe(false);
    });
});

describe("checkMessageLinks", () => {
    it("does nothing at all when it is off", async () => {
        state.enabled.add("virustotal");
        state.bodies.set(MESSAGE, ["https://bad.example/"]);
        await checkMessageLinks(MESSAGE);
        expect(prisma.chatMessage.findUnique).not.toHaveBeenCalled();
        expect(lookupDomain).not.toHaveBeenCalled();
    });

    it("does nothing when it is on but no provider is configured", async () => {
        state.settings = JSON.stringify({ enabled: true, providers: ["virustotal", "dymo"] });
        state.bodies.set(MESSAGE, ["https://bad.example/"]);
        await checkMessageLinks(MESSAGE);
        expect(prisma.chatMessage.findUnique).not.toHaveBeenCalled();
        expect(lookupDomain).not.toHaveBeenCalled();
        expect(verifyUrl).not.toHaveBeenCalled();
    });

    it("flags a bad link and leaves a clean one alone", async () => {
        turnOn(["virustotal"]);
        state.bodies.set(MESSAGE, ["https://bad.example/a and https://good.example/b"]);
        await checkMessageLinks(MESSAGE);
        const flags = await flaggedLinksFor([MESSAGE]);
        expect(flags.get(MESSAGE)).toEqual([
            {
                url: "https://bad.example/a",
                provider: "virustotal",
                reason: "8 security engines flag this domain"
            }
        ]);
    });

    it("asks once for a link however many messages carry it", async () => {
        turnOn(["virustotal", "dymo"]);
        state.bodies.set("m1", ["https://good.example/page"]);
        state.bodies.set("m2", ["again: https://good.example/page"]);
        await checkMessageLinks("m1");
        await checkMessageLinks("m2");
        expect(lookupDomain).toHaveBeenCalledTimes(1);
        expect(verifyUrl).toHaveBeenCalledTimes(1);
    });

    it("never sends a provider more than its budget", async () => {
        turnOn(["virustotal"]);
        const body = Array.from({ length: 8 }, (_, i) => `https://host${i}.example/`).join(" ");
        state.bodies.set(MESSAGE, [body]);
        await checkMessageLinks(MESSAGE);
        // Half of VirusTotal's free tier of four a minute: the rest is mail's.
        expect(lookupDomain).toHaveBeenCalledTimes(2);
    });

    it("leaves the mail filter room in the budget it shares", async () => {
        turnOn(["virustotal"]);
        const body = Array.from({ length: 8 }, (_, i) => `https://host${i}.example/`).join(" ");
        state.bodies.set(MESSAGE, [body]);
        await checkMessageLinks(MESSAGE);
        expect(takeLookup("virustotal")).toBe(true);
        expect(takeLookup("virustotal")).toBe(true);
        expect(takeLookup("virustotal")).toBe(false);
    });

    it("never tells anybody about this deployment's links or the network's own hosts", async () => {
        turnOn(["virustotal", "dymo"]);
        state.bodies.set(MESSAGE, [
            [
                "https://polaris.example/s/secret-token",
                "https://drive.polaris.example/share/abc",
                "http://localhost:3000/x",
                "http://192.168.1.10/admin",
                "http://10.0.0.5/",
                "http://[::1]/",
                "http://nas/",
                "http://printer.local/",
                "http://router.home.arpa/"
            ].join(" ")
        ]);
        await checkMessageLinks(MESSAGE);
        expect(lookupDomain).not.toHaveBeenCalled();
        expect(verifyUrl).not.toHaveBeenCalled();
    });

    it("asks Dymo about the page without its query string", async () => {
        turnOn(["dymo"]);
        state.bodies.set(MESSAGE, ["https://shop.example/scam?token=s3cret&id=1"]);
        await checkMessageLinks(MESSAGE);
        expect(verifyUrl).toHaveBeenCalledWith("test-key", "https://shop.example/scam");
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)?.map((f) => f.url)).toEqual([
            "https://shop.example/scam?token=s3cret&id=1"
        ]);
    });

    it("an edit replaces what the earlier version was flagged for", async () => {
        turnOn(["dymo"]);
        state.bodies.set(MESSAGE, ["https://shop.example/scam"]);
        await checkMessageLinks(MESSAGE);
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)?.map((f) => f.url)).toEqual([
            "https://shop.example/scam"
        ]);

        state.bodies.set(MESSAGE, ["fixed: https://shop.example/real"]);
        await checkMessageLinks(MESSAGE);
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)).toBeUndefined();
        // Both the warning appearing and it going away reach open screens.
        expect(publishChatChange).toHaveBeenCalledTimes(2);
    });

    it("leaves the result to the newer check when the message changed meanwhile", async () => {
        turnOn(["dymo"]);
        // Read once to check, then again to write: the second read sees an edit.
        state.bodies.set(MESSAGE, ["https://shop.example/scam", "edited"]);
        await checkMessageLinks(MESSAGE);
        expect(prisma.chatMessageLinkFlag.deleteMany).not.toHaveBeenCalled();
        expect(state.flags).toEqual([]);
    });

    it("shows no warning once link safety or the provider is turned off", async () => {
        turnOn(["dymo"]);
        state.bodies.set(MESSAGE, ["https://shop.example/scam"]);
        await checkMessageLinks(MESSAGE);
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)).toHaveLength(1);

        state.settings = JSON.stringify({ enabled: false, providers: ["dymo"] });
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)).toBeUndefined();

        state.settings = JSON.stringify({ enabled: true, providers: ["dymo"] });
        state.enabled.delete("dymo");
        expect((await flaggedLinksFor([MESSAGE])).get(MESSAGE)).toBeUndefined();
    });

    it("reads a page of messages in one query, whatever its size", async () => {
        turnOn(["dymo"]);
        await flaggedLinksFor(["m1", "m2", "m3"]);
        expect(prisma.chatMessageLinkFlag.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.chatMessageLinkFlag.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { messageId: { in: ["m1", "m2", "m3"] }, provider: { in: ["dymo"] } }
            })
        );
    });
});
