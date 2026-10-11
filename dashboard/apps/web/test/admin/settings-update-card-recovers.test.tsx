// @vitest-environment jsdom

/**
 * The update card fills in even when the first answer never comes.
 *
 * The page is most often opened right after an update, while the new dashboard
 * is still starting: the overview request fails and the automatic check is
 * refused. Before, both were asked once and the card stayed blank until the page
 * was reloaded by hand. Pinned: the overview is asked again until it answers, and
 * a refused check neither blanks the card nor throws.
 */

import { withMessages } from "../setup/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let checkRefused = true;
vi.mock("@/app/(app)/admin/settings/actions", () => ({
    checkUpdatesAction: async () => {
        if (checkRefused) throw new Error('Server Action "x" was not found on the server');
        return null;
    },
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
const { checkForNewBuild } = vi.hoisted(() => ({ checkForNewBuild: vi.fn(async () => false) }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild }));

const { SettingsView } = await import("@/app/(app)/admin/settings/settings-view");

const overview = {
    status: {
        phase: "up-to-date",
        source: "image",
        current: "running-abc",
        latest: "running-abc",
        behindBy: 0,
        upToDate: true,
        buildingCount: null,
        publishedAt: null,
        checks: null,
        checksUrl: null,
        url: "https://example.invalid/commits",
        checkedAt: new Date().toISOString()
    },
    addresses: [],
    publicIp: null,
    serverIp: null
};

/** How many overview requests fail before one answers. */
let failures = 0;
let failWith = 502;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/settings/overview")) {
        if (failures > 0) {
            failures -= 1;
            return new Response("starting", { status: failWith });
        }
        return new Response(JSON.stringify(overview), {
            headers: { "content-type": "application/json" }
        });
    }
    return new Response(JSON.stringify({ text: "", offset: 0, result: null }), {
        headers: { "content-type": "application/json" }
    });
});

beforeEach(() => {
    checkRefused = true;
    failures = 2;
    failWith = 502;
    fetchMock.mockClear();
    checkForNewBuild.mockClear();
    checkForNewBuild.mockResolvedValue(false);
    vi.stubGlobal("fetch", fetchMock);
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

describe("the update card after an update", () => {
    it("asks for the overview again until it answers, and then shows the running build", async () => {
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        const asked = fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("/overview")
        ).length;
        expect(asked).toBe(3);
        expect(screen.getAllByText("running-abc").length).toBeGreaterThan(0);
    });

    it("takes a refused check quietly and asks whether Polaris was updated", async () => {
        failures = 0;
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(checkForNewBuild).toHaveBeenCalled();
        expect(screen.getAllByText("running-abc").length).toBeGreaterThan(0);
        expect(screen.getByText("Could not check for updates. Try again in a moment.")).toBeTruthy();
    });

    it("says nothing about a refused check when a new build is what refused it", async () => {
        failures = 0;
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        checkForNewBuild.mockResolvedValue(true);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.queryByText("Could not check for updates. Try again in a moment.")).toBeNull();
    });

    it("stops asking for the overview when the answer is a refusal", async () => {
        failWith = 403;
        view();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        const asked = fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("/overview")
        ).length;
        expect(asked).toBe(1);
    });
});
