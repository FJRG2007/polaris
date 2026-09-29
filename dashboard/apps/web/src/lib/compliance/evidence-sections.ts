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

import type * as core from "@polaris/core";
import { DEFAULT_LOCALE } from "@polaris/core";
import { everyLabel, kindLabel } from "@/lib/backups/words";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import type { BackupReading, EvidenceReadings, EvidenceSection } from "@/lib/compliance/evidence";

/** The words a report is written in: the `compliance` catalog, and the backups
 *  one for what a backup plan and a kind of item are called. */
export interface EvidenceWords {
    readonly t: NamespaceTranslator<"compliance">;
    readonly backups: NamespaceTranslator<"backups">;
}

/** English, for a report nobody in particular asked for - and for the tests that
 *  hold the builders to what they said before they had a catalog. */
export function evidenceWordsIn(locale: core.Locale = DEFAULT_LOCALE): EvidenceWords {
    return { t: translatorFor(locale, "compliance"), backups: translatorFor(locale, "backups") };
}

type Noun =
    | "account"
    | "activeAccount"
    | "character"
    | "session"
    | "entry"
    | "item"
    | "itemWithCopy"
    | "key"
    | "domainInUse"
    | "scope"
    | "configuredScope"
    | "service"
    | "day"
    | "hour"
    | "minute";

/** A managed certificate this close to expiring is worth a second look. */
const EXPIRING_SOON_DAYS = 14;

/** What one builder produces; the last change is attached by `buildEvidence`. */
type SectionDraft = Omit<EvidenceSection, "lastChange">;

/** "1 account", "3 accounts". */
function count(t: EvidenceWords["t"], value: number, noun: Noun): string {
    // The figure as written rather than grouped, so a report reads "5000 entries"
    // in every language, the way it always has.
    return t(`nouns.${noun}`, { count: value, n: String(value) });
}

/** "3 of 12 accounts". */
function share(t: EvidenceWords["t"], part: number, whole: number, noun: Noun): string {
    return t("share", { part: String(part), whole: count(t, whole, noun) });
}

/** A length of time in the largest whole unit it fills. */
function duration(t: EvidenceWords["t"], seconds: number): string {
    if (seconds % 86_400 === 0) return count(t, seconds / 86_400, "day");
    if (seconds % 3_600 === 0) return count(t, seconds / 3_600, "hour");
    return count(t, Math.round(seconds / 60), "minute");
}

/** "once a day", "once every 6 hours". */
function frequency(t: EvidenceWords["t"], seconds: number): string {
    if (seconds === 86_400) return t("frequency.day");
    if (seconds === 3_600) return t("frequency.hour");
    return t("frequency.every", { duration: duration(t, seconds) });
}

function yesNo(t: EvidenceWords["t"], value: boolean): string {
    return value ? t("yes") : t("no");
}

/** A second factor, as the security settings name it. */
function factorLabel(t: EvidenceWords["t"], factor: string): string {
    return t.has(`factors.${factor}`) ? t(`factors.${factor}` as NamespaceKey<"compliance">) : factor;
}

/** A retention period, as the records settings name it. */
function retentionLabel(t: EvidenceWords["t"], days: number): string {
    return t.has(`retention.d${days}`) ? t(`retention.d${days}` as NamespaceKey<"compliance">) : String(days);
}

function authentication(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const { policy, mailReady, accounts, withSecondFactor, withPasskey, minPasswordLength } = readings.authentication;
    const accepted = policy.acceptedFactors.map((factor) => factorLabel(t, factor));
    return {
        id: "authentication",
        title: t("sections.authentication.title"),
        where: [
            { label: t("where.security"), href: "/admin/security" },
            { label: t("where.email"), href: "/admin/email" }
        ],
        facts: [
            {
                id: "second-factor.required",
                label: t("facts.secondFactor"),
                value: policy.requireSecondFactor,
                text: policy.requireSecondFactor ? t("facts.requiredOfEvery") : t("facts.notRequired"),
                attention: !policy.requireSecondFactor
            },
            {
                id: "second-factor.accepted",
                label: t("facts.factorsThatCount"),
                value: policy.acceptedFactors.join(","),
                text: accepted.join(", ")
            },
            {
                id: "second-factor.connected-sign-in",
                label: t("facts.afterConnected"),
                value: policy.challengeConnectionSignIn,
                text: policy.challengeConnectionSignIn ? t("facts.askedToo") : t("facts.standsForBoth")
            },
            {
                id: "accounts.second-factor",
                label: t("facts.withSecondFactor"),
                value: withSecondFactor,
                text: share(t, withSecondFactor, accounts, "activeAccount"),
                attention: withSecondFactor < accounts
            },
            {
                id: "accounts.passkey",
                label: t("facts.withPasskey"),
                value: withPasskey,
                text: share(t, withPasskey, accounts, "activeAccount")
            },
            {
                id: "password.min-length",
                label: t("facts.shortestPassword"),
                value: minPasswordLength,
                text: count(t, minPasswordLength, "character")
            }
        ],
        notes:
            policy.acceptedFactors.includes("email") && !mailReady
                ? [t("notes.noEmailChannel")]
                : []
    };
}

