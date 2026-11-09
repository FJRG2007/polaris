/**
 * Marking Management seen in one window clears it in every other one.
 *
 * Seen is a mark on the server, not a notification, so the notification stream
 * had nothing to say about it: other tabs and the desktop app kept the count
 * until their five-minute sweep. The count now rides the stream's frames.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { waitingInFrame } from "@/components/admin-waiting";

const ROUTE = new URL("../../src/app/api/notifications/stream/route.ts", import.meta.url);

describe("Management's count on the notification stream", () => {
    it("is read off a frame that carries it", () => {
        const waiting = { reports: 1, cases: 0, update: true, apis: 0, total: 2 };
        expect(waitingInFrame(JSON.stringify({ items: [], waiting }))).toEqual(waiting);
    });

    it("is left to a recount when the frame has none", () => {
        expect(waitingInFrame(JSON.stringify({ items: [], waiting: null }))).toBeNull();
        expect(waitingInFrame(JSON.stringify({ items: [] }))).toBeNull();
        expect(waitingInFrame("not json")).toBeNull();
        expect(waitingInFrame(JSON.stringify({ waiting: { total: "2" } }))).toBeNull();
    });

    it("is put on the frame by the stream, for administrators only", async () => {
        const source = await readFile(ROUTE, "utf8");
        expect(source).toMatch(/isAdmin && Date\.now\(\) - waiting\.at >= WAITING_EVERY_MS/);
        expect(source).toMatch(/waiting: waiting\.value/);
    });
});
