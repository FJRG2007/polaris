/**
 * Why pressing Starred is instant.
 *
 * Mail used to render its list on the server. Every press on the rail was
 * therefore a database query standing in front of the first pixel: nothing at
 * all appeared - not the toolbar, not the tabs, not the search box - until the
 * last row had been counted, and the previous screen sat there in the meantime.
 * It is the difference between an application and a website, and every mail
 * client that feels fast is on the other side of it.
 *
 * So the list is fetched by the browser, against a key that is the whole
 * narrowing, and painted from what this tab already holds while the request
 * goes. Three things hold that up, and each is one careless edit from being
 * undone:
 *
 * - the route must not go and get conversations itself;
 * - the narrowing must survive the trip and come back meaning the same thing;
 * - a list with nothing kept for it must draw rows rather than nothing.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mailPageSchema } from "@polaris/core";
import {
    mailPageParams,
    readMailPageParams,
    type MailPageNarrow
} from "@/lib/mailbox/page-params";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));

const NARROW: MailPageNarrow = {
    accountId: null,
    folderId: null,
    role: null,
    labelId: null,
    unreadOnly: false,
    readOnly: false,
    starredOnly: false,
    snoozedOnly: false,
    withAttachments: false,
    category: "",
    sort: "newest",
    query: ""
};

/** What the endpoint would make of a list, having only the query string. */
function roundTrip(page: MailPageNarrow) {
    const read = mailPageSchema.safeParse(readMailPageParams(mailPageParams(page)));
    expect(read.success).toBe(true);
    return read.success ? read.data : null;
}

describe("the narrowing survives the trip", () => {
    it("carries every part of a list that is narrowed every way at once", () => {
        const page: MailPageNarrow = {
            ...NARROW,
            accountId: "acc1",
            folderId: "fld1",
            role: "archive",
            labelId: "lbl1",
            withAttachments: true,
            category: "updates",
            sort: "largest",
            query: "invoice"
        };
        expect(roundTrip(page)).toMatchObject({
            accountId: "acc1",
            folderId: "fld1",
            role: "archive",
            labelId: "lbl1",
            withAttachments: true,
            category: "updates",
            sort: "largest",
            query: "invoice"
        });
    });

    it("does not turn a switch that is off into one that is on", () => {
        // The failure this exists for: a boolean written as a word and read back
        // as a string, where "false" is true. A mailbox that quietly forgot it
        // was filtered is a mailbox showing mail somebody asked not to see.
        const read = roundTrip({ ...NARROW, unreadOnly: true });
        expect(read?.unreadOnly).toBe(true);
        expect(read?.readOnly).toBe(false);
        expect(read?.starredOnly).toBe(false);
        expect(read?.snoozedOnly).toBe(false);
        expect(read?.withAttachments).toBe(false);
    });

    it("spells the same list the same way, because this is also a cache key", () => {
        // Two spellings of one list are two kept copies, one of which is always
        // stale. The order is the declaration's, not the caller's.
        const one = mailPageParams({ ...NARROW, role: "inbox", starredOnly: true }).toString();
        const two = mailPageParams({ ...NARROW, starredOnly: true, role: "inbox" }).toString();
        expect(one).toBe(two);
    });

    it("leaves out what is empty, so the plain inbox is a short key", () => {
        expect(mailPageParams({ ...NARROW, role: "inbox" }).toString()).toBe("role=inbox&sort=newest");
    });

    it("reads an address nobody wrote as the whole list rather than refusing", () => {
        // A query string somebody typed by hand, or one from a build that spelt
        // it differently. Anything missing falls back to the schema's own answer.
        const read = mailPageSchema.safeParse(readMailPageParams(new URLSearchParams()));
        expect(read.success).toBe(true);
    });
});

describe("the list route", () => {
    it("fetches no conversations of its own", async () => {
        const page = await readFile(`${SCREENS}list-page.tsx`, "utf8");
        // The two reads that used to be here, and the reason the screen waited.
        expect(page).not.toContain("listThreads");
        expect(page).not.toContain("readThread");
    });

    it("hands the browser what the list is rather than what is in it", async () => {
        const page = await readFile(`${SCREENS}list-page.tsx`, "utf8");
        expect(page).toContain("page={narrowOf(query)}");
        expect(page).toContain('openThreadId={params.open ?? ""}');
    });

    it("draws rows rather than nothing while the first one is on its way", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // `loading` is only ever true with nothing kept for this list, and the
        // answer to it is the shape of the rows - never a spinner over the whole
        // screen, which would take away a toolbar that already works.
        expect(view).toContain("{list.loading ? (");
        expect(view).toContain("<ThreadRowsSkeleton />");
        expect(view).toContain("<ConversationSkeleton />");
    });

    it("goes again when the live channel says a mailbox moved", async () => {
        // The rail and the counts come back with the router; the list and the
        // conversation are the browser's and would not notice. So a refresh is
        // also a number, and these watch it.
        const shell = await readFile(`${SCREENS}mail-shell.tsx`, "utf8");
        expect(shell).toContain("setRevision((count) => count + 1);");
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain("useMailList(page, revision)");
        expect(view).toContain("useMailThread(openThreadId, revision)");
    });
});
