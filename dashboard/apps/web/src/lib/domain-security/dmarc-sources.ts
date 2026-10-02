/**
 * Who sends mail as a domain, read from the DMARC aggregate reports filed for it.
 *
 * One line per sending address: how much it sent, how much passed, and - the
 * part that tells the cases apart - which domains signed its mail (DKIM) and
 * which envelope domains it used (SPF). An address that fails everything and
 * signs as nobody is somebody spoofing the domain; one that passes with the
 * domain's own key is a real sender, and if it is not one of yours, that key or
 * an account that sends with it is compromised; one that fails but signs as a
 * provider is a real sender nobody finished setting up. Pure.
 */

import type * as core from "@polaris/core";

export interface SendingSource {
    readonly sourceIp: string;
    readonly messages: number;
    readonly passed: number;
    readonly failed: number;
    /** Domains whose DKIM signature it carried that verified. */
    readonly dkimDomains: readonly string[];
    /** Envelope domains it used whose SPF passed. */
    readonly spfDomains: readonly string[];
    readonly reporters: readonly string[];
    /** The reverse name of the address, filled in after, when it has one. */
    readonly hostname: string | null;
    /** What the pattern suggests, for the screen to put in words. */
    readonly verdict: "authorized" | "misconfigured" | "spoofing";
}

/** Sources kept for the screen, the most significant first. */
export const MAX_SOURCES = 50;

export function sendingSources(reports: readonly core.DmarcReport[]): SendingSource[] {
    const bySource = new Map<string, { messages: number; passed: number; dkim: Set<string>; spf: Set<string>; reporters: Set<string> }>();
    for (const report of reports) {
        for (const row of report.rows) {
            const entry = bySource.get(row.sourceIp) ?? { messages: 0, passed: 0, dkim: new Set(), spf: new Set(), reporters: new Set() };
            entry.messages += row.count;
            if (row.dkim === "pass" || row.spf === "pass") entry.passed += row.count;
            for (const auth of row.authDkim) if (auth.result === "pass" && auth.domain) entry.dkim.add(auth.domain.toLowerCase());
            for (const auth of row.authSpf) if (auth.result === "pass" && auth.domain) entry.spf.add(auth.domain.toLowerCase());
            entry.reporters.add(report.orgName);
            bySource.set(row.sourceIp, entry);
        }
    }
    const rank = { spoofing: 0, misconfigured: 1, authorized: 2 } as const;
    return [...bySource.entries()]
        .map(([sourceIp, entry]): SendingSource => {
            const failed = entry.messages - entry.passed;
            const verdict: SendingSource["verdict"] =
                failed === 0 ? "authorized" : entry.passed === 0 && entry.dkim.size === 0 && entry.spf.size === 0 ? "spoofing" : "misconfigured";
            return {
                sourceIp,
                messages: entry.messages,
                passed: entry.passed,
                failed,
                dkimDomains: [...entry.dkim].sort(),
                spfDomains: [...entry.spf].sort(),
                reporters: [...entry.reporters].sort(),
                hostname: null,
                verdict
            };
        })
        .sort((left, right) => rank[left.verdict] - rank[right.verdict] || right.messages - left.messages)
        .slice(0, MAX_SOURCES);
}
