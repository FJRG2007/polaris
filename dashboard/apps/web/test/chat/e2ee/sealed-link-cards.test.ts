/**
 * Link cards in a sealed conversation (docs/chat-e2ee-mls.md, "Sealed link
 * cards"): the sender's page asks for the card and seals it inside the
 * message, readers draw it from the seal, and the server never attaches a
 * preview to a sealed row. A card asked for outside a sealed conversation,
 * where previews are off, or too often is refused.
 */

import type { LinkPreviewView } from "@/lib/chat/link-preview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15000 });

const state = vi.hoisted(() => ({
    sealed: true,
    previews: true,
    limited: false,
    row: null as null | { channelId: string; body: string; deletedAt: Date | null; authorId: string; e2eeEpoch: number | null }
}));

const spies = vi.hoisted(() => ({
    requirePostable: vi.fn(async () => ({})),
    requireChannel: vi.fn(async () => { throw new Error("reached the plain preview path"); }),
    unfurl: vi.fn(async () => undefined),
    knownPreviews: vi.fn(async (links: readonly string[]) => new Map(links.map((link) => [link, { view: { url: link } }]))),
    rateLimit: vi.fn(async () => ({ ok: !state.limited })),
    sealedLinkCardAction: vi.fn(async (): Promise<{ preview: LinkPreviewView | null }> => ({ preview: null })),
    sendSealed: vi.fn(async (_channelId: string, _bytes: Uint8Array) => "stored-1")
}));

vi.mock("@polaris/db", () => ({
    prisma: { chatMessage: { findUnique: async () => state.row } },
    Prisma: {}
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return { ...actual, requirePostable: spies.requirePostable, requireChannel: spies.requireChannel };
});
vi.mock("@/lib/chat/e2ee/sealed-conversation", () => ({
    conversationSealed: async () => state.sealed,
    sealedConversations: async () => new Set<string>()
}));
vi.mock("@/lib/chat/link-preview-policy", () => ({
    previewAllowed: async () => state.previews,
    instancePreviewsAllowed: async () => state.previews,
    previewsWithheld: async () => new Set<string>()
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: spies.rateLimit }));
vi.mock("@/lib/chat/link-preview", () => ({ knownPreviews: spies.knownPreviews, unfurl: spies.unfurl }));
vi.mock("@/app/(app)/chat/actions", () => ({ sealedLinkCardAction: spies.sealedLinkCardAction }));
vi.mock("@/lib/chat/e2ee/mls-browser", () => ({
    openBrowserDevice: async () => ({ ensureGroup: async () => undefined, sendSealed: spies.sendSealed }),
    browserDeviceId: () => "device-1"
}));
vi.mock("@/lib/chat/e2ee/account-key-client", () => ({ deviceAccountHpke: async () => null }));
vi.mock("@/lib/chat/e2ee/sealed-search-index", () => ({ SealedSearchIndex: { open: async () => ({ record: async () => undefined, close: () => undefined }) } }));

const messages = await import("@/lib/chat/messages");
const sealedChat = await import("@/lib/chat/e2ee/sealed-chat");
const { withOpened, openedCard } = await import("@/app/(app)/chat/opened-sealed");

const ACTOR = { id: "11111111-1111-4111-8111-111111111111" } as Parameters<typeof messages.sealedLinkCard>[0];
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const URL_ = "https://example.test/article";

const view: LinkPreviewView = {
    id: "p1",
    url: URL_,
    target: null,
    title: "An article",
    description: "What it says",
    author: "",
    siteName: "Example",
    accent: "#112233",
    hasImage: true,
    steam: null
};

beforeEach(() => {
    state.sealed = true;
    state.previews = true;
    state.limited = false;
    state.row = null;
    for (const spy of Object.values(spies)) spy.mockClear();
});

afterEach(() => {
    sealedChat.configureSealedChat(null);
    vi.useRealTimers();
});

describe("messages.sealedLinkCard", () => {
    it("looks the card up for somebody posting into a sealed conversation", async () => {
        const card = await messages.sealedLinkCard(ACTOR, CHANNEL, URL_);
        expect(card).toEqual({ url: URL_ });
        expect(spies.requirePostable).toHaveBeenCalledWith(ACTOR, CHANNEL);
        expect(spies.unfurl).toHaveBeenCalledWith(URL_);
    });

    it("refuses a conversation that is not sealed", async () => {
        state.sealed = false;
        expect(await messages.sealedLinkCard(ACTOR, CHANNEL, URL_)).toBeNull();
        expect(spies.unfurl).not.toHaveBeenCalled();
    });

    it("refuses where previews are off", async () => {
        state.previews = false;
        expect(await messages.sealedLinkCard(ACTOR, CHANNEL, URL_)).toBeNull();
        expect(spies.unfurl).not.toHaveBeenCalled();
    });

    it("refuses past the rate limit", async () => {
        state.limited = true;
        expect(await messages.sealedLinkCard(ACTOR, CHANNEL, URL_)).toBeNull();
        expect(spies.rateLimit).toHaveBeenCalledWith(`chat-sealed-card:${ACTOR.id}`, expect.any(Number), 60_000);
        expect(spies.unfurl).not.toHaveBeenCalled();
    });

    it("refuses what holds no link, and somebody who may not post", async () => {
        expect(await messages.sealedLinkCard(ACTOR, CHANNEL, "no address here")).toBeNull();
        expect(spies.unfurl).not.toHaveBeenCalled();
        spies.requirePostable.mockRejectedValueOnce(new Error("not a member"));
        await expect(messages.sealedLinkCard(ACTOR, CHANNEL, URL_)).rejects.toThrow("not a member");
        expect(spies.unfurl).not.toHaveBeenCalled();
    });
});

describe("messages.linkPreviewFor", () => {
    it("never attaches a card to a sealed row, even with a link in its stored body", async () => {
        state.row = { channelId: CHANNEL, body: URL_, deletedAt: null, authorId: ACTOR.id, e2eeEpoch: 3 };
        expect(await messages.linkPreviewFor(ACTOR, "m1")).toBeNull();
        expect(spies.requireChannel).not.toHaveBeenCalled();
        expect(spies.knownPreviews).not.toHaveBeenCalled();
        expect(spies.unfurl).not.toHaveBeenCalled();
    });

    it("still goes on to look a plain row's card up", async () => {
        state.row = { channelId: CHANNEL, body: URL_, deletedAt: null, authorId: ACTOR.id, e2eeEpoch: null };
        await expect(messages.linkPreviewFor(ACTOR, "m1")).rejects.toThrow("reached the plain preview path");
    });
});

describe("linkCardFor", () => {
    it("asks for nothing when the body holds no link", async () => {
        expect(await sealedChat.linkCardFor(CHANNEL, "just words")).toBeNull();
        expect(spies.sealedLinkCardAction).not.toHaveBeenCalled();
    });

    it("keeps the card's words and drops its stored id and picture", async () => {
        spies.sealedLinkCardAction.mockResolvedValueOnce({ preview: view });
        const card = await sealedChat.linkCardFor(CHANNEL, `look ${URL_}`);
        expect(spies.sealedLinkCardAction).toHaveBeenCalledWith(CHANNEL, URL_);
        expect(card).toEqual({ url: URL_, target: null, title: "An article", description: "What it says", author: "", siteName: "Example", accent: "#112233" });
    });

    it("goes without a card that does not parse, fails, or takes too long", async () => {
        spies.sealedLinkCardAction.mockResolvedValueOnce({ preview: { ...view, accent: "red" } });
        expect(await sealedChat.linkCardFor(CHANNEL, URL_)).toBeNull();
        spies.sealedLinkCardAction.mockRejectedValueOnce(new Error("offline"));
        expect(await sealedChat.linkCardFor(CHANNEL, URL_)).toBeNull();
        vi.useFakeTimers();
        spies.sealedLinkCardAction.mockReturnValueOnce(new Promise(() => undefined));
        const waiting = sealedChat.linkCardFor(CHANNEL, URL_);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await waiting).toBeNull();
    });
});

