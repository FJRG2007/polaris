/**
 * The VTIMEZONE blocks Polaris writes for the zones it uses: read back by
 * ical.js - a client with no time-zone database of its own, the way Outlook
 * reads a file - they must give the same offsets `Intl` does, across the
 * daylight-saving changes, north and south, and for a zone with none.
 */

import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

/** The UTC offset, in minutes, that a client reading only the block gives a
 *  local wall time. */
function offsetFromBlock(block: string, wall: string): number {
    const component = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR`));
    const timezone = new ICAL.Timezone(component.getFirstSubcomponent("vtimezone")!);
    const time = ICAL.Time.fromDateTimeString(wall);
    return timezone.utcOffset(time) / 60;
}

/** What Intl says for the same wall time. */
function offsetFromIntl(zone: string, wall: string): number {
    const instant = engine.wallToInstant(engine.parseWall(wall), zone);
    return engine.zoneOffsetMinutes(instant, zone);
}

const SAMPLES = [
    "2026-01-15T12:00:00",
    "2026-03-20T12:00:00",
    "2026-04-15T12:00:00",
    "2026-07-01T12:00:00",
    "2026-10-20T12:00:00",
    "2026-11-15T12:00:00",
    "2026-12-31T12:00:00",
    "2029-06-01T09:00:00",
    "2031-12-01T09:00:00"
];

describe("a VTIMEZONE written from Intl", () => {
    for (const zone of ["Europe/Madrid", "America/New_York", "Australia/Sydney", "America/Santiago", "Asia/Tokyo", "Asia/Kolkata"]) {
        it(`gives ${zone} the offsets Intl does`, () => {
            const block = engine.vtimezoneFor(zone, 2026)!;
            expect(block).toContain(`TZID:${zone}`);
            for (const wall of SAMPLES) expect(offsetFromBlock(block, wall), `${zone} ${wall}`).toBe(offsetFromIntl(zone, wall));
        });
    }

    it("describes Madrid's change as the last Sunday of March and of October", () => {
        const block = engine.vtimezoneFor("Europe/Madrid", 2026)!;
        expect(block).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU");
        expect(block).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
        expect(block).toContain("TZOFFSETTO:+0200");
    });

    it("describes a change on the first weekday on or after a day the same way in every year", () => {
        // Israel: the Friday before the last Sunday of March (Fri>=23), which
        // is not the last Friday in 2028 or 2029.
        const block = engine.vtimezoneFor("Asia/Jerusalem", 2026)!;
        expect(block).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29");
        expect(block).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
        for (let year = 2026; year <= 2037; year++) {
            for (let day = 22; day <= 31; day++) {
                const wall = `${year}-03-${day}T12:00:00`;
                expect(offsetFromBlock(block, wall), wall).toBe(offsetFromIntl("Asia/Jerusalem", wall));
            }
        }
    });

    it("writes nothing for UTC or a zone Intl does not know", () => {
        expect(engine.vtimezoneFor("UTC", 2026)).toBeNull();
        expect(engine.vtimezoneFor("Nowhere/Middle", 2026)).toBeNull();
    });

    it("defines in the file every zone an event uses, once", () => {
        const event = engine.newEvent({
            summary: "Standup",
            start: { dateTime: "2026-06-01T09:00:00", tzid: "Europe/Madrid" },
            end: { dateTime: "2026-06-01T09:15:00", tzid: "America/New_York" }
        });
        const text = engine.serializeItem(engine.eventItem(event));
        expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(2);
        expect(text).toContain("TZID:Europe/Madrid");
        expect(text).toContain("TZID:America/New_York");
        // And the file reads back to the same item, its blocks now its own.
        const again = engine.parseCalendarText(text).items[0]!;
        expect(engine.serializeItem(again).match(/BEGIN:VTIMEZONE/g)).toHaveLength(2);
    });
});
