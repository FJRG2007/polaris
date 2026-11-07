// @vitest-environment jsdom
/**
 * The Block ads and trackers switch on /account/tv moves the moment it is
 * pressed, waits on the TV once the change is kept, and goes back where it was
 * when the change is refused. Whether the TV reaches the Network filter arrives
 * after the page, in place of a skeleton.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { TvRow } from "@/lib/tv/update-requests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ID = "0190a000-0000-7000-8000-00000000000a";

const ASKED = "2026-11-07T10:00:00.000Z";

function tv(blocking: Omit<TvRow["blocking"], "askedAt"> & { askedAt?: string | null }): TvRow {
    return {
        id: ID,
        name: "Sample TV",
        versionName: "3.5",
        versionCode: 14,
        lastSeenAt: null,
        update: null,
        blocking: {
            ...blocking,
            askedAt: blocking.askedAt ?? (blocking.desired === null ? null : ASKED)
        },
        catalog: { theme: null, addons: null },
        address: "192.168.1.20"
    };
}

let answer: (result: { tvs: TvRow[]; latest: string | null; error?: string }) => void = () =>
    undefined;
const setTvBlockingAction = vi.fn(
    () =>
        new Promise<{ tvs: TvRow[]; latest: string | null; error?: string }>((resolve) => {
            answer = resolve;
        })
);
let reach: Record<string, string> = { [ID]: "reaching" };

const tvUpdatesAction = vi.fn(async () => ({
    tvs: [tv({ desired: true, applied: null })],
    latest: "3.5"
}));

// The gallery renders in its own test (packages/ui); here only the picker around it is under test.
vi.mock("@polaris/ui/tv-gallery", () => ({ TvGallery: () => null }));
vi.mock("@/app/(app)/account/tv/actions", () => ({
    tvUpdatesAction,
    requestTvUpdateAction: async () => ({ tvs: [], latest: "3.5" }),
    renameTvAction: async () => ({ tvs: [], latest: "3.5" }),
    setTvBlockingAction,
    tvCatalogAction: async () => [],
    setTvThemeAction: async () => ({ tvs: [], latest: "3.5" }),
    setTvAddonsAction: async () => ({ tvs: [], latest: "3.5" }),
    tvFilterReachAction: async () => reach
}));

const { TvUpdatesView } = await import("@/app/(app)/account/tv/tv-updates-view");

function show(row: TvRow) {
    render(
        <MessagesWrapper>
            <TvUpdatesView initial={{ tvs: [row], latest: "3.5" }} />
        </MessagesWrapper>
    );
    return screen.getByRole("switch");
}

beforeEach(() => {
    setTvBlockingAction.mockClear();
    reach = { [ID]: "reaching" };
});
afterEach(cleanup);

describe("the Block ads and trackers switch", () => {
    it("moves at once and waits on the TV once the change is kept", async () => {
        const toggle = show(tv({ desired: null, applied: "off" }));
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(setTvBlockingAction).toHaveBeenCalledWith({ keyId: ID, blocking: true });
        expect(screen.getByText("Waiting for the TV to apply it")).toBeTruthy();
        answer({ tvs: [tv({ desired: true, applied: null })], latest: "3.5" });
        await screen.findByText("Waiting for the TV to apply it");
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    });

    it("asks again when the same value is asked after a failure, instead of showing it", async () => {
        const toggle = show(tv({ desired: true, applied: "no-permission" }));
        expect(
            screen.getByText("Install the TV again from Polaris Desktop to allow it")
        ).toBeTruthy();
        fireEvent.click(toggle);
        answer({ tvs: [tv({ desired: false, applied: null })], latest: "3.5" });
        fireEvent.click(await screen.findByRole("switch", { checked: false }));
        expect(setTvBlockingAction).toHaveBeenLastCalledWith({ keyId: ID, blocking: true });
        expect(screen.getByText("Waiting for the TV to apply it")).toBeTruthy();
    });

    it("stops asking the server once a TV has been waited on for a while", async () => {
        vi.useFakeTimers();
        try {
            show(tv({ desired: true, applied: null }));
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            tvUpdatesAction.mockClear();
            await vi.advanceTimersByTimeAsync(30_000);
            expect(tvUpdatesAction).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("goes back where it was when the change is refused, and says why", async () => {
        const toggle = show(tv({ desired: false, applied: "off" }));
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        answer({
            tvs: [tv({ desired: false, applied: "off" })],
            latest: "3.5",
            error: "Too many changes. Wait a minute."
        });
        await screen.findByRole("alert");
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
        expect(screen.getByText("Off for this TV")).toBeTruthy();
    });

    it("replaces the skeleton with whether the TV reaches the Network filter", async () => {
        reach = { [ID]: "notReaching" };
        show(tv({ desired: null, applied: null }));
        await waitFor(() =>
            expect(screen.getByText("Not reaching the Network filter")).toBeTruthy()
        );
    });
});
