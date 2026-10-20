/**
 * The fix dialog always says what to do about a DMARC policy that only
 * monitors or quarantines: one step stricter once every real sender in the
 * reports passes, and otherwise what has to happen first.
 */

import { describe, expect, it } from "vitest";
import { dmarcAdvice } from "@/lib/domain-security/dmarc-advice";
import type { SendingSource } from "@/lib/domain-security/dmarc-sources";

function source(verdict: SendingSource["verdict"]): SendingSource {
    return {
        sourceIp: "192.0.2.1",
        messages: 10,
        passed: verdict === "authorized" ? 10 : 0,
        failed: verdict === "authorized" ? 0 : 10,
        dkimDomains: [],
        spfDomains: [],
        reporters: ["example receiver"],
        hostname: null,
        verdict
    };
}

const READ = "dmarc@reports.example.test";

describe("dmarcAdvice", () => {
    it("recommends quarantine from none, and reject from quarantine, when every sender passes", () => {
        const view = { reportAddress: READ, sources: [source("authorized")] };
        expect(dmarcAdvice("none", view, [])).toEqual({ kind: "tighten", to: "quarantine" });
        expect(dmarcAdvice("quarantine", view, [])).toEqual({ kind: "tighten", to: "reject" });
    });

    it("does not let forged mail hold the step back", () => {
        const view = { reportAddress: READ, sources: [source("authorized"), source("spoofing")] };
        expect(dmarcAdvice("none", view, [])).toEqual({ kind: "tighten", to: "quarantine" });
    });

    it("asks for the failing real senders to be fixed first", () => {
        const view = {
            reportAddress: READ,
            sources: [source("misconfigured"), source("misconfigured"), source("authorized")]
        };
        expect(dmarcAdvice("none", view, [])).toEqual({ kind: "fixSenders", count: 2 });
    });

    it("waits for the first reports when they are read here but none came", () => {
        expect(dmarcAdvice("none", { reportAddress: READ, sources: [] }, [])).toEqual({
            kind: "waitReports"
        });
    });

    it("points at the service that reads the reports, or says there are none", () => {
        const elsewhere = { reportAddress: null, sources: null };
        expect(dmarcAdvice("none", elsewhere, ["reports.example.test"])).toEqual({
            kind: "readElsewhere",
            hosts: ["reports.example.test"]
        });
        expect(dmarcAdvice("none", elsewhere, [])).toEqual({ kind: "noReports" });
    });
});
