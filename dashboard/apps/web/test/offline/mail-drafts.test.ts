/**
 * A draft closed with Polaris out of reach: kept on the device, the newest
 * words only, saved to Drafts with the composer's key when Polaris answers,
 * asked again later while it is not there, shown as not saved when Polaris
 * refuses it, and forgotten once the composer saved something newer itself.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));
const filed = vi.fn(async (_id: string) => ({}));
vi.mock("@/app/(app)/mail/actions", () => ({ fileDraftOnServerAction: (id: string) => filed(id) }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { MAIL_DRAFT, draftSaved, keepDraft } = await import("@/app/(app)/mail/offline-drafts");

const ACCOUNT = "0198f0aa-0000-7000-8000-0000000000aa";
const KEY = "0198f0aa-0000-7000-8000-000000000001";
const DRAFT = "0198f0aa-0000-7000-8000-0000000000d2";
const draft = (body: string) => ({
    accountId: ACCOUNT,
    identityId: null,
    to: [{ name: "Ana", address: "ana@example.com" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    body,
    attachmentIds: ["0198f0aa-0000-7000-8000-0000000000f1"],
    inReplyToId: null,
    forward: false,
    id: null,
    draftKey: KEY,
    files: [{ id: "0198f0aa-0000-7000-8000-0000000000f1", name: "plan.pdf", size: 10 }]
});

const fetchMock = vi.fn();

async function drained(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
        appWrites.flush();
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const kept = async () => (await appWrites.readAll()).filter((entry) => entry.kind === MAIL_DRAFT);
const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    fetchMock.mockReset();
    filed.mockClear();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("a draft closed offline", () => {
    it("keeps only its newest words, and saves them with the composer's key once Polaris answers", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        expect(await keepDraft(draft("first"))).toBe(true);
        expect(await keepDraft(draft("newer"))).toBe(true);
        await drained();
        expect(await kept()).toHaveLength(1);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(answer(200, { draftId: DRAFT }));
        await drained();
        expect(await kept()).toHaveLength(0);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("/api/mail/drafts");
        const sent = JSON.parse(init.body);
        expect(sent).toMatchObject({ body: "newer", draftKey: KEY, id: null });
        expect(sent).not.toHaveProperty("files");
        expect(filed).toHaveBeenCalledWith(DRAFT);
    });

    it("waits while only the proxy answers, and is shown as not saved when Polaris refuses it", async () => {
        fetchMock.mockResolvedValue(answer(503, {}));
        await keepDraft(draft("x"));
        await drained();
        expect((await kept())[0]?.state).toBe("pending");

        fetchMock.mockResolvedValue(answer(403, { error: "That draft is not yours." }));
        await drained();
        const [entry] = await kept();
        expect(entry?.state).toBe("failed");
        expect(entry?.reason).toBe("That draft is not yours.");
    });

    it("is forgotten once the composer saved something newer itself", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        await keepDraft(draft("old"));
        draftSaved({ id: DRAFT, draftKey: KEY });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await kept()).toHaveLength(0);
    });
});
