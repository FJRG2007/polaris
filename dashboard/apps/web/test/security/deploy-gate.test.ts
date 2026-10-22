/**
 * The deploy check's decision: a critical finding with a known fix warns, and
 * blocks only where the service asks for it and nobody let this release through.
 * Findings below are fixture data.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { decideGate, refusalReason } from "@/lib/security/deploy-gate";

const FIXTURE = [
    { title: "CVE-0000-0003", location: "fixture-lib 1.0", fixedIn: null, severity: "critical" },
    { title: "CVE-0000-0004", location: "fixture-node 22.0.0", fixedIn: "22.0.1", severity: "critical" },
    { title: "CVE-0000-0005", location: "fixture-zlib 1.2", fixedIn: "1.3", severity: "high" }
];

describe("deploy vulnerability check", () => {
    it("passes an image with no critical finding that has a fix", () => {
        expect(
            decideGate(FIXTURE.filter((f) => f.fixedIn === null || f.severity !== "critical"), {
                scanId: "s",
                block: true,
                overridden: false
            })
        ).toEqual({ warning: null, refuse: false });
    });

    it("warns, without blocking, by default", () => {
        const decision = decideGate(FIXTURE, { scanId: "s", block: false, overridden: false });
        expect(decision.refuse).toBe(false);
        expect(decision.warning).toEqual({
            count: 1,
            id: "CVE-0000-0004",
            package: "fixture-node 22.0.0",
            fixedIn: "22.0.1",
            scanId: "s"
        });
    });

    it("blocks where the service asks, unless this deployment was let through", () => {
        expect(decideGate(FIXTURE, { scanId: "s", block: true, overridden: false }).refuse).toBe(true);
        expect(decideGate(FIXTURE, { scanId: "s", block: true, overridden: true }).refuse).toBe(false);
    });

    it("says what was found and how to go on", () => {
        const warning = decideGate(FIXTURE, { scanId: "s", block: true, overridden: false }).warning!;
        expect(refusalReason(warning)).toContain("CVE-0000-0004 in fixture-node 22.0.0, fixed in 22.0.1");
    });
});
