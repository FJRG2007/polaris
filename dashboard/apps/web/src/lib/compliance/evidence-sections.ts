/**
 * Each area of the compliance evidence, put into words.
 *
 * One builder per area, each reading only its own part of `EvidenceReadings`
 * and saying what it found: the fact, its value for a machine, the sentence for a
 * person, and whether it is worth a second look. `buildEvidence` runs them in
 * order and attaches the last change the audit trail holds for each.
 *
 * Pure.
 */

import * as core from "@polaris/core";
import { resourceKindLabel } from "@/lib/backups/kinds";
import { BACKUP_EVERY_OPTIONS } from "@/lib/backups/policy";
import type { BackupReading, EvidenceReadings, EvidenceSection } from "@/lib/compliance/evidence";

/** A managed certificate this close to expiring is worth a second look. */
const EXPIRING_SOON_DAYS = 14;

/** What one builder produces; the last change is attached by `buildEvidence`. */
type SectionDraft = Omit<EvidenceSection, "lastChange">;

/** "1 account", "3 accounts". */
function count(value: number, singular: string, plural = `${singular}s`): string {
    return `${value} ${value === 1 ? singular : plural}`;
}

/** "3 of 12 accounts". */
function share(part: number, whole: number, noun: string, plural?: string): string {
    return `${part} of ${count(whole, noun, plural)}`;
}

/** A length of time in the largest whole unit it fills. */
function duration(seconds: number): string {
    if (seconds % 86_400 === 0) return count(seconds / 86_400, "day");
    if (seconds % 3_600 === 0) return count(seconds / 3_600, "hour");
    return count(Math.round(seconds / 60), "minute");
}

/** "once a day", "once every 6 hours". */
function frequency(seconds: number): string {
    if (seconds === 86_400) return "once a day";
    if (seconds === 3_600) return "once an hour";
    return `once every ${duration(seconds)}`;
}

function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}

function authentication(readings: EvidenceReadings): SectionDraft {
    const { policy, mailReady, accounts, withSecondFactor, withPasskey, minPasswordLength } =
        readings.authentication;
    const accepted = policy.acceptedFactors.map(
        (factor) => core.SECOND_FACTOR_ENROLLMENT_INFO[factor].label
    );
    return {
        id: "authentication",
        title: "Sign-in and second factor",
        where: [
            { label: "Management > Security", href: "/admin/security" },
            { label: "Management > Email", href: "/admin/email" }
        ],
        facts: [
            {
                id: "second-factor.required",
                label: "Second factor",
                value: policy.requireSecondFactor,
                text: policy.requireSecondFactor ? "Required of every account" : "Not required",
                attention: !policy.requireSecondFactor
            },
            {
                id: "second-factor.accepted",
                label: "Factors that count",
                value: policy.acceptedFactors.join(","),
                text: accepted.join(", ")
            },
            {
                id: "second-factor.connected-sign-in",
                label: "After a GitHub or Google sign-in",
                value: policy.challengeConnectionSignIn,
                text: policy.challengeConnectionSignIn
                    ? "The second factor is asked for too"
                    : "The account's own sign-in stands for both steps"
            },
            {
                id: "accounts.second-factor",
                label: "Accounts with a second factor",
                value: withSecondFactor,
                text: share(withSecondFactor, accounts, "active account"),
                attention: withSecondFactor < accounts
            },
            {
                id: "accounts.passkey",
                label: "Accounts with a passkey",
                value: withPasskey,
                text: share(withPasskey, accounts, "active account")
            },
            {
                id: "password.min-length",
                label: "Shortest password allowed",
                value: minPasswordLength,
                text: count(minPasswordLength, "character")
            }
        ],
        notes:
            policy.acceptedFactors.includes("email") && !mailReady
                ? [
                      "Email codes are accepted, but no email channel is set, so only the authenticator can be armed."
                  ]
                : []
    };
}

