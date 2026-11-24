// @vitest-environment jsdom
/**
 * A document edited with Polaris out of reach: its changes kept on the device
 * as one merged update, sent when the server answers, retried on an edge or
 * server failure and shown as refused when the server says no, and what a
 * closing tab left put in line beside what already waited - never over it.
 */

import * as Y from "yjs";
import "fake-indexeddb/auto";
import { freshWebStorage } from "../helpers/memory-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reachability", () => ({ noteRequestFailure: () => undefined }));

const writes = await import("@/lib/offline/app-writes");
const office = await import("@/app/(app)/office/offline-writes");

const DOC = "0190a1b2-c3d4-7e5f-8a9b-0000000000d1";
const fetchMock = vi.fn();

/** A document typed into in two steps, and each step's update. */
function typed(): { steps: Uint8Array[]; text: (update: Uint8Array) => string } {
    const doc = new Y.Doc();
    const steps: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => steps.push(update));
    doc.getText("t").insert(0, "offline ");
    doc.getText("t").insert(8, "train");
    const text = (update: Uint8Array): string => {
        const read = new Y.Doc();
        Y.applyUpdate(read, update);
        return read.getText("t").toString();
    };
    return { steps, text };
}

async function drained(): Promise<void> {
    writes.appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    writes.appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
    freshWebStorage();
    writes.offlineStore.setOwner("u1");
    await writes.dropOfflineStore();
    writes.offlineStore.setOwner("u1");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

describe("a document's offline changes", () => {
    it("keeps them as one merged update while the server cannot be reached", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const { steps, text } = typed();
        for (const step of steps) {
            await office.keepOfficeUpdate({ documentId: DOC, update: step, origin: "tab" }, Y.mergeUpdates);
        }
        await drained();
        const waiting = await office.waitingOfficeUpdates(DOC);
        expect(waiting).toHaveLength(1);
        expect(waiting[0]?.state).toBe("pending");
        const payload = waiting[0]?.payload as { update: string };
        expect(text(office.fromBase64(payload.update))).toBe("offline train");
    });

    it("sends what waited when the server answers, and keeps nothing after", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        const { steps, text } = typed();
        await office.keepOfficeUpdate({ documentId: DOC, update: Y.mergeUpdates(steps), origin: "tab" }, Y.mergeUpdates);
        await drained();
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await drained();
        expect(await office.waitingOfficeUpdates(DOC)).toHaveLength(0);
        const [url, init] = fetchMock.mock.calls.at(-1) as [string, { body: Uint8Array }];
        expect(url).toBe(`/api/office/${DOC}/content?origin=tab`);
        expect(text(init.body)).toBe("offline train");
    });

    it("reads the content route's answers", () => {
        expect(office.readContentAnswer(204)).toEqual({ sent: "" });
        expect(office.readContentAnswer(502)).toBe("unreachable");
        expect(office.readContentAnswer(503)).toBe("unreachable");
        expect(office.readContentAnswer(429)).toBe("unreachable");
        expect(office.readContentAnswer(403)).toEqual({ refused: "403" });
        expect(office.readContentAnswer(413)).toEqual({ refused: "413" });
    });

    it("shows a refused change as failed and sends it again on retry", async () => {
        fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
        const { steps } = typed();
        await office.keepOfficeUpdate({ documentId: DOC, update: Y.mergeUpdates(steps), origin: "tab" }, Y.mergeUpdates);
        await drained();
        const [failed] = await office.waitingOfficeUpdates(DOC);
        expect(failed?.state).toBe("failed");
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await writes.appWrites.retry(failed!);
        await drained();
        expect(await office.waitingOfficeUpdates(DOC)).toHaveLength(0);
    });

    it("puts what a closing tab left beside what already waited, not over it", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const { steps, text } = typed();
        await office.keepOfficeUpdate({ documentId: DOC, update: steps[0]!, origin: "tab" }, Y.mergeUpdates);
        const stop = office.keepOfficeUpdateOnUnload(() => ({ documentId: DOC, update: steps[1]!, origin: "tab" }));
        window.dispatchEvent(new Event("pagehide"));
        stop();
        // The next page, in the same account: the modules load again, the
        // device's stores are what they were.
        vi.resetModules();
        const next = await import("@/lib/offline/app-writes");
        const nextOffice = await import("@/app/(app)/office/offline-writes");
        next.offlineStore.setOwner("u1");
        const waiting = await nextOffice.waitingOfficeUpdates(DOC);
        expect(window.localStorage.getItem("polaris-offline-unload:u1")).toBeNull();
        const merged = Y.mergeUpdates(
            waiting.map((entry) => office.fromBase64((entry.payload as { update: string }).update))
        );
        expect(text(merged)).toBe("offline train");
    });
});
