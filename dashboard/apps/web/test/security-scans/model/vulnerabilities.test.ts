/**
 * Image vulnerabilities as the matcher reports them: the layer a package came
 * in with, the advisory link, and which findings ring the bell - once.
 * The fixture is fixture data shaped like the matcher's JSON output.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as parse from "@polaris-app/security-scans/src/model/parse";

const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "grype-node-image.json"), "utf8");

describe("image vulnerability report", () => {
    const report = parse.parseVulnJson(parse.jsonOf(FIXTURE))!;

    it("names the runtime, its version and the version that fixes it", () => {
        const node = report.items.find((item) => item.packageName === "node")!;
        expect(node).toMatchObject({
            id: "CVE-2026-111497",
            severity: "high",
            version: "22.20.0",
            fixedIn: "22.23.4",
            url: "https://nvd.nist.gov/vuln/detail/CVE-2026-111497"
        });
    });

    it("keeps the layer only when it is a digest", () => {
        const [critical, high] = report.items;
        expect(critical!.layer).toBeNull();
        expect(high!.layer).toBe(`sha256:${"1".repeat(64)}`);
    });

    it("links an advisory the matcher gave no link for", () => {
        expect(report.items.find((i) => i.id.startsWith("GHSA"))!.url).toBe(
            "https://github.com/advisories/GHSA-2222-3333-4444"
        );
        expect(parse.advisoryLink("CVE-2099-0001")).toBe(
            "https://nvd.nist.gov/vuln/detail/CVE-2099-0001"
        );
        expect(parse.advisoryLink("DSA-5000-1")).toBe("https://osv.dev/vulnerability/DSA-5000-1");
        expect(parse.advisoryLink("not an id")).toBeNull();
    });

    it("rolls up the counts and sets the serious ones apart, uncapped", () => {
        expect(report.counts).toMatchObject({ critical: 1, high: 1, medium: 1, low: 0 });
        expect(report.alerting.map((i) => i.id)).toEqual(["CVE-2099-0001", "CVE-2026-111497"]);
        const capped = parse.parseVulnJson(parse.jsonOf(FIXTURE), 1)!;
        expect(capped.items).toHaveLength(1);
        expect(capped.alerting).toHaveLength(2);
    });
});

describe("alerts across rescans", () => {
    const report = parse.parseVulnJson(parse.jsonOf(FIXTURE))!;

    it("rings for each new critical or high finding once", () => {
        const first = parse.freshAlerts(report.items, new Set());
        expect(first.map((i) => i.id)).toEqual(["CVE-2099-0001", "CVE-2026-111497"]);
        const told = new Set(first.map(parse.alertKey));
        expect(parse.freshAlerts(report.items, told)).toEqual([]);
    });

    it("stays quiet when a rebuild bumps the package but not past the fix", () => {
        const told = new Set(report.items.map(parse.alertKey));
        const bumped = report.items.map((i) =>
            i.packageName === "node" ? { ...i, version: "22.21.0" } : i
        );
        expect(parse.freshAlerts(bumped, told)).toEqual([]);
    });

    it("rings again for the same advisory in another package", () => {
        const told = new Set(report.items.map(parse.alertKey));
        const other = { ...report.items[1]!, packageName: "nodejs" };
        expect(parse.freshAlerts([other], told)).toHaveLength(1);
    });
});
