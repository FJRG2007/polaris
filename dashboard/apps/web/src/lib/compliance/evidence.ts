/**
 * The configuration evidence an auditor asks for, as facts.
 *
 * An audit of an organization that runs Polaris asks the same handful of
 * questions every time: who can sign in and how, how long a session lives, who
 * holds the keys, whether the log can be trusted and for how long it is kept,
 * what is backed up and whether the copies are encrypted, whether secrets are,
 * whether traffic is. Each answer already lives somewhere in Polaris - a policy
 * row, a column on every account, a service's edge settings - and this is the one
 * place that reads them all, dated, with where each is set and who last changed
 * it according to the audit trail.
 *
 * Pure: `buildEvidence` turns what the database said (`EvidenceReadings`,
 * gathered by `evidence-readings.ts`) into the report the screen draws and the
 * export writes, so the two cannot say different things, and a test can pin every
 * sentence without a database. The wording of each area is in
 * `evidence-sections.ts`.
 *
 * Nothing here is a claim Polaris cannot back. A count is a count of rows; a
 * setting is the stored value, or its default when it has never been written; and
 * what lies outside the software - the host's disks, where the operator keeps a
 * copy of a key - is listed as outside rather than guessed at.
 */

import type * as core from "@polaris/core";
import { EVIDENCE_SECTIONS } from "@/lib/compliance/evidence-sections";

/** Written into every export, so a reader of the file knows which shape it has. */
export const EVIDENCE_FORMAT = "polaris-evidence/1";

/** How many protected items the report lists one by one. The totals count all. */
export const EVIDENCE_ROWS_MAX = 200;

export const EVIDENCE_AREAS = [
    "authentication",
    "sessions",
    "administrators",
    "audit",
    "backups",
    "secrets",
    "tls",
    "firewall",
    "rate-limits",
    "headers"
] as const;

export type EvidenceArea = (typeof EVIDENCE_AREAS)[number];

/**
 * The audit actions that change what each area reports.
 *
 * Exact names rather than prefixes, each one written by the action that makes
 * the change - the test beside this checks every name against the source, so a
 * renamed action fails there rather than leaving an area that silently never
 * finds its last change.
 */
export const EVIDENCE_CHANGE_ACTIONS: Readonly<Record<EvidenceArea, readonly string[]>> = {
    // The mail channel decides whether an accepted email code can be armed at all.
    authentication: [
        "instance.security.updated",
        "auth-mail.channel.set",
        "auth-mail.channel.cleared"
    ],
    sessions: [
        "account.session-limits.updated",
        "account.session-binding.updated",
        "account.login-approval.enabled",
        "account.login-approval.disabled"
    ],
    administrators: ["user.promote", "user.demote"],
    audit: ["retention.set"],
    backups: [
        "backup.protect",
        "backup.unprotect",
        "backup.unprotect.purge",
        "backup.plan.save",
        "backup.plan.delete",
        "backup.plan.assign",
        "backup.pause",
        "backup.resume",
        "backup.destination.create",
        "backup.destination.delete",
        "backup.key.rotate",
        "backup.key.add"
    ],
    secrets: [
        "deploy.variable.set",
        "deploy.variable.import",
        "deploy.variable.remove",
        "deploy.variable.delete",
        "runner.secret.set",
        "runner.secret.delete"
    ],
    tls: [
        "deploy.domain.add",
        "deploy.domain.remove",
        "deploy.domain.toggle",
        "deploy.domain.cert.set",
        "deploy.domain.cert.clear"
    ],
    firewall: [
        "deploy.waf.set",
        "waf.jails.set",
        "waf.jails.ignore",
        "waf.ban.lift",
        "waf.feed.tor",
        "waf.anomalies.set",
        "waf.anomaly.block"
    ],
    "rate-limits": ["deploy.edge.update"],
    headers: ["deploy.edge.update"]
};

/** One control, as the report states it. */
export interface EvidenceFact {
    /** Stable across exports, so two reports can be compared by machine. */
    readonly id: string;
    readonly label: string;
    /** What a machine reads: a count, a switch, a period in days, an ISO timestamp.
     *  Null when there is nothing to report yet. */
    readonly value: string | number | boolean | null;
    /** The same value in words. For a date, what to say when there is none. */
    readonly text: string;
    /** `value` is an ISO timestamp, written in the reader's own format. */
    readonly date?: boolean;
    /** Worth a second look: a protection that is off, a check that failed. */
    readonly attention?: boolean;
}

/** One thing inside an area listed on its own - an administrator, a protected item. */
export interface EvidenceRow {
    readonly id: string;
    readonly label: string;
    /** Where the record itself opens. */
    readonly href: string;
    readonly facts: readonly EvidenceFact[];
}

/** The newest audit entry that changed an area. */
export interface EvidenceChange {
    /** ISO 8601. */
    readonly at: string;
    readonly action: string;
    readonly actorId: string | null;
    readonly actorName: string;
    /** Whether that account still exists, so there is something to open. */
    readonly actorExists: boolean;
}

export interface EvidenceSection {
    readonly id: EvidenceArea;
    readonly title: string;
    /** Where each part of it is set, in the words the screens use. */
    readonly where: readonly { readonly label: string; readonly href: string }[];
    readonly facts: readonly EvidenceFact[];
    readonly rows?: {
        readonly title: string;
        readonly total: number;
        readonly items: readonly EvidenceRow[];
    };
    readonly notes: readonly string[];
    readonly lastChange: EvidenceChange | null;
}

