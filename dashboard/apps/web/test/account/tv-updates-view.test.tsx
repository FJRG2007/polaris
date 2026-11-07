/**
 * The connected TVs on /account/tv: each row says what the TV runs and where its
 * update stands, and the Update button is offered only when there is something
 * for it to do. Block ads and trackers says whether the TV has done what was
 * asked, and the switch shows what was asked.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import type { TvRow } from "@/lib/tv/update-requests";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/account/tv/actions", () => ({
    tvUpdatesAction: async () => ({ tvs: [], latest: null }),
    requestTvUpdateAction: async () => ({ tvs: [], latest: null }),
    setTvBlockingAction: async () => ({ tvs: [], latest: null }),
    renameTvAction: async () => ({ tvs: [], latest: null }),
    tvFilterReachAction: async () => ({})
}));

const { TvUpdatesView, canUpdate, upToDate } =
    await import("@/app/(app)/account/tv/tv-updates-view");
const { blockingStatus, blockingSwitchOn, blockingWaiting } =
    await import("@/app/(app)/account/tv/tv-preferences");

function tv(overrides: Partial<TvRow> = {}): TvRow {
    return {
        id: "0190a000-0000-7000-8000-00000000000a",
        name: "Sample TV",
        versionName: "3.4",
        versionCode: 13,
        lastSeenAt: null,
        update: null,
        blocking: { desired: null, applied: null },
        address: "192.168.1.20",
        ...overrides
    };
}

function update(state: NonNullable<TvRow["update"]>["state"], reason: string | null = null) {
    return { versionName: "3.5", state, reason, at: "2026-11-07T10:00:00.000Z" };
}

function draw(tvs: TvRow[], latest: string | null, locale: "en-US" | "es-ES" = "en-US"): string {
    return renderToStaticMarkup(withMessages(<TvUpdatesView initial={{ tvs, latest }} />, locale));
}

describe("which TVs can be updated", () => {
    it("offers it to a TV that is behind, and not to one that is current or already asked", () => {
        expect(canUpdate(tv(), "3.5")).toBe(true);
        expect(canUpdate(tv({ versionName: "3.5" }), "3.5")).toBe(false);
        expect(canUpdate(tv({ update: update("downloading") }), "3.5")).toBe(false);
        expect(canUpdate(tv({ update: update("failed") }), "3.5")).toBe(true);
        expect(canUpdate(tv(), null)).toBe(false);
        expect(canUpdate(tv({ versionCode: null }), "3.5")).toBe(false);
    });

    it("counts an unreported version as not current", () => {
        expect(upToDate(tv({ versionName: null }), "3.5")).toBe(false);
    });
});

describe("the rows", () => {
    it("names the version a TV runs and the newest one", () => {
        const markup = draw([tv()], "3.5");
        expect(markup).toContain("Runs 3.4");
        expect(markup).toContain("Newest version: 3.5");
        expect(markup).toContain(">Update now<");
    });

    it.each([
        ["queued", "Queued for 3.5"],
        ["downloading", "Downloading 3.5"],
        ["waiting-confirmation", "Confirm on the TV"],
        ["installing", "Installing 3.5"]
    ] as const)("shows %s", (state, words) => {
        expect(draw([tv({ update: update(state) })], "3.5")).toContain(words);
    });

    it("shows a failure with its reason and offers to try again", () => {
        const markup = draw([tv({ update: update("failed", "No space left") })], "3.5");
        expect(markup).toContain("Update to 3.5 failed");
        expect(markup).toContain("No space left");
        expect(markup).toContain("Try again");
    });

    it("marks a current TV instead of offering the button", () => {
        const markup = draw([tv({ versionName: "3.5", update: update("done") })], "3.5");
        expect(markup).toContain("Up to date");
        expect(markup).not.toContain(">Update now<");
    });

    it("tells a TV that cannot take an update from here to update on the TV", () => {
        const markup = draw([tv({ versionCode: null })], "3.5");
        expect(markup).toContain("Update this one on the TV itself.");
        expect(markup).not.toContain(">Update now<");
    });

    it("offers Update all only with more than one TV", () => {
        expect(draw([tv()], "3.5")).not.toContain("Update all");
        expect(draw([tv(), tv({ id: "0190a000-0000-7000-8000-00000000000b" })], "3.5")).toContain(
            "Update all"
        );
    });

    it("says when no TV is connected, or no update is published", () => {
        expect(draw([], "3.5")).toContain("No TV is connected to your account.");
        expect(draw([tv()], null)).toContain("No TV update is published yet.");
    });

    it("speaks the reader's language", () => {
        expect(draw([tv({ update: update("waiting-confirmation") })], "3.5", "es-ES")).toContain(
            "Confirma en el TV"
        );
    });
});

describe("Block ads and trackers", () => {
    const at = (desired: boolean | null, applied: TvRow["blocking"]["applied"]) =>
        tv({ blocking: { desired, applied } });

    it("shows what the TV says when nobody asked from here", () => {
        expect(blockingStatus(at(null, null))).toBe("notAsked");
        expect(blockingStatus(at(null, "on"))).toBe("on");
        expect(blockingSwitchOn(at(null, "on"))).toBe(true);
        expect(blockingSwitchOn(at(null, "off"))).toBe(false);
    });

    it("waits on the TV until it reports what was asked", () => {
        expect(blockingStatus(at(true, null))).toBe("waiting");
        expect(blockingStatus(at(true, "off"))).toBe("waiting");
        expect(blockingStatus(at(false, "on"))).toBe("waiting");
        expect(blockingWaiting(at(true, "off"))).toBe(true);
        // The switch shows what was asked, not what the TV last said.
        expect(blockingSwitchOn(at(true, "off"))).toBe(true);
        expect(blockingSwitchOn(at(false, "on"))).toBe(false);
    });

    it("settles once the TV did it", () => {
        expect(blockingStatus(at(true, "on"))).toBe("on");
        expect(blockingStatus(at(false, "off"))).toBe("off");
        expect(blockingStatus(at(false, "left-as-set"))).toBe("off");
        expect(blockingWaiting(at(true, "on"))).toBe(false);
    });

    it("passes on why the TV could not turn it on", () => {
        for (const reason of ["failed", "unavailable", "no-permission", "no-filter"] as const) {
            expect(blockingStatus(at(true, reason))).toBe(reason);
            expect(blockingWaiting(at(true, reason))).toBe(false);
        }
    });

    it("draws the switch, its state, and holds a skeleton while the filter is asked", () => {
        const markup = draw([at(true, "no-filter")], "3.5");
        expect(markup).toContain("Block ads and trackers");
        expect(markup).toContain('role="switch" aria-checked="true"');
        expect(markup).toContain("No Network filter with encrypted DNS to use");
        expect(markup).toContain("animate-pulse");
        expect(markup).toContain('aria-label="Rename"');
    });

    it("speaks the reader's language", () => {
        expect(draw([at(true, null)], "3.5", "es-ES")).toContain(
            "Esperando a que el TV lo aplique"
        );
    });
});
