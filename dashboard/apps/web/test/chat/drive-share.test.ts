/**
 * Sending a file that is already in Drive.
 *
 * It used to be a round trip of the whole file for nothing: Polaris read it off
 * the storage, handed the bytes to the browser, and the browser uploaded them
 * back so they could be written a second time. The per-file ceiling then refused
 * anything large - a limit about what this instance stores, applied to a file it
 * was already storing - and the hint under that very limit said "anything larger
 * belongs in Drive, with a link to it in the conversation".
 *
 * So what travels now is where the file is, and the instance decides what happens
 * to it: a copy read where the bytes already are, or a link to them. These pin the
 * half of that which is a decision rather than I/O - what the setting answers, and
 * what a request may ask for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The settings table, as the two functions under test see it. */
let stored: Record<string, string> = {};

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => stored[key] ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) delete stored[key];
        else stored[key] = value;
    }
}));

const share = await import("@/lib/chat/drive-share");

beforeEach(() => {
    stored = {};
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("what happens to a file sent from Drive", () => {
    it("is a copy until somebody says otherwise", async () => {
        // The answer every existing install already gives. An instance that has
        // never opened the screen must not have the promises of its old messages
        // quietly changed.
        expect(await share.driveShare()).toBe("copy");
    });

    it("is a link once an operator asks for one", async () => {
        await share.setDriveShare("link");
        expect(await share.driveShare()).toBe("link");
    });

    it("writes no row for the default, so the default can move", async () => {
        await share.setDriveShare("link");
        await share.setDriveShare("copy");
        expect(stored["chat.driveShare"]).toBeUndefined();
        expect(await share.driveShare()).toBe("copy");
    });

    it("reads anything else as a copy", async () => {
        // The value is a string in a settings table that other things write to.
        // Anything that is not the one word means the cautious answer, which is
        // the one that keeps its promises.
        stored["chat.driveShare"] = "linked";
        expect(await share.driveShare()).toBe("copy");
        stored["chat.driveShare"] = "";
        expect(await share.driveShare()).toBe("copy");
    });

    it("accepts only the two answers off a form", () => {
        expect(share.isDriveShare("copy")).toBe(true);
        expect(share.isDriveShare("link")).toBe(true);
        for (const value of ["", "LINK", "reference", null, undefined, 1, {}]) {
            expect(share.isDriveShare(value)).toBe(false);
        }
    });
});
