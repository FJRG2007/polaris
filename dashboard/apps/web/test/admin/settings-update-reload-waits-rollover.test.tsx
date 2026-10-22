// @vitest-environment jsdom

/**
 * The page reloads onto the new build only once the old one has stopped answering.
 *
 * While an update rolls over, both dashboards answer and the edge alternates
 * between them. Reloading on the first answer from the new build landed the page
 * in that overlap: the document from one container, a script from the other that
 * never had it, and a page left unhydrated - every value a skeleton until it was
 * reloaded by hand. Pinned: answers that still alternate never reload it, and the
 * new build answering on its own does.
 */

import { withMessages } from "../setup/i18n";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/admin/settings/actions", () => ({
    ownVulnerabilitiesAction: async () => null,
    checkUpdatesAction: async () => null,
    saveAutoUpdateAction: async () => ({}),
    saveLegalContactAction: async () => ({}),
    saveUpdateSourceAction: async () => ({}),
    triggerHostUpdateAction: async () => ({ status: "started" }),
    updateReportAction: async () => ({ url: "" })
}));
vi.mock("@/app/(app)/admin/settings/transfer-actions", () => ({
    applyImportAction: async () => ({}),
    exportInstanceAction: async () => ({}),
    previewImportAction: async () => ({})
}));
vi.mock("@/app/(app)/admin/domains/actions", () => ({ removeAddressAction: async () => ({}) }));
vi.mock("@/lib/use-password-safety", () => ({ usePasswordSafety: () => null }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => false }));

const { SettingsView } = await import("@/app/(app)/admin/settings/settings-view");

/** The build each successive log poll is answered by, in order; the last repeats. */
let answeredBy: string[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/updates/logs")) {
        const build = answeredBy.length > 1 ? answeredBy.shift()! : answeredBy[0];
        const now = Date.now();
        // An update still being written: the page re-attaches and tails it.
        return Response.json({
            exists: true,
            content: "",
            nextOffset: 0,
            size: 10,
            done: false,
            exitCode: null,
            finished: false,
            updatedAt: now,
            now,
            build
        });
    }
    return new Response("starting", { status: 502 });
});

const reload = vi.fn();

beforeEach(() => {
    reload.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...window.location, reload }
    });
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function view() {
    return render(
        withMessages(
            <SettingsView
                initialPolicy={{ mode: "daily", at: "04:00" }}
                initialSource="image"
                initialContact=""
                publicPages={{
                    home: "https://polaris.example.com/about",
                    privacy: "https://polaris.example.com/legal/privacy",
                    terms: "https://polaris.example.com/legal/terms"
                }}
                deployment={{
                    hostname: "polaris",
                    repo: "example/polaris",
                    branch: "main",
                    autoUpdate: true
                }}
            />
        )
    );
}

describe("reloading onto the new build", () => {
    it("does not reload while the old and the new dashboard both answer", async () => {
        // The mount read, then the edge alternating for as long as the overlap lasts.
        answeredBy = ["old", "new", "old", "new", "old", "new", "old", "new", "old", "new", "old"];
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(reload).not.toHaveBeenCalled();
    });

    it("reloads once the new dashboard is the only one answering", async () => {
        answeredBy = ["old", "new", "old", "new"];
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