function sessions(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const s = readings.sessions;
    return {
        id: "sessions",
        title: t("sections.sessions.title"),
        where: [{ label: t("where.accountSecurity"), href: "/account/security" }],
        facts: [
            {
                id: "session.lifetime",
                label: t("facts.sessionLifetime"),
                value: s.maxAgeSeconds,
                text: t("facts.lifetimeText", {
                    duration: duration(t, s.maxAgeSeconds),
                    frequency: frequency(t, s.updateAgeSeconds)
                })
            },
            {
                id: "session.shorter-lifetime",
                label: t("facts.signOutSooner"),
                value: s.shorterLifetime,
                text: share(t, s.shorterLifetime, s.accounts, "account")
            },
            {
                id: "session.idle-lock",
                label: t("facts.lockWhenIdle"),
                value: s.idleLock,
                text: share(t, s.idleLock, s.accounts, "account")
            },
            {
                id: "session.client-binding",
                label: t("facts.clientBound"),
                value: s.accounts - s.clientBindingOff,
                text: share(t, s.accounts - s.clientBindingOff, s.accounts, "account")
            },
            {
                id: "session.address-binding",
                label: t("facts.addressBound"),
                value: s.addressPinned,
                text: share(t, s.addressPinned, s.accounts, "account")
            },
            {
                id: "session.login-approval",
                label: t("facts.loginApproval"),
                value: s.loginApproval,
                text: share(t, s.loginApproval, s.accounts, "account")
            },
            {
                id: "session.open",
                label: t("facts.openSessions"),
                value: s.open,
                text: count(t, s.open, "session")
            }
        ],
        notes: [
            t("notes.sessionsFixed")
        ]
    };
}

function administrators(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const admins = readings.administrators;
    const without = admins.filter((admin) => !admin.secondFactor).length;
    return {
        id: "administrators",
        title: t("sections.administrators.title"),
        where: [{ label: t("where.users"), href: "/admin/users" }],
        facts: [
            {
                id: "admins.count",
                label: t("sections.administrators.title"),
                value: admins.length,
                text: count(t, admins.length, "account")
            },
            {
                id: "admins.without-second-factor",
                label: t("facts.adminsWithout"),
                value: without,
                text: String(without),
                attention: without > 0
            }
        ],
        rows: {
            title: t("sections.administrators.title"),
            total: admins.length,
            items: admins.map((admin) => ({
                id: admin.id,
                label: admin.name,
                href: `/admin/users/${admin.id}`,
                facts: [
                    {
                        id: "second-factor",
                        label: t("facts.secondFactor"),
                        value: admin.secondFactor,
                        text: yesNo(t, admin.secondFactor),
                        attention: !admin.secondFactor
                    }
                ]
            }))
        },
        notes: [t("notes.firstAdmin")]
    };
}

