/**
 * How raw output becomes the lines the log viewer draws.
 *
 * The awkward part is that docker stamps EVERY line it emits, including the frames
 * of a stack trace - so a viewer that decided what continues an entry from the raw
 * line would break every multi-line error into separate rows the moment timestamps
 * were turned on. Continuation is judged on the message, after the stamp comes off.
 */

import { describe, expect, it } from "vitest";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";
import { formatLogTime, parseLog } from "../../src/lib/log-lines";

describe("splitting the timestamp off", () => {
    it("lifts docker's stamp out of the message", () => {
        const [entry] = parseLog("2026-07-30T14:09:26.123456789Z listening on :3000");

        expect(entry?.time).toBe("2026-07-30T14:09:26.123456789Z");
        expect(entry?.text).toBe("listening on :3000");
    });

    it("accepts the updater's stamp, which has no fractional seconds", () => {
        const [entry] = parseLog("2026-07-30T14:09:26Z polaris: pulling the published images");

        expect(entry?.time).toBe("2026-07-30T14:09:26Z");
        expect(entry?.text).toBe("polaris: pulling the published images");
    });

    it("leaves an unstamped line whole", () => {
        const [entry] = parseLog("npm warn deprecated request@2.88.2");

        expect(entry?.time).toBeNull();
        expect(entry?.text).toBe("npm warn deprecated request@2.88.2");
    });

    it("does not mistake a version or an ISO date inside a message for a stamp", () => {
        const [entry] = parseLog("released 2026-07-30T14:09:26Z");

        expect(entry?.time).toBeNull();
    });
});

describe("grouping and severity", () => {
    it("keeps a stamped stack trace as one entry", () => {
        const entries = parseLog(
            [
                "2026-07-30T14:09:26.000000000Z TypeError: undefined is not a function",
                "2026-07-30T14:09:26.000000001Z     at handler (/app/server.js:12:3)",
                "2026-07-30T14:09:26.000000002Z     at run (/app/server.js:40:1)"
            ].join("\n")
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.level).toBe("error");
        expect(entries[0]?.text).toContain("at run (/app/server.js:40:1)");
    });

    it("reads severity from the message, not from the stamp", () => {
        const entries = parseLog(
            ["2026-07-30T14:09:26Z connection refused", "2026-07-30T14:09:27Z ready in 240ms"].join("\n")
        );

        expect(entries[0]?.level).toBe("error");
        expect(entries[1]?.level).toBe("info");
    });
});

describe("showing the time", () => {
    const format = createDisplayFormat(DISPLAY_DEFAULTS);

    it("renders a stamp as wall-clock to the second", () => {
        expect(formatLogTime("2026-07-30T14:09:26.123456789Z", format)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("writes it on the reader's own clock", () => {
        const twelve = createDisplayFormat({ ...DISPLAY_DEFAULTS, clock: "12h" });

        expect(formatLogTime("2026-07-30T14:09:26Z", twelve)).toMatch(/^\d{1,2}:\d{2}:\d{2} (AM|PM)$/);
    });

    it("passes through anything it cannot read", () => {
        expect(formatLogTime("not-a-time", format)).toBe("not-a-time");
    });
});
