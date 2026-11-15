// @vitest-environment jsdom
/**
 * The tracker's opt-in automatic events: file downloads, form submissions,
 * mailto/tel links, 404 pages and hash routing. Run against the real file in a
 * DOM, because what matters is which beats a click or a submit produces.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = await readFile(join(process.cwd(), "public", "analytics.js"), "utf8");

interface Beat {
    type: string;
    url: string;
    name?: string;
    props?: Record<string, unknown>;
}

let beats: Beat[] = [];
const listeners: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];

function load(attributes: Record<string, string>): void {
    const tag = document.createElement("script");
    tag.src = "https://polaris.example/analytics.js";
    tag.setAttribute("data-key", "abcdefgh12");
    for (const [name, value] of Object.entries(attributes)) tag.setAttribute(name, value);
    Object.defineProperty(document, "currentScript", { value: tag, configurable: true });
    new Function(SOURCE)();
}

beforeEach(() => {
    beats = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => run());
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
            beats.push(JSON.parse(init.body) as Beat);
            return new Response(null, { status: 204 });
        })
    );
    // Keep each test's listeners from leaking into the next one.
    const original = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        listeners.push([type, listener, options]);
        original(type, listener, options);
    });
    window.history.replaceState(null, "", "/start");
    document.body.innerHTML = "";
});

afterEach(() => {
    for (const [type, listener, options] of listeners.splice(0)) window.removeEventListener(type, listener, options);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const events = () => beats.filter((beat) => beat.type === "event");

function click(html: string): void {
    document.body.innerHTML = html;
    const link = document.body.querySelector("a") as HTMLAnchorElement;
    link.addEventListener("click", (clicked) => clicked.preventDefault());
    link.click();
}

describe("file downloads", () => {
    it("records a link to a known file type", () => {
        load({ "data-downloads": "true", "data-auto": "false" });
        click('<a href="https://polaris.example/files/report.PDF">get</a>');
        expect(events()).toEqual([
            expect.objectContaining({ name: "file-download", props: { url: "https://polaris.example/files/report.PDF" } })
        ]);
    });

    it("records a link with a download attribute whatever its extension", () => {
        load({ "data-downloads": "true", "data-auto": "false" });
        click('<a href="/export" download>get</a>');
        expect(events()[0]?.name).toBe("file-download");
    });

    it("takes the site's own extension list", () => {
        load({ "data-downloads": "epub, .mobi", "data-auto": "false" });
        click('<a href="/book.mobi">get</a>');
        click('<a href="/book.pdf">get</a>');
        expect(events().map((beat) => beat.props?.url)).toEqual([`${window.location.origin}/book.mobi`]);
    });

    it("is off unless asked for", () => {
        load({ "data-auto": "false" });
        click('<a href="/report.pdf">get</a>');
        expect(events()).toEqual([]);
    });
});

describe("contact links", () => {
    it("records mailto and tel under data-outbound, without the prefilled text", () => {
        load({ "data-outbound": "true", "data-auto": "false" });
        click('<a href="mailto:sales@example.com?subject=Hello">mail</a>');
        click('<a href="tel:+34900000000">call</a>');
        expect(events().map((beat) => [beat.name, beat.props?.url])).toEqual([
            ["contact-link-click", "mailto:sales@example.com"],
            ["contact-link-click", "tel:+34900000000"]
        ]);
    });

    it("keeps reporting real outbound links", () => {
        load({ "data-outbound": "true", "data-auto": "false" });
        click('<a href="https://elsewhere.example/page">out</a>');
        expect(events()[0]).toMatchObject({ name: "outbound-link-click" });
    });
});

describe("form submissions", () => {
    it("records the form's target path and id", () => {
        load({ "data-forms": "true", "data-auto": "false" });
        document.body.innerHTML = '<form id="signup" action="/subscribe?x=1"></form>';
        const form = document.body.querySelector("form") as HTMLFormElement;
        form.addEventListener("submit", (submitted) => submitted.preventDefault());
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(events()).toEqual([expect.objectContaining({ name: "form-submit", props: { path: "/subscribe", id: "signup" } })]);
    });

    it("is off unless asked for", () => {
        load({ "data-auto": "false" });
        document.body.innerHTML = "<form></form>";
        document.body.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(events()).toEqual([]);
    });
});

describe("error pages and hash routing", () => {
    it("records a 404 for the address asked for", () => {
        window.history.replaceState(null, "", "/missing?q=1");
        load({ "data-404": "true", "data-auto": "false" });
        expect(events()).toEqual([expect.objectContaining({ name: "404", props: { path: "/missing?q=1" } })]);
    });

    it("counts the hash as part of the page when asked", async () => {
        window.history.replaceState(null, "", "/app#/inbox");
        load({ "data-hash": "true" });
        expect(beats.find((beat) => beat.type === "view")?.url).toBe("/app#/inbox");
        window.location.hash = "#/sent";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        expect(beats.filter((beat) => beat.type === "view").map((beat) => beat.url)).toEqual(["/app#/inbox", "/app#/sent"]);
    });

    it("ignores the hash by default", () => {
        window.history.replaceState(null, "", "/app#/inbox");
        load({});
        expect(beats.find((beat) => beat.type === "view")?.url).toBe("/app");
    });
});

describe("web vitals", () => {
    type Take = (entry: Record<string, unknown>) => void;
    let observers: Map<string, Take>;

    beforeEach(() => {
        observers = new Map();
        vi.stubGlobal(
            "PerformanceObserver",
            class {
                constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {}
                observe(options: { type: string }) {
                    observers.set(options.type, (entry) => this.callback({ getEntries: () => [entry] }));
                }
            }
        );
    });

    const vitalsBeats = () => beats.filter((beat) => beat.type === "vitals") as (Beat & { vitals: Record<string, number> })[];

    it("sends the measured metrics once, for the page they were measured on", () => {
        window.history.replaceState(null, "", "/landing");
        load({ "data-vitals": "true" });
        observers.get("largest-contentful-paint")?.({ startTime: 2300.4 });
        observers.get("paint")?.({ name: "first-contentful-paint", startTime: 900 });
        observers.get("layout-shift")?.({ hadRecentInput: false, value: 0.05, startTime: 100 });
        observers.get("layout-shift")?.({ hadRecentInput: false, value: 0.04, startTime: 400 });
        observers.get("layout-shift")?.({ hadRecentInput: true, value: 0.5, startTime: 500 });
        observers.get("event")?.({ interactionId: 7, duration: 180 });
        observers.get("event")?.({ interactionId: 0, duration: 900 });
        window.history.pushState(null, "", "/next");
        window.dispatchEvent(new Event("pagehide"));
        expect(vitalsBeats()).toHaveLength(1);
        expect(vitalsBeats()[0]).toMatchObject({ url: "/landing", vitals: { lcp: 2300, fcp: 900, cls: 0.09, inp: 180 } });
    });

    it("sends nothing unless asked for", () => {
        load({});
        window.dispatchEvent(new Event("pagehide"));
        expect(observers.size).toBe(0);
        expect(vitalsBeats()).toEqual([]);
    });
});

describe("one-tag options and page view properties", () => {
    it("sends the tag's data-prop attributes with every page view, and polaris.view's own", () => {
        load({ "data-auto": "false", "data-prop-author": "Jane" });
        (window as unknown as { polaris: { view: (url?: string, props?: object) => void } }).polaris.view("/a", { plan: "pro" });
        expect(beats.find((beat) => beat.type === "view")?.props).toEqual({ author: "Jane", plan: "pro" });
    });

    it("switches on what the site set in Polaris, unless the tag says otherwise", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: { body?: string }) => {
                if (!init?.body) return Response.json({ "data-outbound": true, "data-forms": true });
                beats.push(JSON.parse(init.body) as Beat);
                return new Response(null, { status: 204 });
            })
        );
        load({ "data-auto": "false", "data-forms": "false" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        click('<a href="https://elsewhere.example/page">out</a>');
        document.body.innerHTML = '<form action="/send"></form>';
        const form = document.body.querySelector("form") as HTMLFormElement;
        form.addEventListener("submit", (submitted) => submitted.preventDefault());
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(events().map((beat) => beat.name)).toEqual(["outbound-link-click"]);
    });
});