function sessions(readings: EvidenceReadings): SectionDraft {
    const s = readings.sessions;
    return {
        id: "sessions",
        title: "Sessions",
        where: [{ label: "My account > Security", href: "/account/security" }],
        facts: [
            {
                id: "session.lifetime",
                label: "Session lifetime",
                value: s.maxAgeSeconds,
                text: `${duration(s.maxAgeSeconds)}, renewed at most ${frequency(s.updateAgeSeconds)}`
            },
            {
                id: "session.shorter-lifetime",
                label: "Accounts that sign out sooner",
                value: s.shorterLifetime,
                text: share(s.shorterLifetime, s.accounts, "account")
            },
            {
                id: "session.idle-lock",
                label: "Accounts that lock when idle",
                value: s.idleLock,
                text: share(s.idleLock, s.accounts, "account")
            },
            {
                id: "session.client-binding",
                label: "Sessions tied to the browser and system that opened them",
                value: s.accounts - s.clientBindingOff,
                text: share(s.accounts - s.clientBindingOff, s.accounts, "account")
            },
            {
                id: "session.address-binding",
                label: "Sessions tied to the address that opened them",
                value: s.addressPinned,
                text: share(s.addressPinned, s.accounts, "account")
            },
            {
                id: "session.login-approval",
                label: "New sign-ins approved from an open session",
                value: s.loginApproval,
                text: share(s.loginApproval, s.accounts, "account")
            },
            {
                id: "session.open",
                label: "Open sessions",
                value: s.open,
                text: count(s.open, "session")
            }
        ],
        notes: [
            "The lifetime and its renewal are fixed in Polaris. The rest is set by each account for itself; there is no instance-wide switch."
        ]
    };
}

function administrators(readings: EvidenceReadings): SectionDraft {
    const admins = readings.administrators;
    const without = admins.filter((admin) => !admin.secondFactor).length;
    return {
        id: "administrators",
        title: "Administrators",
        where: [{ label: "Management > Users", href: "/admin/users" }],
        facts: [
            {
                id: "admins.count",
                label: "Administrators",
                value: admins.length,
                text: count(admins.length, "account")
            },
            {
                id: "admins.without-second-factor",
                label: "Administrators without a second factor",
                value: without,
                text: String(without),
                attention: without > 0
            }
        ],
        rows: {
            title: "Administrators",
            total: admins.length,
            items: admins.map((admin) => ({
                id: admin.id,
                label: admin.name,
                href: `/admin/users/${admin.id}`,
                facts: [
                    {
                        id: "second-factor",
                        label: "Second factor",
                        value: admin.secondFactor,
                        text: yesNo(admin.secondFactor),
                        attention: !admin.secondFactor
                    }
                ]
            }))
        },
        notes: ["The first administrator, made during setup, has no entry in the audit trail."]
    };
}

function audit(readings: EvidenceReadings): SectionDraft {
    const a = readings.audit;
    const last = a.lastVerification;
    const result = !last
        ? "Not checked yet"
        : last.broken
          ? `${core.AUDIT_CHAIN_BREAK_LABELS[last.broken.reason]} (entry ${last.broken.seq})`
          : `Intact across ${count(last.checked, "entry", "entries")}`;
    return {
        id: "audit",
        title: "Audit trail",
        where: [
            { label: "Management > Activity", href: "/admin/activity" },
            { label: "Management > Keeping records", href: "/admin/retention" }
        ],
        facts: [
            {
                id: "audit.retention-days",
                label: "Audit log kept for",
                value: a.retention.audit,
                text: core.RETENTION_LABELS[a.retention.audit as core.RetentionDays]
            },
            {
                id: "activity.retention-days",
                label: "Activity kept for",
                value: a.retention.activity,
                text: core.RETENTION_LABELS[a.retention.activity as core.RetentionDays]
            },
            {
                id: "audit.sealed",
                label: "Entries sealed into the chain",
                value: a.sealed,
                text:
                    a.pending > 0
                        ? `${a.sealed}, with ${a.pending} waiting to be sealed`
                        : String(a.sealed)
            },
            {
                id: "audit.last-check",
                label: "Last integrity check",
                value: last?.at ?? null,
                text: "Not checked yet",
                date: true,
                attention: !last
            },
            {
                id: "audit.last-check-result",
                label: "What it found",
                value: last ? last.ok : null,
                text: result,
                attention: last ? !last.ok : false
            },
            {
                id: "audit.head",
                label: "Chain head",
                value: a.head ? `${a.head.seq} ${a.head.hash}` : null,
                text: a.head ? `#${a.head.seq} ${a.head.hash}` : "Nothing sealed yet"
            }
        ],
        notes: [
            "The chain shows an entry edited or removed after it was sealed. Removing the newest entries is caught only against a copy of the head kept outside Polaris."
        ]
    };
}

