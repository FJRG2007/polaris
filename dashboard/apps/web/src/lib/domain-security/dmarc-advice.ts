/**
 * What to do about a DMARC policy that only monitors or only quarantines, in
 * the one order that does not lose real mail: every sender passes first, then
 * one step stricter. The DMARC reports are the only evidence of who sends as the
 * domain, so the advice follows what Polaris can see of them. Pure.
 */

import type { SendingSource } from "./dmarc-sources";

export type DmarcAdvice =
    /** Every sender in the reports passes: the next step is safe. */
    | { readonly kind: "tighten"; readonly to: "quarantine" | "reject" }
    /** Some real senders fail: fix them before tightening. */
    | { readonly kind: "fixSenders"; readonly count: number }
    /** Reports are read here but none has arrived yet. */
    | { readonly kind: "waitReports" }
    /** Reports go to another service, so the senders are checked there. */
    | { readonly kind: "readElsewhere"; readonly hosts: readonly string[] }
    /** No report address at all: nobody can tell which senders pass. */
    | { readonly kind: "noReports" };

export function dmarcAdvice(
    current: "none" | "quarantine",
    view: {
        readonly reportAddress: string | null;
        readonly sources: readonly SendingSource[] | null;
    },
    reportHosts: readonly string[]
): DmarcAdvice {
    if (!view.reportAddress) {
        return reportHosts.length > 0
            ? { kind: "readElsewhere", hosts: reportHosts }
            : { kind: "noReports" };
    }
    if (!view.sources || view.sources.length === 0) return { kind: "waitReports" };
    // Spoofing is exactly what a stricter policy refuses; only a real sender
    // that fails holds the step back.
    const failing = view.sources.filter((source) => source.verdict === "misconfigured").length;
    if (failing > 0) return { kind: "fixSenders", count: failing };
    return { kind: "tighten", to: current === "none" ? "quarantine" : "reject" };
}
