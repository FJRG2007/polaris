/**
 * What the schedule screen actually puts on the page.
 *
 * The list is the part somebody reads every time and writes once, so what is
 * asserted here is that a row says what the window does without being opened -
 * the mode, both hours, the days, and the fact that it runs into the next
 * morning. A row that has to be opened to be understood is a row nobody trusts
 * enough to leave switched on.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleView } from "@/app/(app)/account/privacy/schedule/schedule-view";

// The writes are server actions, and importing one drags the whole request stack
// in behind it. Nothing here presses a button; this is about what is drawn.
vi.mock("@/app/(app)/account/privacy/schedule/actions", () => ({
    createScheduleAction: async () => ({}),
    updateScheduleAction: async () => ({}),
    setScheduleEnabledAction: async () => ({}),
    deleteScheduleAction: async () => ({})
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

function draw(schedules: core.PresenceScheduleRule[], timeZone = "Europe/Madrid"): string {
    return renderToStaticMarkup(<ScheduleView schedules={schedules} timeZone={timeZone} />);
}

const OVERNIGHT: core.PresenceScheduleRule = {
    id: "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
    presence: "invisible",
    days: core.EVERY_DAY,
    startMinute: 23 * 60,
    endMinute: 7 * 60,
    enabled: true
};

describe("the list", () => {
    it("says what a window does without it being opened", () => {
        const markup = draw([OVERNIGHT]);
        expect(markup).toContain("Invisible");
        expect(markup).toContain("23:00");
        expect(markup).toContain("07:00");
        expect(markup).toContain("the next day");
        expect(markup).toContain("Every day");
    });

    it("offers a way out of an empty screen rather than only stating it", () => {
        const markup = draw([]);
        expect(markup).toContain("No schedules yet");
        expect(markup).toContain("New schedule");
    });

    it("names the clock the hours are read on", () => {
        expect(draw([OVERNIGHT])).toContain("Europe/Madrid");
    });

    it("says so when there is no clock of the account's own to read them on", () => {
        // The one thing a schedule cannot work around by itself: "automatic" is
        // the device's zone, and the server resolving these has no device.
        const markup = draw([OVERNIGHT], core.AUTOMATIC_TIME_ZONE);
        expect(markup).toContain("Preferences");
        expect(markup).not.toContain("Times are read on your own clock");
    });

    it("gives every repeated icon action a name a screen reader can say", () => {
        const markup = draw([OVERNIGHT]);
        expect(markup).toContain('aria-label="Edit Invisible - 23:00 to 07:00 - Every day"');
        expect(markup).toContain('aria-label="Delete Invisible - 23:00 to 07:00 - Every day"');
    });
});
