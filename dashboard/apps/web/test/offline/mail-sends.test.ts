/**
 * Mail sent with Polaris out of reach: kept on the device with a key of its
 * own, put in the outbox when Polaris answers, asked again later while Polaris
 * (or the proxy in front of it) is not there, and shown as not sent when
 * Polaris refuses it.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { MAIL_SEND, deliverSend, keepSend } = await import("@/app/(app)/mail/offline-sends");
const outbox = await import("@/app/(app)/mail/outbox");

const ACCOUNT = "0198f0aa-0000-7000-8000-0000000000aa";
const message = {
    accountId: ACCOUNT,
    identityId: null,
    to: [{ name: "Ana", address: "ana@example.com" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: "Hello",
    attachmentIds: [],
    inReplyToId: null,
    forward: false,
    sendAt: null,
    draftId: null
};

const fetchMock = vi.fn();

async function drained(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
        appWrites.flush();
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const kept = async () => (await appWrites.readAll()).filter((entry) => entry.kind === MAIL_SEND);
const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("a message sent offline", () => {
    it("is told apart from a refusal when Polaris never answered", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        expect(await outbox.queueMessage({ ...message })).toMatchObject({ unreachable: true });
        fetchMock.mockResolvedValueOnce(answer(502, null));
        expect(await outbox.queueMessage({ ...message })).toMatchObject({ unreachable: true });
        fetchMock.mockResolvedValueOnce(answer(400, { error: "Say who it goes to" }));
        expect(await outbox.queueMessage({ ...message })).toEqual({ error: "Say who it goes to" });
    });

    it("is kept with a key, and put in the outbox with that key when Polaris answers", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        expect(await keepSend({ ...message, sendAt: new Date("2026-12-01T09:00:00Z") })).toBe(true);
        await drained();
        const [entry] = await kept();
        expect(entry).toMatchObject({ state: "pending" });
        const payload = entry!.payload as { sendKey: string; sendAt: string };
        expect(payload.sendKey).toBe(entry!.key);
        expect(payload.sendAt).toBe("2026-12-01T09:00:00.000Z");

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(answer(200, { draftId: "d1", sendAt: "2026-12-01T09:00:00.000Z" }));
        await drained();
        expect(await kept()).toHaveLength(0);
        const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { sendKey: string };
        expect(sent.sendKey).toBe(payload.sendKey);
    });

    it("waits while Polaris is down, busy or still taking it, and is not sent when refused", async () => {
        for (const status of [409, 429, 503, 504]) {
            fetchMock.mockResolvedValueOnce(answer(status, null));
            expect(await deliverSend({ payload: message })).toBe("unreachable");
        }
        fetchMock.mockResolvedValueOnce(answer(404, { error: "That mailbox is not yours." }));
        expect(await deliverSend({ payload: message })).toEqual({ refused: "That mailbox is not yours." });

        fetchMock.mockResolvedValue(answer(400, { error: "Say who it goes to" }));
        await keepSend({ ...message });
        await drained();
        const [entry] = await kept();
        expect(entry).toMatchObject({ state: "failed", reason: "Say who it goes to" });
    });
});
