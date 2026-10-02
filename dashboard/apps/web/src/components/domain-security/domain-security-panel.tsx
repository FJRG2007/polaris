"use client";

/**
 * One domain's security: the grade, every problem with what it risks and the
 * exact fix, the checks it passed, the fixes Polaris can make (previewed before
 * anything changes), and - for a domain that sends mail - who sends as it.
 *
 * Shared by an owner's domain page and the administrator's list, so the advice
 * reads the same wherever it is opened; only the scope it asks with differs.
 *
 * The heading and the controls paint at once; only the findings wait, behind a
 * skeleton the size of a short list. The last answer is kept for half a minute
 * so moving between pages does not ask again, and a domain never checked is
 * checked the moment it is opened rather than waiting for somebody to press a
 * button.
 */

import { FixDialog } from "./fix-dialog";
import { runAction } from "@/lib/run-action";
import { RefreshCw, Wrench } from "lucide-react";
import { SendingSources } from "./sending-sources";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useRef, useState } from "react";
import { SecurityBadge, SeverityBadge } from "./security-badge";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import type { DomainSecurityView } from "@/lib/domain-security/service";
import { Button, DnsRecordTable, SegmentedControl, Skeleton, Switch } from "@polaris/ui";
import {
    SECURITY_SECTIONS,
    severityRank,
    type Finding,
    type SecuritySection
} from "@/lib/domain-security/types";
import {
    readDomainSecurityAction,
    recheckDomainSecurityAction,
    setDomainDedicatedAction,
    type SecurityRef
} from "@/app/(app)/account/domains/security-actions";

/** How long an answer is shown again without asking. */
const SNAPSHOT_MS = 30_000;

type Words = NamespaceTranslator<"domainSecurity">;

function key(value: string): NamespaceKey<"domainSecurity"> {
    return value as NamespaceKey<"domainSecurity">;
}

function scopeKey(scope: SecurityRef): string {
    return scope.kind === "org" ? `org:${scope.orgId}` : scope.kind;
}

/** Whether a finding is listed as something to look at: anything not passed. */
function open(finding: Finding): boolean {
    return finding.severity !== "pass";
}

/** Whether it counts as a problem: low or worse. An "info" line is advice, and
 *  counting it would make a domain with nothing wrong read as having problems. */
function counts(finding: Finding): boolean {
    return severityRank(finding.severity) >= severityRank("low");
}

/** What a finding says, with its parameters filled in. */
function words(t: Words, finding: Finding, part: "title" | "risk" | "fix"): string {
    return t(
        key(`findings.${finding.code}.${part}`),
        finding.params as Record<string, string | number>
    );
}

function whereText(t: Words, finding: Finding, canFix: boolean): string | null {
    switch (finding.where) {
        case "dns":
            return t(canFix ? "where.dnsManaged" : "where.dns");
        case "dnssec":
            return t(canFix ? "where.dnssecManaged" : "where.dnssec");
        case "registrar":
            return t("where.registrar");
        case "edge":
            return t("where.edge");
        case "site":
            return t("where.site");
        default:
            return null;
    }
}

function FindingRow({ finding, canFix }: { finding: Finding; canFix: boolean }) {
    const t = useTranslations("domainSecurity");
    const fixable = open(finding);
    const where = fixable ? whereText(t, finding, canFix) : null;
    // A passed check has no fix; its words are only a title and what it means.
    const hasFix =
        fixable &&
        finding.code !== "spfUnchecked" &&
        finding.code !== "rdapUnavailable" &&
        finding.code !== "webNone";
    return (
        <li className="flex min-w-0 flex-col gap-1.5 border-t border-border py-3 first:border-t-0 first:pt-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <SeverityBadge severity={finding.severity} />
                <span className="min-w-0 break-words text-sm font-medium">
                    {words(t, finding, "title")}
                </span>
            </div>
            <p className="text-muted-foreground break-words text-[0.8125rem]">
                {words(t, finding, "risk")}
            </p>
            {hasFix && (
                <p className="break-words text-[0.8125rem]">
                    {words(t, finding, "fix")}
                    {where && <span className="text-muted-foreground"> ({where})</span>}
                </p>
            )}
            {fixable && finding.records.length > 0 && (
                <DnsRecordTable
                    records={finding.records.map((record) => ({
                        type: record.type,
                        name: record.name,
                        value:
                            record.type === "MX"
                                ? `${record.priority ?? 0} ${record.value}`
                                : record.value
                    }))}
                />
            )}
        </li>
    );
}

