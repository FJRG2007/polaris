/**
 * When a domain going down is worth telling somebody about.
 *
 * Two failure modes to keep apart, and both are the kind that erode trust in every
 * other alert: a blip that pages, and an outage that pages every minute it lasts.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { domainHealthMessage } from "@/lib/notifications/domain-events";
import { nextAlertState, type DomainHealth } from "@/lib/watch/health-probe";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const DOWN: DomainHealth = { status: "down", code: 502, latencyMs: 12, detail: "HTTP 502" };
const UP: DomainHealth = { status: "up", code: 200, latencyMs: 12, detail: null };
const NOW = new Date("2026-08-04T00:00:00.000Z");

/** Labels in the shape the alert builds them: hostname, then which service it is. */
const LABELS = [
    "shop.example.com (Storefront / web)",
    "api.example.com (Storefront / api)",
    "blog.example.com (Blog / site)",
    "docs.example.com (Docs / site)"
];

describe("a domain that just started failing", () => {
    it("says nothing on the first failure", () => {
        const next = nextAlertState({ healthFailures: 0, healthAlertedAt: null }, DOWN, NOW);

        expect(next.failures).toBe(1);
        expect(next.alert).toBeNull();
    });

    it("alerts once the failures have piled up", () => {
        const next = nextAlertState({ healthFailures: 2, healthAlertedAt: null }, DOWN, NOW);

        expect(next.alert).toBe("down");
        expect(next.alertedAt).toEqual(NOW);
    });
});

describe("a domain that stays down", () => {
    it("does not alert again on every later probe", () => {
        const next = nextAlertState({ healthFailures: 30, healthAlertedAt: NOW }, DOWN, NOW);

        expect(next.alert).toBeNull();
        expect(next.alertedAt).toEqual(NOW);
    });
});

describe("a domain that comes back", () => {
    it("reports the recovery to whoever heard about the outage", () => {
        const next = nextAlertState({ healthFailures: 5, healthAlertedAt: NOW }, UP, NOW);

        expect(next.alert).toBe("up");
        expect(next.failures).toBe(0);
        // Cleared, so the next outage is a new one and alerts again.
        expect(next.alertedAt).toBeNull();
    });

    it("says nothing when nobody was told it had gone", () => {
        const next = nextAlertState({ healthFailures: 1, healthAlertedAt: null }, UP, NOW);

        expect(next.alert).toBeNull();
        expect(next.failures).toBe(0);
    });
});

describe("a healthy domain", () => {
    it("stays quiet and keeps its streak at zero", () => {
        const next = nextAlertState({ healthFailures: 0, healthAlertedAt: null }, UP, NOW);

        expect(next).toEqual({ failures: 0, alertedAt: null, alert: null });
    });
});

/**
 * And the failure mode neither of the two above catches: one alert per service.
 *
 * Polaris is mostly run on somebody's own line at home, where the thing that
 * takes a domain down is almost never the domain. The connection drops and every
 * domain on the box crosses the threshold in the same pass; it comes back and
 * they all come back in the same pass. Told one at a time that is one alert per
 * deployed service - and the reader's own words for it were "imagina que hay
 * cientos de apps".
 */
describe("when a whole sweep moves at once", () => {
    it("still gives one domain its own sentence", () => {
        const said = domainHealthMessage("down", [LABELS[0]!], "HTTP 502");

        expect(said.title).toBe("Domain not serving: shop.example.com (Storefront / web)");
        expect(said.body).toContain("HTTP 502");
    });

    it("leads with how many came back, not with the first of them", () => {
        const said = domainHealthMessage("up", LABELS, null);

        expect(said.title).toBe("4 domains are answering again");
        // The per-domain sentence would be four copies of this one.
        expect(said.body).not.toContain("It is answering again");
    });

    it("says the count is the diagnosis when they go together", () => {
        const said = domainHealthMessage("down", LABELS, "Timed out");

        expect(said.title).toBe("4 domains stopped serving");
        expect(said.body).toContain("connection or the edge");
    });

    it("names a few and counts the rest", () => {
        const said = domainHealthMessage("up", LABELS, null);

        expect(said.body).toContain("shop.example.com (Storefront / web)");
        expect(said.body).toContain("and 1 more");
        // The fourth is the one counted, so it is not also listed.
        expect(said.body).not.toContain("docs.example.com");
    });

    it("names them all while they still fit", () => {
        const said = domainHealthMessage("up", LABELS.slice(0, 3), null);

        expect(said.title).toBe("3 domains are answering again");
        expect(said.body).toContain("blog.example.com (Blog / site)");
        expect(said.body).not.toContain("more");
    });
});

/**
 * That the sweep speaks once is asserted where it can be watched doing it, in
 * `one-alert-per-sweep`. What is left here is the other half of the same switch:
 * a domain probed on its own, outside any sweep, still alerts on its own.
 */
describe("a domain probed by itself", () => {
    it("keeps alerting without waiting for a sweep", async () => {
        const source = await readFile(`${SRC}lib/watch/health-probe.ts`, "utf8");
        expect(source).toContain("else await notifyDomainHealthChanged(change);");
    });
});