/** Whether the schedule takes copies of an item on its own. */
function isScheduled(item: BackupReading): boolean {
    return item.status === "active" && item.every !== null && item.every !== "off";
}

/** "Every day", "Paused", "On demand only". */
function scheduleText(item: BackupReading): string {
    if (item.status === "paused") return "Paused";
    if (item.status === "missing") return "Source gone";
    if (!isScheduled(item)) return "On demand only";
    return (
        BACKUP_EVERY_OPTIONS.find((option) => option.value === item.every)?.label ??
        String(item.every)
    );
}

/** Whether the newest copy of an item is encrypted everywhere it is stored. */
function encryptionOf(item: BackupReading): { value: string; text: string; attention: boolean } {
    if (item.sealed + item.clear === 0)
        return { value: "none", text: "No copy yet", attention: false };
    if (item.clear === 0) return { value: "all", text: "Yes", attention: false };
    if (item.sealed === 0) return { value: "no", text: "No", attention: true };
    return { value: "some", text: "Partly", attention: true };
}

const LAST_RESULT_TEXT: Readonly<Record<string, string>> = {
    ok: "OK",
    partial: "Partial",
    failed: "Failed"
};

function backups(readings: EvidenceReadings): SectionDraft {
    const b = readings.backups;
    return {
        id: "backups",
        title: "Backups",
        where: [{ label: "Backups", href: "/apps/backups" }],
        facts: [
            {
                id: "backups.protected",
                label: "Protected items",
                value: b.total,
                text: String(b.total)
            },
            {
                id: "backups.scheduled",
                label: "On a schedule",
                value: b.scheduled,
                text: share(b.scheduled, b.total, "item")
            },
            {
                id: "backups.encrypted",
                label: "Newest copy encrypted everywhere it is kept",
                value: b.encrypted,
                text: share(b.encrypted, b.withCopy, "item with a copy", "items with a copy"),
                attention: b.encrypted < b.withCopy
            },
            {
                id: "backups.failing",
                label: "Last run failed",
                value: b.failing,
                text: count(b.failing, "item"),
                attention: b.failing > 0
            },
            {
                id: "backups.keys",
                label: "Backup keys in use",
                value: b.activeKeys,
                text: count(b.activeKeys, "key")
            }
        ],
        rows: {
            title: "Protected items",
            total: b.total,
            items: b.items.map((item) => {
                const encryption = encryptionOf(item);
                return {
                    id: item.id,
                    label: item.name,
                    href: `/apps/backups/${item.id}`,
                    facts: [
                        {
                            id: "kind",
                            label: "Kind",
                            value: item.kind,
                            text: resourceKindLabel(item.kind)
                        },
                        {
                            id: "schedule",
                            label: "Schedule",
                            value: item.every ?? "off",
                            text: scheduleText(item)
                        },
                        { id: "encrypted", label: "Encrypted", ...encryption },
                        {
                            id: "last-success",
                            label: "Last good copy",
                            value: item.lastSuccessAt,
                            text: "Never",
                            date: true,
                            attention: item.lastSuccessAt === null
                        },
                        {
                            id: "last-result",
                            label: "Last run",
                            value: item.lastStatus,
                            text: item.lastStatus
                                ? (LAST_RESULT_TEXT[item.lastStatus] ?? item.lastStatus)
                                : "Not run yet",
                            attention: item.lastStatus === "failed" || item.lastStatus === "partial"
                        }
                    ]
                };
            })
        },
        notes: [
            "A copy kept on the disk of the thing it protects is written unencrypted by design; every copy that leaves it is encrypted.",
            ...(b.total > b.items.length
                ? [
                      `The list shows the ${b.items.length} most recently backed-up items of ${b.total}; the figures above count them all.`
                  ]
                : [])
        ]
    };
}

