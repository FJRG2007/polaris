import { describe, expect, it } from "vitest";
import {
    DEFAULT_MAIL_SORT,
    MAIL_FILTERS,
    MAIL_FILTER_LABELS,
    MAIL_SORTS,
    MAIL_SORT_LABELS,
    mailListIsNarrowed,
    readMailFilter,
    readMailSort
} from "./mailbox-list.js";

describe("what the buttons above a list can say", () => {
    it("names every filter and every order", () => {
        // The labels are what the menu draws. One missing is a blank menu entry,
        // which is the kind of thing that ships.
        for (const filter of MAIL_FILTERS) expect(MAIL_FILTER_LABELS[filter]).toBeTruthy();
        for (const sort of MAIL_SORTS) expect(MAIL_SORT_LABELS[sort]).toBeTruthy();
    });

    it("reads mail newest first unless it is told otherwise", () => {
        expect(DEFAULT_MAIL_SORT).toBe("newest");
    });
});

describe("what an address asks for", () => {
    it("takes the ones it knows", () => {
        expect(readMailFilter("unread")).toBe("unread");
        expect(readMailSort("largest")).toBe("largest");
    });

    it("shows everything, in the usual order, for anything else", () => {
        // Somebody editing a URL, or a link from a version of this that offered
        // something this one does not. Neither is worth an error page.
        expect(readMailFilter("whatever")).toBe("");
        expect(readMailFilter(undefined)).toBe("");
        expect(readMailSort("whatever")).toBe(DEFAULT_MAIL_SORT);
        expect(readMailSort(null)).toBe(DEFAULT_MAIL_SORT);
    });
});

describe("whether the list is showing all of it", () => {
    it("is not narrowed by nothing at all", () => {
        expect(mailListIsNarrowed("", DEFAULT_MAIL_SORT)).toBe(false);
    });

    it("is narrowed by either half on its own", () => {
        expect(mailListIsNarrowed("unread", DEFAULT_MAIL_SORT)).toBe(true);
        expect(mailListIsNarrowed("", "largest")).toBe(true);
    });
});
