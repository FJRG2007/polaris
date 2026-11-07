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

function tv(blocking: TvRow["blocking"]): TvRow {
    return {
        id: ID,
        name: "Sample TV",
        versionName: "3.5",
        versionCode: 14,
        lastSeenAt: null,
        update: null,
        blocking,
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

vi.mock("@/app/(app)/account/tv/actions", () => ({
    tvUpdatesAction: async () => ({ tvs: [], latest: "3.5" }),
    requestTvUpdateAction: async () => ({ tvs: [], latest: "3.5" }),
    renameTvAction: async () => ({ tvs: [], latest: "3.5" }),
    setTvBlockingAction,
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
        answer({ tvs: [tv({ desired: true, applied: "off" })], latest: "3.5" });
        await screen.findByText("Waiting for the TV to apply it");
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
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