export function DomainSecurityPanel({ scope, domain }: { scope: SecurityRef; domain: string }) {
    const t = useTranslations("domainSecurity");
    const cacheKey = `domain-security:${scopeKey(scope)}:${domain}`;
    const [view, setView] = useState<DomainSecurityView | null>(
        () => readSnapshot<DomainSecurityView>(cacheKey, SNAPSHOT_MS)?.value ?? null
    );
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(false);
    const [section, setSection] = useState<SecuritySection>("email");
    const [showPassed, setShowPassed] = useState(false);
    const [fixing, setFixing] = useState(false);
    const [savingDedicated, setSavingDedicated] = useState(false);
    const firstCheck = useRef(false);

    const accept = (next: DomainSecurityView) => {
        setView(next);
        writeSnapshot(cacheKey, next);
    };

    async function recheck() {
        setChecking(true);
        setError("");
        const result = await runAction(() => recheckDomainSecurityAction(scope, domain), setError);
        setChecking(false);
        if (result?.view) accept(result.view);
        else if (result?.error) setError(result.error);
    }

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await readDomainSecurityAction(scope, domain).catch(() => null);
            if (cancelled) return;
            if (result?.view) {
                accept(result.view);
                // Never checked: check now, rather than show an empty card that
                // waits for somebody to think of pressing a button.
                if (!result.view.report && !firstCheck.current) {
                    firstCheck.current = true;
                    void recheck();
                }
            } else if (result?.error) setError(result.error);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per domain
    }, [domain, scopeKey(scope)]);

    const report = view?.report ?? null;
    const findings = useMemo(() => report?.findings ?? [], [report]);
    const problems = findings.filter(counts);
    const inSection = findings.filter((finding) => finding.section === section);
    const sectionProblems = inSection
        .filter(open)
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    const sectionPassed = inSection.filter((finding) => !open(finding));
    const fixable = findings.filter(
        (finding) =>
            open(finding) &&
            (finding.where === "dns" || finding.where === "dnssec" || finding.where === "edge")
    );
    const needsZone = findings.some(
        (finding) => open(finding) && finding.where === "dns" && finding.records.length > 0
    );

    async function toggleDedicated(next: boolean) {
        setSavingDedicated(true);
        setError("");
        const result = await runAction(
            () => setDomainDedicatedAction(scope, domain, next),
            setError
        );
        setSavingDedicated(false);
        if (result?.view) accept(result.view);
        else if (result?.error) setError(result.error);
    }

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{t("title")}</h3>
                {report ? (
                    <SecurityBadge grade={report.grade} problems={problems.length} />
                ) : (
                    view && <SecurityBadge grade="unknown" />
                )}
                {report && (
                    <span className="text-muted-foreground text-xs" aria-live="polite">
                        {checking ? (
                            t("checking")
                        ) : (
                            <>
                                {t("checked")} <RelativeTime iso={report.checkedAt} />
                            </>
                        )}
                    </span>
                )}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={checking}
                    aria-label={t("recheckNamed", { domain })}
                    title={t("recheck")}
                    onClick={() => void recheck()}
                >
                    <RefreshCw
                        className={checking ? "size-4 shrink-0 animate-spin" : "size-4 shrink-0"}
                        aria-hidden
                    />
                </Button>
            </div>

            {error && (
                <p
                    role="alert"
                    className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                >
                    {error}
                </p>
            )}

            {!view || (!report && checking) ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
            ) : !report ? (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-muted-foreground text-sm">{t("notChecked")}</p>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={checking}
                        onClick={() => void recheck()}
                    >
                        {t("checkNow")}
                    </Button>
                </div>
            ) : (
                <>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="text-sm">{t("summary", { count: problems.length })}</p>
                        {view.canFix && fixable.length > 0 && (
                            <Button
                                size="sm"
                                variant="secondary"
                                className="ml-auto"
                                onClick={() => setFixing(true)}
                            >
                                <Wrench className="size-4 shrink-0" aria-hidden /> {t("fix.review")}
                            </Button>
                        )}
                    </div>
                    {!view.canFix && needsZone && (
                        <p className="text-muted-foreground text-xs">
                            {t(scope.kind === "admin" ? "fix.cannotAdmin" : "fix.cannotOwner")}
                        </p>
                    )}

                    <SegmentedControl
                        aria-label={t("sectionsLabel")}
                        size="sm"
                        value={section}
                        onValueChange={(next) => {
                            setSection(next);
                            setShowPassed(false);
                        }}
                        options={SECURITY_SECTIONS.map((value) => {
                            const count = findings.filter(
                                (finding) => finding.section === value && counts(finding)
                            ).length;
                            return {
                                value,
                                label:
                                    count > 0
                                        ? `${t(`sections.${value}`)} (${count})`
                                        : t(`sections.${value}`)
                            };
                        })}
                    />

                    {sectionProblems.length === 0 ? (
                        <p className="text-muted-foreground text-sm">{t("nothingHere")}</p>
                    ) : (
                        <ul className="flex min-w-0 flex-col">
                            {sectionProblems.map((finding, index) => (
                                <FindingRow
                                    key={`${finding.code}-${index}`}
                                    finding={finding}
                                    canFix={view.canFix}
                                />
                            ))}
                        </ul>
                    )}

                    {sectionPassed.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <button
                                type="button"
                                className="text-muted-foreground self-start text-xs underline-offset-2 hover:underline"
                                aria-expanded={showPassed}
                                onClick={() => setShowPassed((value) => !value)}
                            >
                                {t("passed", { count: sectionPassed.length })}
                            </button>
                            {showPassed && (
                                <ul className="flex min-w-0 flex-col">
                                    {sectionPassed.map((finding, index) => (
                                        <FindingRow
                                            key={`${finding.code}-${index}`}
                                            finding={finding}
                                            canFix={view.canFix}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {view.canFix && (
                        <div className="flex items-start gap-3 border-t border-border pt-3">
                            <Switch
                                checked={view.dedicated}
                                disabled={savingDedicated}
                                aria-label={t("dedicated.label")}
                                aria-describedby={`dedicated-${domain}`}
                                onChange={(next) => void toggleDedicated(next)}
                            />
                            <div className="min-w-0">
                                <p className="text-sm">{t("dedicated.label")}</p>
                                <p
                                    id={`dedicated-${domain}`}
                                    className="text-muted-foreground text-xs"
                                >
                                    {t("dedicated.hint")}
                                </p>
                                {view.lastAutoFix && (
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        {t("dedicated.last", { applied: view.lastAutoFix.applied })}{" "}
                                        <RelativeTime iso={view.lastAutoFix.at} />
                                    </p>
                                )}
                            </div>
                        </div>
                    )}

                    {section === "email" && (report.sends || report.receives) && (
                        <SendingSources domain={domain} view={view} rua={report.rua} />
                    )}
                </>
            )}

            {fixing && report && (
                <FixDialog
                    scope={scope}
                    domain={domain}
                    report={report}
                    onClose={() => setFixing(false)}
                    onApplied={(next) => accept(next)}
                />
            )}
        </div>
    );
}
