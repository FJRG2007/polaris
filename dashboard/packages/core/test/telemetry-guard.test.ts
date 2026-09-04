/**
 * Who a telemetry project lets in.
 *
 * The key in a DSN proves nothing - it ships inside the browser bundle of every
 * application that reports from one - so these rules are what stands between a
 * published DSN and somebody writing into that project forever. Each one is
 * asserted in both directions, because a rule that only ever admits is not a
 * rule and a rule that only ever refuses is an outage.
 *
 * The documentation ranges (203.0.113.x and friends) are deliberately absent
 * from the "outside" cases: they are reserved rather than routable, so the
 * internal policy admits them, and a test written with one would pass without
 * testing anything.
 */

import { describe, expect, it } from "vitest";
import {
    readIngestSecret,
    readReporters,
    reporterRefusal,
    type ReporterRules
} from "../src/telemetry.js";

const rules = (over: Partial<ReporterRules> = {}): ReporterRules => ({
    reporters: "internal",
    allowedCidrs: [],
    allowedUserAgents: [],
    deniedUserAgents: [],
    requireSecret: false,
    ...over
});

const from = (ip: string | null, userAgent: string | null = "sentry.python/2.1.0") => ({
    ip,
    userAgent,
    secretOk: false
});

describe("where a report may come from", () => {
    it("takes this network on the default policy", () => {
        expect(reporterRefusal(rules(), from("10.1.2.3"))).toBeNull();
        expect(reporterRefusal(rules(), from("192.168.1.40"))).toBeNull();
        expect(reporterRefusal(rules(), from("127.0.0.1"))).toBeNull();
    });

    it("refuses the open internet on the default policy", () => {
        expect(reporterRefusal(rules(), from("100.0.0.1"))).toBe("address");
    });

    it("takes an outside address that was named, whichever policy", () => {
        expect(reporterRefusal(rules({ allowedCidrs: ["100.0.0.1"] }), from("100.0.0.1"))).toBeNull();
        expect(
            reporterRefusal(
                rules({ reporters: "listed", allowedCidrs: ["100.0.0.0/24"] }),
                from("100.0.0.7")
            )
        ).toBeNull();
    });

    it("refuses this network when the policy is a list that does not include it", () => {
        // "listed" means listed. An address being local is not a reason on its
        // own once somebody has said which addresses they meant.
        expect(
            reporterRefusal(rules({ reporters: "listed", allowedCidrs: ["100.0.0.1"] }), from("10.1.2.3"))
        ).toBe("address");
    });

    it("refuses a report that will not say where it is from", () => {
        // A policy of "only from here" must not be satisfied by declining to
        // answer the question.
        expect(reporterRefusal(rules(), from(null))).toBe("address");
        expect(reporterRefusal(rules({ reporters: "listed", allowedCidrs: ["10.0.0.0/8"] }), from(""))).toBe(
            "address"
        );
    });

    it("asks nothing about the address when the policy is anywhere", () => {
        // What a browser client needs: its reports come from the addresses of
        // the people using it.
        expect(reporterRefusal(rules({ reporters: "anywhere" }), from("100.0.0.1"))).toBeNull();
        expect(reporterRefusal(rules({ reporters: "anywhere" }), from(null))).toBeNull();
    });
});

describe("what may be reporting", () => {
    it("keeps out a client the project named, wherever it reports from", () => {
        expect(
            reporterRefusal(rules({ deniedUserAgents: ["curl*"] }), from("10.1.2.3", "curl/8.4.0"))
        ).toBe("client");
    });

    it("admits only the named clients once any are named", () => {
        const named = rules({ allowedUserAgents: ["sentry.python*"] });
        expect(reporterRefusal(named, from("10.1.2.3", "sentry.python/2.1.0"))).toBeNull();
        expect(reporterRefusal(named, from("10.1.2.3", "Mozilla/5.0"))).toBe("client");
    });

    it("checks the address first, because that is the one to fix first", () => {
        expect(
            reporterRefusal(
                rules({ deniedUserAgents: ["curl*"] }),
                from("100.0.0.1", "curl/8.4.0")
            )
        ).toBe("address");
    });
});

describe("the key, for a project that asks for one", () => {
    it("refuses a report that did not carry it", () => {
        expect(reporterRefusal(rules({ requireSecret: true }), from("10.1.2.3"))).toBe("secret");
    });

    it("takes one that did", () => {
        expect(
            reporterRefusal(rules({ requireSecret: true }), { ...from("10.1.2.3"), secretOk: true })
        ).toBeNull();
    });

    it("is asked for even when everything else is wide open", () => {
        expect(
            reporterRefusal(rules({ reporters: "anywhere", requireSecret: true }), from("100.0.0.1"))
        ).toBe("secret");
    });
});

describe("reading the key off a request", () => {
    it("takes the header of our own first", () => {
        expect(readIngestSecret({ header: "plt_abcdefghijklmnopqrst" })).toBe("plt_abcdefghijklmnopqrst");
    });

    it("takes an ordinary bearer token", () => {
        expect(readIngestSecret({ authorization: "Bearer plt_abcdefghijklmnopqrst" })).toBe(
            "plt_abcdefghijklmnopqrst"
        );
    });

    it("takes the deprecated half of the old DSN format, which some clients still send", () => {
        expect(
            readIngestSecret({ sentryAuth: "Sentry sentry_key=abc123, sentry_secret=abcdefghijklmnopqrst" })
        ).toBe("abcdefghijklmnopqrst");
    });

    it("is nothing when there is nothing, or when what is there is not a key", () => {
        expect(readIngestSecret({})).toBeNull();
        // Bounded before it is compared, so a header cannot be used to make
        // hashing expensive.
        expect(readIngestSecret({ header: "short" })).toBeNull();
        expect(readIngestSecret({ header: "x".repeat(500) })).toBeNull();
    });
});

describe("the stored policy", () => {
    it("reads the three it knows", () => {
        expect(readReporters("internal")).toBe("internal");
        expect(readReporters("listed")).toBe("listed");
        expect(readReporters("anywhere")).toBe("anywhere");
    });

    it("reads anything else as the strictest, never the loosest", () => {
        // A column edited by hand, or written by an older build, must not widen
        // a project.
        expect(readReporters("")).toBe("listed");
        expect(readReporters("open")).toBe("listed");
        expect(readReporters(null)).toBe("listed");
        expect(readReporters(7)).toBe("listed");
    });
});
