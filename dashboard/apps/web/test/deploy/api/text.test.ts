/**
 * The Deploy API's text form, which is what the CLI prints.
 */

import { describe, expect, it } from "vitest";
import { linesSince, textTable } from "@/lib/deploy/api/text";

describe("textTable", () => {
    it("writes a header and one tab-separated line per row", () => {
        const table = textTable(
            [
                { name: "api", status: "running" },
                { name: "web", status: null }
            ],
            [
                ["NAME", (row) => row.name],
                ["STATUS", (row) => row.status]
            ]
        );
        expect(table).toBe("NAME\tSTATUS\napi\trunning\nweb\t-\n");
    });

    it("keeps a value with a tab or a newline in it on its own line", () => {
        const table = textTable([{ message: "fix:\tthe\nbuild" }], [["MESSAGE", (row) => row.message]]);
        expect(table).toBe("MESSAGE\nfix: the build\n");
    });
});

describe("linesSince", () => {
    const log = [
        "2026-09-10T10:00:00.123456789Z first",
        "2026-09-10T10:00:00.5Z second",
        "    at a stack frame that belongs to the second line",
        "2026-09-10T10:00:01.25Z third"
    ].join("\n");

    it("keeps only what came after the last line already printed", () => {
        expect(linesSince(log, "2026-09-10T10:00:00.5Z")).toBe("2026-09-10T10:00:01.25Z third");
    });

    it("compares fractions as numbers, where Docker drops the trailing zeros", () => {
        // As bare text "01Z" sorts after "01.25Z" ("Z" is after "."), which would
        // drop a line that is a quarter of a second later.
        expect(linesSince(log, "2026-09-10T10:00:01Z")).toBe("2026-09-10T10:00:01.25Z third");
    });

    it("keeps an unstamped line with the stamped line above it", () => {
        expect(linesSince(log, "2026-09-10T10:00:00.2Z")).toContain("at a stack frame");
        // And drops it with that line when the line itself was already printed.
        expect(linesSince(log, "2026-09-10T10:00:00.7Z")).not.toContain("at a stack frame");
    });

    it("returns everything when it cannot read the timestamp it was given", () => {
        expect(linesSince(log, "yesterday")).toBe(log);
    });
});