function audit(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const a = readings.audit;
    const last = a.lastVerification;
    const result = !last
        ? t("facts.notCheckedYet")
        : last.broken
          ? t("facts.broken", { reason: t(`chainBreak.${last.broken.reason}`), seq: String(last.broken.seq) })
          : t("facts.intact", { entries: count(t, last.checked, "entry") });
    return {
        id: "audit",
        title: t("sections.audit.title"),
        where: [
            { label: t("where.activity"), href: "/admin/activity" },
            { label: t("where.retention"), href: "/admin/retention" }
        ],
        facts: [
            {
                id: "audit.retention-days",
                label: t("facts.auditKept"),
                value: a.retention.audit,
                text: retentionLabel(t, a.retention.audit)
            },
            {
                id: "activity.retention-days",
                label: t("facts.activityKept"),
                value: a.retention.activity,
                text: retentionLabel(t, a.retention.activity)
            },
            {
                id: "audit.sealed",
                label: t("facts.sealed"),
                value: a.sealed,
                text: a.pending > 0 ? t("facts.sealedPending", { sealed: String(a.sealed), pending: String(a.pending) }) : String(a.sealed)
            },
            {
                id: "audit.last-check",
                label: t("facts.lastCheck"),
                value: last?.at ?? null,
                text: t("facts.notCheckedYet"),
                date: true,
                attention: !last
            },
            {
                id: "audit.last-check-result",
                label: t("facts.whatItFound"),
                value: last ? last.ok : null,
                text: result,
                attention: last ? !last.ok : false
            },
            {
                id: "audit.head",
                label: t("facts.chainHead"),
                value: a.head ? `${a.head.seq} ${a.head.hash}` : null,
                text: a.head ? `#${a.head.seq} ${a.head.hash}` : t("facts.nothingSealed")
            }
        ],
        notes: [
            t("notes.chain")
        ]
    };
}

/** Whether the schedule takes copies of an item on its own. */
function isScheduled(item: BackupReading): boolean {
    return item.status === "active" && item.every !== null && item.every !== "off";
}

/** "Every day", "Paused", "On demand only". */
function scheduleText(t: EvidenceWords["t"], tb: EvidenceWords["backups"], item: BackupReading): string {
    if (item.status === "paused") return t("backups.paused");
    if (item.status === "missing") return t("backups.sourceGone");
    if (!isScheduled(item)) return t("backups.onDemand");
    return everyLabel(tb, String(item.every));
}

/** Whether the newest copy of an item is encrypted everywhere it is stored. */
function encryptionOf(
    t: EvidenceWords["t"],
    item: BackupReading
): { value: string; text: string; attention: boolean } {
    if (item.sealed + item.clear === 0) return { value: "none", text: t("backups.noCopy"), attention: false };
    if (item.clear === 0) return { value: "all", text: t("yes"), attention: false };
    if (item.sealed === 0) return { value: "no", text: t("no"), attention: true };
    return { value: "some", text: t("backups.partly"), attention: true };
}

/** How the last run went, as a word; a status this build does not know is said as stored. */
function lastResultText(t: EvidenceWords["t"], status: string): string {
    return status === "ok" || status === "partial" || status === "failed" ? t(`backups.result.${status}`) : status;
}

function backups(readings: EvidenceReadings, { t, backups: tb }: EvidenceWords): SectionDraft {
    const b = readings.backups;
    return {
        id: "backups",
        title: t("sections.backups.title"),
        where: [{ label: t("sections.backups.title"), href: "/apps/backups" }],
        facts: [
            { id: "backups.protected", label: t("facts.protectedItems"), value: b.total, text: String(b.total) },
            {
                id: "backups.scheduled",
                label: t("facts.onSchedule"),
                value: b.scheduled,
                text: share(t, b.scheduled, b.total, "item")
            },
            {
                id: "backups.encrypted",
                label: t("facts.newestEncrypted"),
                value: b.encrypted,
                text: share(t, b.encrypted, b.withCopy, "itemWithCopy"),
                attention: b.encrypted < b.withCopy
            },
            {
                id: "backups.failing",
                label: t("facts.lastRunFailed"),
                value: b.failing,
                text: count(t, b.failing, "item"),
                attention: b.failing > 0
            },
            {
                id: "backups.keys",
                label: t("facts.keysInUse"),
                value: b.activeKeys,
                text: count(t, b.activeKeys, "key")
            }
        ],
        rows: {
            title: t("facts.protectedItems"),
            total: b.total,
            items: b.items.map((item) => {
                const encryption = encryptionOf(t, item);
                return {
                    id: item.id,
                    label: item.name,
                    href: `/apps/backups/${item.id}`,
                    facts: [
                        { id: "kind", label: t("facts.kind"), value: item.kind, text: kindLabel(tb, item.kind) },
                        {
                            id: "schedule",
                            label: t("facts.schedule"),
                            value: item.every ?? "off",
                            text: scheduleText(t, tb, item)
                        },
                        { id: "encrypted", label: t("facts.encrypted"), ...encryption },
                        {
                            id: "last-success",
                            label: t("facts.lastGoodCopy"),
                            value: item.lastSuccessAt,
                            text: t("facts.never"),
                            date: true,
                            attention: item.lastSuccessAt === null
                        },
                        {
                            id: "last-result",
                            label: t("facts.lastRun"),
                            value: item.lastStatus,
                            text: item.lastStatus ? lastResultText(t, item.lastStatus) : t("facts.notRunYet"),
                            attention: item.lastStatus === "failed" || item.lastStatus === "partial"
                        }
                    ]
                };
            })
        },
        notes: [
            t("notes.localUnencrypted"),
            ...(b.total > b.items.length ? [t("notes.listShows", { shown: String(b.items.length), total: String(b.total) })] : [])
        ]
    };
}

