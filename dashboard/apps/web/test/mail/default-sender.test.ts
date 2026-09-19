// @vitest-environment jsdom

/**
 * Which mailbox a new message starts on.
 *
 * The one on screen, then the one last used on this shelf, then the first - and
 * never a mailbox that is not on the shelf being worked from, which is how a
 * work message ends up leaving from a personal address. A reply is not asked:
 * its seed names the mailbox it arrived in.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    defaultSender,
    mailboxInView,
    rememberSender,
    rememberedSender
} from "@/app/(app)/mail/default-sender";

// Resolved from where the suite runs: under jsdom `import.meta.url` is not a
// file address.
const SRC = `${resolve("src")}/`;

const WORK = "0198f0aa-0000-7000-8000-00000000000a";
const HOME = "0198f0aa-0000-7000-8000-00000000000b";
const ELSEWHERE = "0198f0aa-0000-7000-8000-00000000000c";
const folders = [
    { id: "f-work-inbox", accountId: WORK },
    { id: "f-home-sent", accountId: HOME }
];
const shelf = [{ id: WORK }, { id: HOME }];

/** A browser storage this environment can be trusted to have, and one that
 *  refuses, which is what a private window does. */
function storage(refuses = false) {
    const values = new Map<string, string>();
    const fail = () => {
        throw new Error("storage is off");
    };
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => (refuses ? fail() : (values.get(key) ?? null)),
            setItem: (key: string, value: string) => (refuses ? fail() : values.set(key, value)),
            removeItem: (key: string) => values.delete(key),
            clear: () => values.clear()
        }
    });
}

beforeEach(() => storage());
afterEach(() => storage());

describe("the mailbox on screen", () => {
    it("is the one a mailbox's own view names", () => {
        expect(mailboxInView(`/mail/a/${WORK}`, folders)).toBe(WORK);
    });

    it("is the owner of the folder being read", () => {
        expect(mailboxInView("/mail/f/f-home-sent", folders)).toBe(HOME);
    });

    it("is nobody in a merged view, a label, a conversation or settings", () => {
        for (const path of ["/mail", "/mail/starred", "/mail/label/x", "/mail/t/x", "/mail/settings/general"]) {
            expect(mailboxInView(path, folders), path).toBeNull();
        }
    });

    it("is nobody for a folder this rail does not have", () => {
        expect(mailboxInView("/mail/f/unknown", folders)).toBeNull();
    });
});

describe("where a new message starts", () => {
    it("is the mailbox on screen first", () => {
        expect(defaultSender({ inView: HOME, remembered: WORK, visible: shelf })).toBe(HOME);
    });

    it("is the one last used when the screen is not one mailbox", () => {
        expect(defaultSender({ inView: null, remembered: HOME, visible: shelf })).toBe(HOME);
    });

    it("is the first mailbox when nothing else says", () => {
        expect(defaultSender({ inView: null, remembered: null, visible: shelf })).toBe(WORK);
    });

    it("is never a mailbox from another shelf, or one since removed", () => {
        expect(defaultSender({ inView: ELSEWHERE, remembered: ELSEWHERE, visible: shelf })).toBe(WORK);
    });

    it("is nothing at all with no mailbox on the shelf", () => {
        expect(defaultSender({ inView: null, remembered: HOME, visible: [] })).toBe("");
    });
});

describe("what this browser remembers", () => {
    it("is kept per shelf", () => {
        rememberSender("personal", HOME);
        rememberSender("org-1", WORK);
        expect(rememberedSender("personal")).toBe(HOME);
        expect(rememberedSender("org-1")).toBe(WORK);
        expect(rememberedSender("org-2")).toBeNull();
    });

    it("is nothing, not a fault, when the browser keeps nothing", () => {
        storage(true);
        expect(() => rememberSender("personal", HOME)).not.toThrow();
        expect(rememberedSender("personal")).toBeNull();
    });
});

describe("who asks", () => {
    it("is the shell, for every way into the composer that names no mailbox", async () => {
        const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");
        const open = shell.slice(shell.indexOf("const openComposer = useCallback"));
        const body = open.slice(0, open.indexOf("const value = useMemo"));
        expect(body).toContain("draft && !draft.accountId");
        expect(body).toContain("remembered: rememberedSender(shelf)");
        expect(body).toContain("visible: accounts");
    });

    it("remembers the mailbox somebody is in, and the one they sent from", async () => {
        const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");
        expect(shell).toContain("rememberSender(shelf, inView)");
        const composer = await readFile(`${SRC}app/(app)/mail/composer.tsx`, "utf8");
        expect(composer).toContain("rememberSender(shelf, accountId)");
    });

    it("leaves a reply on the mailbox its message arrived in", async () => {
        const answering = await readFile(`${SRC}app/(app)/mail/answering.ts`, "utf8");
        expect(answering.match(/accountId: message\.accountId/g)).toHaveLength(2);
    });
});
