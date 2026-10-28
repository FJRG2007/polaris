/**
 * A vulnerability alert opens the security page on the server, the scan and
 * the advisories it is about, as query parameters the page reads safely. A
 * link from before they existed - the bare page - still opens.
 */

import { describe, expect, it } from "vitest";
import * as landing from "@polaris-app/security-scans/src/model/landing";

const TARGET = "019f811e-0000-7000-8000-000000000001";
const SCAN = "01a1639f-0000-7000-8000-000000000002";

describe("alertHref", () => {
    it("names the server, the scan and the advisories", () => {
        const href = landing.alertHref({
            targetId: TARGET,
            scanId: SCAN,
            ids: ["GO-2026-6612", "CVE-2026-1"]
        });
        expect(href).toBe(
            `/apps/servers/security?target=${TARGET}&scan=${SCAN}&ids=GO-2026-6612%2CCVE-2026-1`
        );
    });

    it("leaves out the advisories when there are none", () => {
        expect(landing.alertHref({ targetId: TARGET, scanId: SCAN })).toBe(
            `/apps/servers/security?target=${TARGET}&scan=${SCAN}`
        );
    });

    it("carries at most the cap, once each, and drops what is not an advisory id", () => {
        const ids = Array.from({ length: 30 }, (_, i) => `CVE-2026-${i}`);
        const href = landing.alertHref({
            targetId: TARGET,
            scanId: SCAN,
            ids: ["CVE-2026-0", "bad id", "<x>", ...ids]
        });
        const parsed = landing.parseLanding(
            Object.fromEntries(new URL(href, "http://x").searchParams)
        );
        expect(parsed.ids).toHaveLength(landing.MAX_LINK_IDS);
        expect(parsed.ids[0]).toBe("CVE-2026-0");
        expect(parsed.ids).not.toContain("bad id");
    });

    it("round-trips through the page's parser", () => {
        const href = landing.alertHref({ targetId: TARGET, scanId: SCAN, ids: ["GO-2026-6612"] });
        const params = Object.fromEntries(new URL(href, "http://x").searchParams);
        expect(landing.parseLanding(params)).toEqual({
            target: TARGET,
            scan: SCAN,
            ids: ["GO-2026-6612"]
        });
    });
});

describe("parseLanding", () => {
    it("reads the bare page - an alert from before links had parameters - as nothing to open", () => {
        expect(landing.parseLanding({})).toEqual(landing.NO_LANDING);
        expect(landing.parseLanding(null)).toEqual(landing.NO_LANDING);
        expect(landing.parseLanding(undefined)).toEqual(landing.NO_LANDING);
    });

    it("drops ids that are not uuids instead of passing them on", () => {
        expect(landing.parseLanding({ target: "../../etc", scan: "1 OR 1=1", ids: "" })).toEqual(
            landing.NO_LANDING
        );
    });

    it("takes the first of a repeated parameter", () => {
        expect(landing.parseLanding({ scan: [SCAN, TARGET] }).scan).toBe(SCAN);
    });

    it("trims and lowercases the ids it keeps", () => {
        expect(landing.parseLanding({ target: ` ${TARGET.toUpperCase()} ` }).target).toBe(TARGET);
    });

    it("keeps each advisory once", () => {
        expect(landing.parseLanding({ ids: "GO-1, GO-1,GHSA-abcd-efgh-ijkl" }).ids).toEqual([
            "GO-1",
            "GHSA-abcd-efgh-ijkl"
        ]);
    });
});

describe("findingsHome", () => {
    it("sends Polaris's own image scans to Management", () => {
        expect(landing.findingsHome({ targetId: TARGET, scanId: SCAN, own: true })).toBe(
            `/admin/security/scans?scan=${SCAN}`
        );
    });

    it("sends a Deploy service's scans to its Vulnerabilities tab", () => {
        const appHref = "/apps/deploy/p9?service=a3&tab=vulnerabilities";
        expect(landing.findingsHome({ targetId: TARGET, scanId: SCAN, appHref })).toBe(appHref);
    });

    it("keeps everything else on the scans page", () => {
        expect(
            landing.findingsHome({
                targetId: TARGET,
                scanId: SCAN,
                appHref: "/apps/installed/x",
                ids: ["CVE-2026-1"]
            })
        ).toBe(landing.alertHref({ targetId: TARGET, scanId: SCAN, ids: ["CVE-2026-1"] }));
        expect(landing.findingsHome({ targetId: TARGET, scanId: SCAN })).toBe(
            landing.alertHref({ targetId: TARGET, scanId: SCAN })
        );
    });
});