function secrets(readings: EvidenceReadings): SectionDraft {
    const s = readings.secrets;
    return {
        id: "secrets",
        title: "Secrets",
        where: [
            { label: "Service > Variables", href: "/apps/deploy" },
            { label: "Runners > Secrets", href: "/apps/runners/secrets" }
        ],
        facts: [
            {
                id: "secrets.encrypted",
                label: "Secret variables encrypted at rest",
                value: s.secretEncrypted,
                text: String(s.secretEncrypted)
            },
            {
                id: "secrets.clear",
                label: "Secret variables stored unencrypted",
                value: s.secretClear,
                text: String(s.secretClear),
                attention: s.secretClear > 0
            },
            {
                id: "variables.plain",
                label: "Variables not marked secret",
                value: s.plainVariables,
                text: `${s.plainVariables}, stored as written`
            },
            {
                id: "runner-secrets.encrypted",
                label: "Runner secrets",
                value: s.runnerSecrets,
                text: `${s.runnerSecrets}, all encrypted at rest`
            }
        ],
        notes: ["Encrypted under the instance's master key, which is not stored in the database."]
    };
}

function tls(readings: EvidenceReadings): SectionDraft {
    const t = readings.tls;
    const soon = readings.now.getTime() + EXPIRING_SOON_DAYS * 86_400_000;
    const expiring = t.managed.expiries.filter((at) => new Date(at).getTime() < soon).length;
    const withCertificate = t.letsEncrypt + t.internalCa;
    return {
        id: "tls",
        title: "TLS on domains",
        where: [
            { label: "Service > Settings", href: "/apps/deploy" },
            { label: "My account > Domains", href: "/account/domains" }
        ],
        facts: [
            {
                id: "tls.with-certificate",
                label: "Service domains served over HTTPS",
                value: withCertificate,
                text: share(withCertificate, t.domains, "domain in use", "domains in use")
            },
            {
                id: "tls.lets-encrypt",
                label: "With a Let's Encrypt certificate",
                value: t.letsEncrypt,
                text: String(t.letsEncrypt)
            },
            {
                id: "tls.internal-ca",
                label: "With a certificate from this instance's own authority",
                value: t.internalCa,
                text: String(t.internalCa)
            },
            {
                id: "tls.uploaded",
                label: "With a certificate you supplied",
                value: t.uploaded,
                text: String(t.uploaded)
            },
            {
                id: "tls.plain-http",
                label: "Served over plain HTTP",
                value: t.plainHttp,
                text: String(t.plainHttp),
                attention: t.plainHttp > 0
            },
            {
                id: "tls.managed-issued",
                label: "Certificates for your own domains",
                value: t.managed.issued,
                text:
                    t.managed.pending > 0
                        ? `${t.managed.issued} issued, ${t.managed.pending} waiting`
                        : `${t.managed.issued} issued`
            },
            {
                id: "tls.managed-failed",
                label: "Certificates that could not be issued",
                value: t.managed.failed,
                text: String(t.managed.failed),
                attention: t.managed.failed > 0
            },
            {
                id: "tls.managed-expiring",
                label: `Expiring within ${EXPIRING_SOON_DAYS} days`,
                value: expiring,
                text: String(expiring),
                attention: expiring > 0
            }
        ],
        notes: []
    };
}

