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
const publishChatChange = vi.fn();
vi.mock("../../src/lib/chat/live", () => ({ publishChatChange }));

const { checkMessageLinks, flaggedLinksFor, resetLinkSafetyBudget } = await import(
    "../../src/lib/chat/link-safety"
);

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
        // VirusTotal's free tier: four a minute.
        expect(lookupDomain).toHaveBeenCalledTimes(4);
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
});
