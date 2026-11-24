/**
 * A plain click on a link to another site is opened outside before the page
 * starts to leave, so its `beforeunload` handlers (a call's hang-up among them)
 * never run for a page that was never going to leave.
 */

import { describe, expect, it } from "vitest";
import { outsideHref, type LinkClick } from "../../src/preload/outside-links";

const click = (overrides: Partial<LinkClick> = {}): LinkClick => ({
    href: "https://example.com/page",
    target: "",
    download: false,
    button: 0,
    modified: false,
    defaultPrevented: false,
    pageOrigin: "https://polaris.example.test",
    ...overrides
});

describe("outsideHref", () => {
    it("takes a plain click on another site", () => {
        expect(outsideHref(click())).toBe("https://example.com/page");
        expect(outsideHref(click({ target: "_self" }))).toBe("https://example.com/page");
        expect(outsideHref(click({ target: "_TOP" }))).toBe("https://example.com/page");
    });

    it("takes a mail link, which also starts a navigation", () => {
        expect(outsideHref(click({ href: "mailto:someone@example.com" }))).toBe("mailto:someone@example.com");
    });

    it("leaves the page's own links to the page", () => {
        expect(outsideHref(click({ href: "https://polaris.example.test/chat" }))).toBeNull();
    });

    it("leaves a new-window link, which never unloads this page", () => {
        expect(outsideHref(click({ target: "_blank" }))).toBeNull();
        expect(outsideHref(click({ target: "docs" }))).toBeNull();
    });

    it("leaves what the page or the user already decided", () => {
        expect(outsideHref(click({ defaultPrevented: true }))).toBeNull();
        expect(outsideHref(click({ modified: true }))).toBeNull();
        expect(outsideHref(click({ button: 1 }))).toBeNull();
        expect(outsideHref(click({ download: true }))).toBeNull();
    });

    it("never hands over anything that is not a web or mail address", () => {
        expect(outsideHref(click({ href: "file:///C:/Windows/system32/calc.exe" }))).toBeNull();
        expect(outsideHref(click({ href: "javascript:alert(1)" }))).toBeNull();
        expect(outsideHref(click({ href: "custom-scheme://run" }))).toBeNull();
        expect(outsideHref(click({ href: null }))).toBeNull();
        expect(outsideHref(click({ href: "not a url" }))).toBeNull();
    });
});