function firewall(readings: EvidenceReadings): SectionDraft {
    const f = readings.firewall;
    return {
        id: "firewall",
        title: "Firewall",
        where: [{ label: "Firewall", href: "/apps/firewall" }],
        facts: [
            {
                id: "firewall.instance-packs",
                label: "Rule packs on every service",
                value: f.instancePacks,
                text: f.instanceDefaults
                    ? `${f.instancePacks}, the defaults`
                    : String(f.instancePacks)
            },
            {
                id: "firewall.polaris-packs",
                label: "Rule packs in front of Polaris itself",
                value: f.polarisPacks,
                text: f.polarisDefaults ? `${f.polarisPacks}, the defaults` : String(f.polarisPacks)
            },
            {
                id: "firewall.injection-off",
                label: "SQL injection and cross-site scripting checks",
                value: f.injectionOffScopes,
                text:
                    f.injectionOffScopes === 0
                        ? "On everywhere"
                        : `Off in ${count(f.injectionOffScopes, "scope")}`,
                attention: f.injectionOffScopes > 0
            },
            {
                id: "firewall.custom-rules",
                label: "Custom rules",
                value: f.customRules,
                text: `${f.customRules} across ${count(f.scopes, "configured scope")}`
            },
            {
                id: "firewall.deny",
                label: "Addresses and ranges refused",
                value: f.denyEntries,
                text: String(f.denyEntries)
            },
            {
                id: "firewall.allow-scopes",
                label: "Scopes that admit listed addresses only",
                value: f.allowScopes,
                text: String(f.allowScopes)
            },
            {
                id: "firewall.login-scopes",
                label: "Scopes that require a Polaris sign-in",
                value: f.loginScopes,
                text: String(f.loginScopes)
            },
            {
                id: "firewall.bans",
                label: "Addresses banned now",
                value: f.activeBans,
                text: String(f.activeBans)
            }
        ],
        notes: []
    };
}

function rateLimits(readings: EvidenceReadings): SectionDraft {
    const e = readings.edge;
    return {
        id: "rate-limits",
        title: "Rate limits",
        where: [{ label: "Service > Settings > Traffic protection", href: "/apps/deploy" }],
        facts: [
            {
                id: "rate.services",
                label: "Services with a rate limit",
                value: e.rateLimited,
                text: share(e.rateLimited, e.services, "service")
            },
            {
                id: "rate.rules",
                label: "Rate limits in force",
                value: e.rateRules,
                text: String(e.rateRules)
            },
            {
                id: "rate.concurrency",
                label: "Services with a cap on requests at once",
                value: e.concurrencyCapped,
                text: share(e.concurrencyCapped, e.services, "service")
            },
            {
                id: "rate.challenge",
                label: "Services that challenge visitors",
                value: e.challenged,
                text: share(e.challenged, e.services, "service")
            }
        ],
        notes: [
            "The limits Polaris puts on its own codes and link passwords are built in, not settings, and are not counted here."
        ]
    };
}

function headers(readings: EvidenceReadings): SectionDraft {
    const e = readings.edge;
    return {
        id: "headers",
        title: "Security headers",
        where: [{ label: "Service > Settings > Security headers", href: "/apps/deploy" }],
        facts: [
            {
                id: "headers.strict",
                label: "Services on the strict preset",
                value: e.headers.strict,
                text: share(e.headers.strict, e.services, "service")
            },
            {
                id: "headers.recommended",
                label: "Services on the recommended preset",
                value: e.headers.recommended,
                text: share(e.headers.recommended, e.services, "service")
            },
            {
                id: "headers.off",
                label: "Services with no preset",
                value: e.headers.off,
                text: share(e.headers.off, e.services, "service")
            },
            {
                id: "headers.custom",
                label: "Services sending headers of their own",
                value: e.customHeaders,
                text: share(e.customHeaders, e.services, "service")
            }
        ],
        notes: []
    };
}

/** Every area, in the order the report presents them. */
export const EVIDENCE_SECTIONS: readonly ((readings: EvidenceReadings) => SectionDraft)[] = [
    authentication,
    sessions,
    administrators,
    audit,
    backups,
    secrets,
    tls,
    firewall,
    rateLimits,
    headers
];