describe("sending a sealed message with a link", () => {
    it("seals the card inside the message and sends nothing about it in the clear", async () => {
        sealedChat.configureSealedChat("viewer-1");
        spies.sealedLinkCardAction.mockResolvedValueOnce({ preview: view });
        await sealedChat.sendSealedMessage({ channelId: CHANNEL, body: `read ${URL_}`, clientKey: crypto.randomUUID() });
        expect(spies.sendSealed).toHaveBeenCalledTimes(1);
        const [, bytes, meta] = spies.sendSealed.mock.calls[0] as unknown as [string, Uint8Array, Record<string, unknown>];
        const opened = sealedChat.decodeSealedContent(bytes);
        expect(opened?.link).toEqual({ url: URL_, target: null, title: "An article", description: "What it says", author: "", siteName: "Example", accent: "#112233" });
        expect(JSON.stringify(meta)).not.toContain("An article");
        expect(JSON.stringify(meta)).not.toContain(URL_);
    });

    it("sends without a card when none can be made", async () => {
        sealedChat.configureSealedChat("viewer-1");
        await sealedChat.sendSealedMessage({ channelId: CHANNEL, body: `read ${URL_}`, clientKey: crypto.randomUUID() });
        const bytes = (spies.sendSealed.mock.calls[0] as unknown as [string, Uint8Array])[1];
        expect(sealedChat.decodeSealedContent(bytes)?.link).toBeUndefined();
    });
});

describe("drawing a sealed card", () => {
    const sealedRow = { id: "m1", channelId: CHANNEL, body: "", sealed: true, link: null, preview: null, previewPending: true } as unknown as Parameters<typeof withOpened>[0][number];
    const link = { url: URL_, target: null, title: "An article", description: "What it says", author: "", siteName: "Example", accent: "#112233" };

    it("draws the card from the seal, with no stored id and no picture", () => {
        const [drawn] = withOpened([sealedRow], () => ({ body: `read ${URL_}`, link }));
        expect(drawn.link).toBe(URL_);
        expect(drawn.previewPending).toBe(false);
        expect(drawn.preview).toEqual(openedCard(link));
        expect(drawn.preview).toMatchObject({ id: "", hasImage: false, title: "An article" });
    });

    it("leaves the row's card alone when the seal carries none", () => {
        const [drawn] = withOpened([sealedRow], () => ({ body: "no link" }));
        expect(drawn.preview).toBeNull();
        expect(drawn.previewPending).toBe(true);
    });
});
