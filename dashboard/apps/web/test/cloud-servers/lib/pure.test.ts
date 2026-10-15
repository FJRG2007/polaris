/**
 * Cloud servers' pure parts: the first-boot script, the cost arithmetic, the
 * XML reader EC2's answers go through, and the backoff a rate limit asks for.
 */

import { describe, expect, it } from "vitest";
import { backoffMs } from "@polaris-app/cloud-servers/src/lib/http";
import { child, items, parseXml, textOf } from "@polaris-app/cloud-servers/src/lib/xml";
import { ENROLLED_MARK, renderFirstBoot } from "@polaris-app/cloud-servers/src/lib/cloud-init";
import { isLtsImage, machineNameSchema } from "@polaris-app/cloud-servers/src/lib/providers/types";
import { costBetween, serverCosts, totalsByCurrency } from "@polaris-app/cloud-servers/src/lib/cost";

const COMMAND = "curl -sSL https://polaris.example.test/api/servers/enroll/fixtureToken_123 | sudo sh -s -- --docker --root";

describe("first-boot script", () => {
    it("installs what enrollment needs, enrolls once, and marks it done", () => {
        const script = renderFirstBoot(COMMAND);
        expect(script.startsWith("#!/bin/sh\n")).toBe(true);
        expect(script).toContain("apt-get install -y -q curl ca-certificates sudo openssh-server docker.io");
        expect(script).toContain(`\n${COMMAND}\n`);
        expect(script).toContain(`if [ -e ${ENROLLED_MARK} ]; then`);
        expect(script.trimEnd().endsWith(`touch ${ENROLLED_MARK}`)).toBe(true);
    });

    it("refuses any command that is not the one Polaris builds", () => {
        for (const bad of [
            "curl -sSL https://a.test/x; rm -rf / | sudo sh -s -- --docker --root",
            "curl -sSL https://a.test/$(id) | sudo sh -s -- --docker --root",
            "curl -sSL 'https://a.test/x' | sudo sh -s -- --docker --root",
            "wget https://a.test/x | sh",
            `${COMMAND}\nreboot`
        ]) {
            expect(() => renderFirstBoot(bad), bad).toThrow();
        }
    });
});

describe("cost", () => {
    const hourlyCapped = { hourly: 0.01, monthly: 5, currency: "USD" };

    it("bills started hours up to the monthly cap", () => {
        const from = new Date("2026-03-01T00:00:00Z");
        expect(costBetween(hourlyCapped, from, new Date("2026-03-01T02:30:00Z"))).toBe(0.03);
        expect(costBetween(hourlyCapped, from, new Date("2026-03-31T00:00:00Z"))).toBe(5);
    });

    it("caps each calendar month on its own", () => {
        expect(costBetween(hourlyCapped, new Date("2026-03-01T00:00:00Z"), new Date("2026-04-30T00:00:00Z"))).toBe(10);
    });

    it("uses the share of the month when only a monthly price is published", () => {
        const monthly = { hourly: null, monthly: 31, currency: "EUR" };
        // March has 31 days: one day is one thirty-first of the price.
        expect(costBetween(monthly, new Date("2026-03-10T00:00:00Z"), new Date("2026-03-11T00:00:00Z"))).toBe(1);
    });

    it("has no figure at all without a price", () => {
        expect(costBetween({ hourly: null, monthly: null, currency: null }, new Date(0), new Date())).toBeNull();
    });

    it("splits since-creation from this month, and stops at destruction", () => {
        const now = new Date("2026-04-10T00:00:00Z");
        const costs = serverCosts(hourlyCapped, new Date("2026-03-15T00:00:00Z"), null, now);
        expect(costs.thisMonth).toBe(2.16);
        // 17 days of March (408 hours, under the cap) and 9 days of April.
        expect(costs.sinceCreation).toBe(6.24);
        const gone = serverCosts(hourlyCapped, new Date("2026-03-15T00:00:00Z"), new Date("2026-03-16T00:00:00Z"), now);
        expect(gone).toEqual({ sinceCreation: 0.24, thisMonth: 0 });
    });

    it("totals by currency and counts the unpriced apart", () => {
        expect(
            totalsByCurrency([
                { currency: "USD", amount: 1.5 },
                { currency: "USD", amount: 2 },
                { currency: "EUR", amount: 3 },
                { currency: null, amount: null }
            ])
        ).toEqual({ totals: { USD: 3.5, EUR: 3 }, unpriced: 1 });
    });
});

describe("XML reader", () => {
    const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <requestId>fixture-request</requestId>
    <reservationSet>
        <item>
            <instancesSet>
                <item>
                    <instanceId>i-0123456789abcdef0</instanceId>
                    <instanceState><code>16</code><name>running</name></instanceState>
                    <instanceType>t3.micro</instanceType>
                    <ipAddress>203.0.113.10</ipAddress>
                    <placement><availabilityZone>eu-west-1a</availabilityZone></placement>
                    <tagSet><item><key>Name</key><value>web &amp; api</value></item></tagSet>
                    <empty/>
                </item>
            </instancesSet>
        </item>
    </reservationSet>
</DescribeInstancesResponse>`;

    it("reads nested lists, entities and empty elements", () => {
        const root = parseXml(FIXTURE);
        expect(root.name).toBe("DescribeInstancesResponse");
        const instance = items(items(root, "reservationSet")[0], "instancesSet")[0];
        expect(textOf(instance, "instanceId")).toBe("i-0123456789abcdef0");
        expect(textOf(child(instance, "instanceState"), "name")).toBe("running");
        expect(textOf(items(instance, "tagSet")[0], "value")).toBe("web & api");
        expect(textOf(instance, "empty")).toBe("");
    });

    it("throws on a malformed document", () => {
        expect(() => parseXml("<a><b></a>")).toThrow();
        expect(() => parseXml("<a>")).toThrow();
        expect(() => parseXml("<a/><b/>")).toThrow();
    });
});

describe("helpers", () => {
    it("waits what Retry-After asks, within bounds", () => {
        expect(backoffMs("2", 0)).toBe(2000);
        expect(backoffMs("600", 0)).toBe(10_000);
        expect(backoffMs(null, 0)).toBe(1000);
        expect(backoffMs(null, 2)).toBe(4000);
    });

    it("accepts only hostname-safe machine names, normalized", () => {
        expect(machineNameSchema.parse(" Web-1 ")).toBe("web-1");
        for (const bad of ["-web", "web-", "web_1", "a".repeat(51), ""]) {
            expect(machineNameSchema.safeParse(bad).success, bad).toBe(false);
        }
    });

    it("keeps Ubuntu and Debian LTS images only", () => {
        expect(isLtsImage("Ubuntu 24.04 LTS x64")).toBe(true);
        expect(isLtsImage("Debian 12 x64 (bookworm)")).toBe(true);
        expect(isLtsImage("Ubuntu 23.10 x64")).toBe(false);
        expect(isLtsImage("Fedora 40")).toBe(false);
    });
});