function secrets(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const s = readings.secrets;
    return {
        id: "secrets",
        title: t("sections.secrets.title"),
        where: [
            { label: t("where.serviceVariables"), href: "/apps/deploy" },
            { label: t("where.runnerSecrets"), href: "/apps/runners/secrets" }
        ],
        facts: [
            {
                id: "secrets.encrypted",
                label: t("facts.secretEncrypted"),
                value: s.secretEncrypted,
                text: String(s.secretEncrypted)
            },
            {
                id: "secrets.clear",
                label: t("facts.secretClear"),
                value: s.secretClear,
                text: String(s.secretClear),
                attention: s.secretClear > 0
            },
            {
                id: "variables.plain",
                label: t("facts.plainVariables"),
                value: s.plainVariables,
                text: t("facts.storedAsWritten", { count: String(s.plainVariables) })
            },
            {
                id: "runner-secrets.encrypted",
                label: t("facts.runnerSecrets"),
                value: s.runnerSecrets,
                text: t("facts.allEncrypted", { count: String(s.runnerSecrets) })
            }
        ],
        notes: [t("notes.masterKey")]
    };
}

function tls(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const tl = readings.tls;
    const soon = readings.now.getTime() + EXPIRING_SOON_DAYS * 86_400_000;
    const expiring = tl.managed.expiries.filter((at) => new Date(at).getTime() < soon).length;
    const withCertificate = tl.letsEncrypt + tl.internalCa;
    return {
        id: "tls",
        title: t("sections.tls.title"),
        where: [
            { label: t("where.serviceSettings"), href: "/apps/deploy" },
            { label: t("where.accountDomains"), href: "/account/domains" }
        ],
        facts: [
            {
                id: "tls.with-certificate",
                label: t("facts.overHttps"),
                value: withCertificate,
                text: share(t, withCertificate, tl.domains, "domainInUse")
            },
            {
                id: "tls.lets-encrypt",
                label: t("facts.letsEncrypt"),
                value: tl.letsEncrypt,
                text: String(tl.letsEncrypt)
            },
            {
                id: "tls.internal-ca",
                label: t("facts.internalCa"),
                value: tl.internalCa,
                text: String(tl.internalCa)
            },
            {
                id: "tls.uploaded",
                label: t("facts.uploaded"),
                value: tl.uploaded,
                text: String(tl.uploaded)
            },
            {
                id: "tls.plain-http",
                label: t("facts.plainHttp"),
                value: tl.plainHttp,
                text: String(tl.plainHttp),
                attention: tl.plainHttp > 0
            },
            {
                id: "tls.managed-issued",
                label: t("facts.ownDomains"),
                value: tl.managed.issued,
                text:
                    tl.managed.pending > 0
                        ? t("facts.issuedWaiting", { issued: String(tl.managed.issued), pending: String(tl.managed.pending) })
                        : t("facts.issued", { issued: String(tl.managed.issued) })
            },
            {
                id: "tls.managed-failed",
                label: t("facts.notIssued"),
                value: tl.managed.failed,
                text: String(tl.managed.failed),
                attention: tl.managed.failed > 0
            },
            {
                id: "tls.managed-expiring",
                label: t("facts.expiringWithin", { days: EXPIRING_SOON_DAYS }),
                value: expiring,
                text: String(expiring),
                attention: expiring > 0
            }
        ],
        notes: []
    };
}

