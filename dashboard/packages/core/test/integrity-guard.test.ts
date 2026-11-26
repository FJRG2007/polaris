// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPageCode, type GuardReply } from "../src/integrity-guard";
import type { PageVerdict } from "../src/integrity";

const OWN = "0123456789abcdef";
const CURRENT = "fedcba9876543210";
const TEXT = {
    words: { title: "Changed", body: "Changed body", files: "Files:", dismiss: "Close" },
    outdated: { body: "Older version", reload: "Reload", later: "Not now" }
};

function page(build: string | null, ...chunks: string[]): void {
    document.head.innerHTML = build ? `<meta name="polaris-build" content="${build}">` : "";
    for (const chunk of chunks) {
        const script = document.createElement("script");
        script.src = `/_next/static/chunks/${chunk}`;
        document.head.append(script);
    }
}

// A check hashes what it fetched (WebCrypto, off the main thread) before it asks,
// so a fixed number of ticks is not enough: each test waits for what it expects.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function asker(verdict: (build: string | null) => PageVerdict) {
    return vi.fn(async (_files: unknown, build: string | null): Promise<GuardReply> => ({ ...TEXT, verdict: verdict(build) }));
}

afterEach(() => {
    document.documentElement.querySelectorAll("[id^=polaris-integrity]").forEach((node) => node.remove());
    vi.unstubAllGlobals();
});

describe("page code watcher", () => {
    // Every test, not only the first: `afterEach` takes the stubs away.
    beforeEach(() => {
        vi.stubGlobal("fetch", async () => new Response("code"));
    });

    it("names the build the document says served it", async () => {
        page(OWN, "a.js");
        const ask = asker((build) => ({ kind: "verified", build: build ?? CURRENT, checked: 1 }));
        watchPageCode(ask);
        await vi.waitFor(() => expect(ask).toHaveBeenCalledWith([expect.objectContaining({ path: "/_next/static/chunks/a.js" })], OWN));
    });

    it("offers a reload for a page of an earlier build, with no warning and no locked fields", async () => {
        page(OWN, "b.js");
        document.body.innerHTML = '<input type="password">';
        watchPageCode(asker(() => ({ kind: "outdated", build: OWN, current: CURRENT, checked: 1 })));
        await vi.waitFor(() => expect(document.getElementById("polaris-integrity-outdated")).not.toBeNull());
        expect(document.getElementById("polaris-integrity-warning")).toBeNull();
        expect(document.querySelector<HTMLInputElement>("input")?.readOnly).toBe(false);
    });

    it("warns over a changed page", async () => {
        page(OWN, "c.js");
        watchPageCode(asker(() => ({ kind: "changed", build: OWN, paths: ["/_next/static/chunks/c.js"] })));
        await vi.waitFor(() => expect(document.getElementById("polaris-integrity-warning")).not.toBeNull());
        expect(document.getElementById("polaris-integrity-outdated")).toBeNull();
    });

    it("without the tag, keeps the build its first check was judged against", async () => {
        page(null, "d.js");
        const ask = asker(() => ({ kind: "verified", build: CURRENT, checked: 1 }));
        const observers: Array<() => void> = [];
        vi.stubGlobal(
            "PerformanceObserver",
            class {
                constructor(run: () => void) {
                    observers.push(run);
                }
                observe(): void {}
            }
        );
        watchPageCode(ask);
        await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
        expect(ask.mock.calls[0]?.[1]).toBeNull();
        // The first verdict lands after its ask resolves.
        await settle();
        // A chunk loaded later is judged against that same build.
        const script = document.createElement("script");
        script.src = "/_next/static/chunks/e.js";
        document.head.append(script);
        observers[0]?.();
        await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2), { timeout: 2_000 });
        expect(ask.mock.calls[1]?.[1]).toBe(CURRENT);
    });
});
