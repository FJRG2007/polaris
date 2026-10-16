/**
 * What an observation keeps beside its figures - whether the device answers,
 * its battery - goes into the one figures column and comes back out of it, and
 * a row written before any of it was kept reads as one that has none yet.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: {} }));

const store = await import("@polaris-app/places/src/lib/automation-store");

const SINCE = new Date("2026-09-30T06:00:00.000Z");

describe("an observation's figures column", () => {
    it("keeps whether the device answers and its battery", () => {
        const row = store.rowOf({
            state: "locked",
            stateSince: SINCE,
            door: "closed",
            doorSince: SINCE,
            reading: "",
            readingSince: SINCE,
            mode: "",
            modeSince: SINCE,
            online: "offline",
            onlineSince: SINCE,
            battery: "low",
            batterySince: SINCE,
            before: { online: "online" },
            version: 3
        });
        const back = store.figuresOf(JSON.parse(JSON.stringify(row.figures)));
        expect(back).toEqual({
            online: "offline",
            onlineSince: SINCE,
            battery: "low",
            batterySince: SINCE,
            before: { online: "online" }
        });
        expect(back.figures).toBeUndefined();
    });

    it("reads a row from before either was kept as having neither", () => {
        expect(store.figuresOf({ pm25: { value: "12", since: SINCE.toISOString() } })).toEqual({
            figures: { pm25: { value: "12", since: SINCE } }
        });
    });
});