function firewall(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const f = readings.firewall;
    return {
        id: "firewall",
        title: t("sections.firewall.title"),
        where: [{ label: t("sections.firewall.title"), href: "/apps/firewall" }],
        facts: [
            {
                id: "firewall.instance-packs",
                label: t("facts.packsEveryService"),
                value: f.instancePacks,
                text: f.instanceDefaults ? t("facts.theDefaults", { count: String(f.instancePacks) }) : String(f.instancePacks)
            },
            {
                id: "firewall.polaris-packs",
                label: t("facts.packsPolaris"),
                value: f.polarisPacks,
                text: f.polarisDefaults ? t("facts.theDefaults", { count: String(f.polarisPacks) }) : String(f.polarisPacks)
            },
            {
                id: "firewall.injection-off",
                label: t("facts.injectionChecks"),
                value: f.injectionOffScopes,
                text:
                    f.injectionOffScopes === 0
                        ? t("facts.onEverywhere")
                        : t("facts.offIn", { scopes: count(t, f.injectionOffScopes, "scope") }),
                attention: f.injectionOffScopes > 0
            },
            {
                id: "firewall.custom-rules",
                label: t("facts.customRules"),
                value: f.customRules,
                text: t("facts.across", { rules: String(f.customRules), scopes: count(t, f.scopes, "configuredScope") })
            },
            {
                id: "firewall.deny",
                label: t("facts.refused"),
                value: f.denyEntries,
                text: String(f.denyEntries)
            },
            {
                id: "firewall.allow-scopes",
                label: t("facts.allowOnly"),
                value: f.allowScopes,
                text: String(f.allowScopes)
            },
            {
                id: "firewall.login-scopes",
                label: t("facts.requireSignIn"),
                value: f.loginScopes,
                text: String(f.loginScopes)
            },
            {
                id: "firewall.bans",
                label: t("facts.bannedNow"),
                value: f.activeBans,
                text: String(f.activeBans)
            }
        ],
        notes: []
    };
}

function rateLimits(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const e = readings.edge;
    return {
        id: "rate-limits",
        title: t("sections.rateLimits.title"),
        where: [{ label: t("where.trafficProtection"), href: "/apps/deploy" }],
        facts: [
            {
                id: "rate.services",
                label: t("facts.withRateLimit"),
                value: e.rateLimited,
                text: share(t, e.rateLimited, e.services, "service")
            },
            { id: "rate.rules", label: t("facts.rateInForce"), value: e.rateRules, text: String(e.rateRules) },
            {
                id: "rate.concurrency",
                label: t("facts.concurrencyCap"),
                value: e.concurrencyCapped,
                text: share(t, e.concurrencyCapped, e.services, "service")
            },
            {
                id: "rate.challenge",
                label: t("facts.challenge"),
                value: e.challenged,
                text: share(t, e.challenged, e.services, "service")
            }
        ],
        notes: [t("notes.builtInLimits")]
    };
}

function headers(readings: EvidenceReadings, { t }: EvidenceWords): SectionDraft {
    const e = readings.edge;
    return {
        id: "headers",
        title: t("sections.headers.title"),
        where: [{ label: t("where.securityHeaders"), href: "/apps/deploy" }],
        facts: [
            {
                id: "headers.strict",
                label: t("facts.strictPreset"),
                value: e.headers.strict,
                text: share(t, e.headers.strict, e.services, "service")
            },
            {
                id: "headers.recommended",
                label: t("facts.recommendedPreset"),
                value: e.headers.recommended,
                text: share(t, e.headers.recommended, e.services, "service")
            },
            {
                id: "headers.off",
                label: t("facts.noPreset"),
                value: e.headers.off,
                text: share(t, e.headers.off, e.services, "service")
            },
            {
                id: "headers.custom",
                label: t("facts.ownHeaders"),
                value: e.customHeaders,
                text: share(t, e.customHeaders, e.services, "service")
            }
        ],
        notes: []
    };
}

/** Every area, in the order the report presents them. */
export const EVIDENCE_SECTIONS: readonly ((readings: EvidenceReadings, words: EvidenceWords) => SectionDraft)[] = [
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
