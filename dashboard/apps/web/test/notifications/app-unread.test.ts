/**
 * The badges that say somebody is waiting for you.
 *
 * There are four places one is drawn - the app switcher's entries, the dot on
 * the switcher itself, the rail, and the number on the tab icon - and each of
 * them used to name the apps it knew about. So when Mail learned to count, three
 * were taught and the fourth was not: the switcher showed a number against Mail
 * and no dot to say a number was there, which is exactly what a dot is for.
 *
 * These check the shape that fixed it rather than the pixels: one list of what
 * is waiting, and everything derived from it. The source checks are the ones
 * that matter - a hard-coded app id is the bug, and it is invisible while there
 * happen to be only two.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { anythingWaiting, totalWaiting } from "@/components/app-unread";

const COMPONENTS = new URL("../../src/components/", import.meta.url);

describe("what is waiting, gathered", () => {
    it("says nothing is waiting when nothing is", () => {
        expect(anythingWaiting({ chat: 0, mail: 0 })).toBe(false);
        expect(anythingWaiting({})).toBe(false);
    });

    it("says something is waiting whichever app it is in", () => {
        expect(anythingWaiting({ chat: 0, mail: 3 })).toBe(true);
        expect(anythingWaiting({ chat: 2, mail: 0 })).toBe(true);
        // The point of the shape: an app nothing here has heard of still raises
        // the dot, which is what stops the next one being forgotten.
        expect(anythingWaiting({ somethingNew: 1 })).toBe(true);
    });

    it("adds up to the one number a tab icon has room for", () => {
        expect(totalWaiting({ chat: 2, mail: 3 })).toBe(5);
        expect(totalWaiting({})).toBe(0);
    });
});

describe("the places a badge is drawn", () => {
    it("takes the switcher's dot from what is waiting, not from a list of apps", async () => {
        const source = await readFile(new URL("app-nav.tsx", COMPONENTS), "utf8");
        expect(source).toContain("anythingWaiting(waiting)");
        // The bug this replaced: chat named in the one place the dot came from.
        expect(source).not.toContain('app.id === "chat"');
        expect(source).not.toContain('app.id === "mail"');
    });

    it("takes each entry's number from the app it belongs to", async () => {
        const source = await readFile(new URL("app-nav.tsx", COMPONENTS), "utf8");
        expect(source).toContain("waiting[app.id]");
    });

    it("takes the rail's number the same way", async () => {
        const source = await readFile(new URL("app-sidebar.tsx", COMPONENTS), "utf8");
        expect(source).toContain("useAppUnread()");
        expect(source).not.toContain("CHAT_HREF");
        expect(source).not.toContain("MAIL_HREF");
    });

    it("adds every app up for the tab icon rather than two of them", async () => {
        const source = await readFile(new URL("notifications/notification-favicon.tsx", COMPONENTS), "utf8");
        expect(source).toContain("totalWaiting(useAppUnread())");
        expect(source).not.toContain("chat.messages");
        expect(source).not.toContain("mail.messages");
    });
});
