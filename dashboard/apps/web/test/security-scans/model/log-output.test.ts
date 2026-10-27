/**
 * A one-off scanner's output as the engine hands it back: read with
 * `--timestamps`, with every line longer than 16 KiB stored as partial
 * messages that each carry the line's stamp. The report below is fixture data
 * shaped like the matcher's single-line JSON, large enough to be split.
 */

import { describe, expect, it } from "vitest";
import * as parse from "@polaris-app/security-scans/src/model/parse";

/** The engine's buffer: a longer line is stored in pieces of this size. */
const PIECE = 16 * 1024;

function report(matches: number): string {
    return JSON.stringify({
        matches: Array.from({ length: matches }, (_, index) => ({
            vulnerability: {
                id: `CVE-2026-${10_000 + index}`,
                severity: index % 4 === 0 ? "Critical" : "High",
                description: "Fixture advisory text ".repeat(20),
                fix: { versions: [`1.${index}.1`], state: "fixed" },
                cvss: [{ vector: "CVSS:3.1/AV:N/AC:L", metrics: { baseScore: 9.8 } }]
            },
            artifact: {
                name: `fixture-package-${index}`,
                version: `1.${index}.0`,
                cpes: [`cpe:2.3:a:fixture:package-${index}:1.${index}.0:*:*:*:*:*:*:*`],
                locations: [{ path: "/lib/apk/db/installed", layerID: `sha256:${"a".repeat(64)}` }]
            }
        })),
        descriptor: { name: "fixture-matcher", version: "0.0.0" }
    });
}

/** What `logs --timestamps` prints for one line the container wrote. */
function stamped(line: string, stamp: string): string {
    let out = "";
    for (let at = 0; at < line.length; at += PIECE) {
        out += `${stamp} ${line.slice(at, at + PIECE)}`;
    }
    return `${out}\n`;
}

const STAMP = "2026-01-02T03:04:05.123456789Z";

describe("scanner output read with stamps", () => {
    const json = report(120);

    it("is large enough that the engine splits it", () => {
        expect(json.length).toBeGreaterThan(PIECE * 4);
    });

    it("cannot be read as it arrives - the stamps land inside the report", () => {
        expect(parse.jsonOf(stamped(json, STAMP))).toBeNull();
    });

    it("reads back whole once the stamps are cut", () => {
        const value = parse.jsonOf(parse.unstampLog(stamped(json, STAMP)));
        const read = parse.parseVulnJson(value)!;
        expect(read.total).toBe(120);
        expect(read.counts.critical).toBe(30);
        expect(read.counts.high).toBe(90);
        expect(read.items[0]!.fixedIn).toMatch(/^1\.\d+\.1$/);
    });

    it("keeps the report when diagnostics with braces share the stream", () => {
        const log =
            stamped("[0000] ERROR failed to update {retrying}", "2026-01-02T03:04:04.000000001Z") +
            stamped(json, STAMP) +
            stamped("[0001]  WARN done {ok}", "2026-01-02T03:04:06.000000002Z");
        const read = parse.parseVulnJson(parse.jsonOf(parse.unstampLog(log)));
        expect(read?.total).toBe(120);
    });

    it("cuts a stamp with an offset and the carriage returns of a terminal", () => {
        const log = stamped(json, "2026-01-02T05:04:05.123456789+02:00").replace(/\n/g, "\r\n");
        expect(parse.parseVulnJson(parse.jsonOf(parse.unstampLog(log)))?.total).toBe(120);
    });

    it("leaves output without stamps as it was", () => {
        expect(parse.unstampLog("plain line\nanother")).toBe("plain line\nanother");
    });

    it("lets the line parsers see the scanner's own lines", () => {
        const log = parse.unstampLog(
            stamped("/scan/0/uploads/eicar.txt: Eicar-Test-Signature FOUND", STAMP) +
                stamped("POLARIS_EXIT code=1", "2026-01-02T03:04:06.000000000Z")
        );
        expect(parse.parseMalwareLog(log)).toMatchObject({
            hits: [{ volume: 0, path: "uploads/eicar.txt", signature: "Eicar-Test-Signature" }],
            exitCode: 1
        });
    });

    it("finds nothing in output with no report", () => {
        expect(parse.jsonOf(parse.unstampLog(stamped("Error: no such image", STAMP)))).toBeNull();
    });

    it("keeps an unreadable start to one bounded line for the server log", () => {
        expect(parse.outputHead("a\u0000b\nc", 4)).toBe("a b");
        expect(parse.outputHead("x".repeat(500)).length).toBe(300);
    });
});