export interface EvidenceReport {
    readonly format: typeof EVIDENCE_FORMAT;
    /** ISO 8601: the moment every fact in it was read. */
    readonly generatedAt: string;
    readonly instance: { readonly url: string; readonly build: string | null };
    readonly sections: readonly EvidenceSection[];
    /** What an auditor will ask about that Polaris has no way to see. */
    readonly outsidePolaris: readonly string[];
}

/** One protected item, as the backup tables describe it. */
export interface BackupReading {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    /** active | paused | missing */
    readonly status: string;
    /** The plan's schedule, or null for an item on no plan. */
    readonly every: string | null;
    /** When the newest usable copy was taken. */
    readonly lastSuccessAt: string | null;
    /** ok | partial | failed, or null before the first run. */
    readonly lastStatus: string | null;
    /** The newest copy's stored copies, by whether each is encrypted. Both zero
     *  when there is no copy yet. */
    readonly sealed: number;
    readonly clear: number;
}

/** What the database and settings said, before any of it is put into words. */
export interface EvidenceReadings {
    readonly now: Date;
    readonly instance: { readonly url: string; readonly build: string | null };
    readonly authentication: {
        readonly policy: core.InstanceSecurityPolicy;
        /** Whether an email code can actually be delivered. */
        readonly mailReady: boolean;
        /** Accounts that can sign in: not banned, not disabled. */
        readonly accounts: number;
        readonly withSecondFactor: number;
        readonly withPasskey: number;
        readonly minPasswordLength: number;
    };
    readonly sessions: {
        readonly maxAgeSeconds: number;
        readonly updateAgeSeconds: number;
        readonly accounts: number;
        readonly shorterLifetime: number;
        readonly idleLock: number;
        /** Accounts that turned the browser-and-system binding off; it is on by default. */
        readonly clientBindingOff: number;
        readonly addressPinned: number;
        readonly loginApproval: number;
        readonly open: number;
    };
    readonly administrators: readonly {
        readonly id: string;
        readonly name: string;
        readonly secondFactor: boolean;
    }[];
    readonly audit: {
        readonly retention: core.RetentionPolicy;
        readonly sealed: number;
        readonly pending: number;
        readonly head: { readonly seq: string; readonly hash: string } | null;
        readonly lastVerification: {
            readonly at: string;
            readonly ok: boolean;
            readonly checked: number;
            readonly broken: { readonly seq: string; readonly reason: core.AuditChainBreak } | null;
        } | null;
    };
    readonly backups: {
        readonly total: number;
        /** Counted over every item, not only the listed ones. */
        readonly scheduled: number;
        readonly failing: number;
        /** Items whose newest copy is stored somewhere, and those of them stored
         *  encrypted everywhere. */
        readonly withCopy: number;
        readonly encrypted: number;
        /** The most recently backed-up items, at most `EVIDENCE_ROWS_MAX`. */
        readonly items: readonly BackupReading[];
        /** Keys new copies can be sealed under (not retired). */
        readonly activeKeys: number;
    };
    readonly secrets: {
        readonly secretEncrypted: number;
        readonly secretClear: number;
        readonly plainVariables: number;
        readonly runnerSecrets: number;
    };
    readonly tls: {
        readonly domains: number;
        readonly letsEncrypt: number;
        readonly internalCa: number;
        readonly plainHttp: number;
        readonly uploaded: number;
        readonly managed: {
            readonly issued: number;
            readonly pending: number;
            readonly failed: number;
            /** Expiry dates of the issued ones. */
            readonly expiries: readonly string[];
        };
    };
    readonly firewall: {
        /** Packs on the instance-wide scope, saved or the defaults. */
        readonly instancePacks: number;
        readonly instanceDefaults: boolean;
        /** Packs in front of the dashboard itself. */
        readonly polarisPacks: number;
        readonly polarisDefaults: boolean;
        readonly scopes: number;
        readonly customRules: number;
        readonly denyEntries: number;
        readonly allowScopes: number;
        readonly loginScopes: number;
        readonly injectionOffScopes: number;
        readonly activeBans: number;
    };
    readonly edge: {
        readonly services: number;
        readonly rateLimited: number;
        readonly rateRules: number;
        readonly concurrencyCapped: number;
        readonly challenged: number;
        readonly headers: Readonly<Record<core.EdgeHeaderPreset, number>>;
        readonly customHeaders: number;
    };
    readonly changes: Readonly<Record<EvidenceArea, EvidenceChange | null>>;
}

/** A fact as words, with a date written by `formatDate` - the reader's own format
 *  on screen, UTC in a printed report. */
export function factText(fact: EvidenceFact, formatDate: (iso: string) => string): string {
    return fact.date && typeof fact.value === "string" ? formatDate(fact.value) : fact.text;
}

/** What Polaris cannot see from where it runs, said once rather than guessed at. */
export const OUTSIDE_POLARIS: readonly string[] = [
    "Whether the disks of the machines Polaris runs on are encrypted.",
    "Where copies of the master key, the backup recovery keys and the audit chain head are kept outside this instance.",
    "Entries older than the audit log's retention period, and changes made before the trail recorded them.",
    "The organization's own processes: access reviews, joiners and leavers, training, vendor management, incident response and physical security."
];

/** The whole report, from one set of readings. */
export function buildEvidence(readings: EvidenceReadings): EvidenceReport {
    return {
        format: EVIDENCE_FORMAT,
        generatedAt: readings.now.toISOString(),
        instance: readings.instance,
        sections: EVIDENCE_SECTIONS.map((section) => {
            const built = section(readings);
            return { ...built, lastChange: readings.changes[built.id] };
        }),
        outsidePolaris: OUTSIDE_POLARIS
    };
}
