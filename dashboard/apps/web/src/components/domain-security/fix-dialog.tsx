"use client";

/**
 * The preview of what Polaris would change, and the one button that changes it.
 *
 * Every change shows what is there now beside what would be there after, and
 * each can be left out. A stricter DMARC policy is never in the plan by itself:
 * it appears only once somebody picks one here, because moving to quarantine or
 * reject before every sender passes is how real mail gets lost. What it does
 * offer is a recommendation, read from who the DMARC reports say sends as the
 * domain, so the choice is never left without an answer.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { reportHost } from "@/lib/domain-security/records";
import { dmarcAdvice } from "@/lib/domain-security/dmarc-advice";
import { normalizeReportTo, reportToSchema } from "@/lib/domain-security/report-to";
import type { SecurityReport } from "@/lib/domain-security/types";
import type { DomainSecurityView } from "@/lib/domain-security/service";
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import {
    applyDomainSecurityAction,
    planDomainSecurityAction,
    type PreviewChange,
    type SecurityRef
} from "@/app/(app)/account/domains/security-actions";
import * as polls from "../shared-polls";

type Policy = "keep" | "quarantine" | "reject";

const ACTION_VARIANT = { create: "success", update: "warning", delete: "danger" } as const;

function ChangeRow({
    change,
    checked,
    onToggle
}: {
    change: PreviewChange;
    checked: boolean;
    onToggle: (next: boolean) => void;
}) {
    const t = useTranslations("domainSecurity");
    const label =
        change.kind === "dnssec"
            ? t("fix.dnssec")
            : change.kind === "edge"
              ? t("fix.edge")
              : `${change.type} ${change.name}`;
    return (
        <li className="flex min-w-0 items-start gap-3 border-t border-border py-3 first:border-t-0">
            <Checkbox
                checked={checked}
                aria-label={t("fix.include", { name: label })}
                onChange={(event) => onToggle(event.target.checked)}
                className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant={ACTION_VARIANT[change.action]} className="shrink-0">
                        {t(`fix.action.${change.action}`)}
                    </Badge>
                    <span className="min-w-0 break-all font-mono text-xs font-semibold">
                        {label}
                    </span>
                </div>
                <p className="text-muted-foreground text-xs">
                    {t(`findings.${change.code}.title` as NamespaceKey<"domainSecurity">)}
                </p>
                {change.kind === "dnssec" && (
                    <p className="text-muted-foreground text-xs">{t("fix.dnssecHint")}</p>
                )}
                {change.kind === "edge" && (
                    <p className="text-muted-foreground text-xs">
                        {t("fix.edgeHint", { hostname: change.name })}
                    </p>
                )}
                {change.kind === "record" && (
                    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">{t("fix.now")}</dt>
                        <dd className="min-w-0 break-all font-mono">
                            {change.before.length > 0 ? (
                                change.before.join("\n")
                            ) : (
                                <span className="text-muted-foreground font-sans">
                                    {t("fix.nothing")}
                                </span>
                            )}
                        </dd>
                        <dt className="text-muted-foreground">{t("fix.after")}</dt>
                        <dd className="min-w-0 break-all font-mono">
                            {change.after ?? (
                                <span className="text-muted-foreground font-sans">
                                    {t("fix.nothing")}
                                </span>
                            )}
                        </dd>
                    </dl>
                )}
            </div>
        </li>
    );
}

export function FixDialog({
    scope,
    domain,
    report,
    view,
    onClose,
    onApplied
}: {
    scope: SecurityRef;
    domain: string;
    report: SecurityReport;
    /** Null until the panel has read the domain once. */
    view: DomainSecurityView | null;
    onClose: () => void;
    onApplied: (view: DomainSecurityView) => void;
}) {
    const t = useTranslations("domainSecurity");
    const tc = useTranslations("common");
    const current = report.findings.some((finding) => finding.code === "dmarcNone")
        ? "none"
        : report.findings.some((finding) => finding.code === "dmarcQuarantine")
          ? "quarantine"
          : null;
    const advice = current
        ? dmarcAdvice(current, view ?? { reportAddress: null, sources: null }, [
              ...new Set(report.rua.map(reportHost).filter((host): host is string => host !== null))
          ])
        : null;
    const recommended = advice?.kind === "tighten" ? advice.to : "keep";
    const [policy, setPolicy] = useState<Policy>("keep");
    const [changes, setChanges] = useState<PreviewChange[] | null>(null);
    const [left, setLeft] = useState<Set<string>>(new Set());
    const [error, setError] = useState("");
    const [applying, setApplying] = useState(false);
    const [outcome, setOutcome] = useState("");
    // Where reports go, for a domain nobody receives them for: the one fix the
    // advice asks for, offered here so it can be applied like the others.
    const asksForReports = advice?.kind === "noReports";
    const [reportDraft, setReportDraft] = useState("");
    const reportTyped = reportDraft.trim() !== "";
    const reportValid = reportTyped && reportToSchema.safeParse(reportDraft).success;
    const reportTo = asksForReports && reportValid ? normalizeReportTo(reportDraft) : null;

    useEffect(() => {
        let cancelled = false;
        setChanges(null);
        // Typing is waited out, so the plan is not read again on every key.
        const timer = window.setTimeout(
            async () => {
                const result = await polls
                    .domainSecurityPlan(
                        scope,
                        domain,
                        policy === "keep" ? null : policy,
                        undefined,
                        reportTo
                    )
                    .catch(() => null);
            if (cancelled) return;
                if (result?.changes) setChanges(result.changes);
                else setError(result?.error ?? t("errors.failed"));
            },
            reportTo ? 400 : 0
        );
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-planned when the policy or the report address changes
    }, [policy, reportTo]);

    const chosen = (changes ?? []).filter((change) => !left.has(change.fingerprint));

    async function apply() {
        if (chosen.length === 0) return;
        setApplying(true);
        setError("");
        const result = await runAction(
            () =>
                applyDomainSecurityAction(
                    scope,
                    domain,
                    chosen.map((change) => change.fingerprint),
                    policy === "keep" ? null : policy,
                    reportTo
                ),
            setError
        );
        setApplying(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.view) onApplied(result.view);
        const failed = (result.results ?? []).filter((entry) => !entry.ok);
        const ok = (result.results ?? []).length - failed.length;
        if (failed.length === 0) {
            onClose();
            return;
        }
        setOutcome(
            `${t("fix.applied", { ok })}. ${t("fix.someFailed", {
                failed: failed.length,
                detail: failed
                    .map((entry) => entry.detail ?? "")
                    .filter(Boolean)
                    .join("; ")
            })}`
        );
        setChanges(null);
        const again = await planDomainSecurityAction(
            scope,
            domain,
            policy === "keep" ? null : policy,
            reportTo
        ).catch(() => null);
        if (again?.changes) setChanges(again.changes);
    }

    const policyOptions = (
        ["keep", ...(current === "none" ? (["quarantine"] as const) : []), "reject"] as const
    ).map((value) => ({
        value,
        label:
            value === recommended
                ? t("fix.advice.option", { label: t(`fix.policy.${value}`) })
                : t(`fix.policy.${value}`)
    }));

    return (
        <Dialog open onOpenChange={(open) => !open && !applying && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("fix.title", { domain })}</DialogTitle>
                    <DialogDescription>{t("fix.intro")}</DialogDescription>
                </DialogHeader>

                {current && (
                    <div className="flex flex-col gap-1.5">
                        <label
                            className="flex flex-wrap items-center gap-2 text-sm"
                            htmlFor={`dmarc-policy-${domain}`}
                        >
                            {t("fix.policy.label")}
                            <Select
                                id={`dmarc-policy-${domain}`}
                                value={policy}
                                onValueChange={(next) => setPolicy(next as Policy)}
                                options={policyOptions}
                                className="w-44"
                            />
                        </label>
                        {advice && (
                            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                <p className="min-w-0 text-sm">
                                    <span className="font-medium">{t("fix.advice.title")}: </span>
                                    {advice.kind === "tighten"
                                        ? advice.to === "quarantine"
                                            ? t("fix.advice.tightenQuarantine")
                                            : t("fix.advice.tightenReject")
                                        : advice.kind === "fixSenders"
                                          ? t("fix.advice.fixSenders", {
                                                count: advice.count,
                                                domain
                                            })
                                          : advice.kind === "readElsewhere"
                                            ? t("fix.advice.readElsewhere", {
                                                  hosts: advice.hosts.join(", "),
                                                  to: advice.to
                                              })
                                            : advice.kind === "waitReports"
                                              ? t("fix.advice.waitReports")
                                              : t("fix.advice.noReports", { domain })}
                                </p>
                                {advice.kind === "tighten" && policy !== advice.to && (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        className="shrink-0"
                                        onClick={() => setPolicy(advice.to)}
                                    >
                                        {t("fix.advice.use")}
                                    </Button>
                                )}
                            </div>
                        )}
                        <p className="text-muted-foreground text-xs">
                            {t("fix.policy.hint", { domain })}
                        </p>
                        {asksForReports && (
                            <div className="flex min-w-0 flex-col gap-1">
                                <label
                                    className="text-sm font-medium"
                                    htmlFor={`dmarc-report-to-${domain}`}
                                >
                                    {t("fix.reportTo.label")}
                                </label>
                                <Input
                                    id={`dmarc-report-to-${domain}`}
                                    type="email"
                                    autoComplete="email"
                                    value={reportDraft}
                                    placeholder={t("fix.reportTo.placeholder", { domain })}
                                    aria-invalid={reportTyped && !reportValid}
                                    aria-describedby={`dmarc-report-to-${domain}-hint`}
                                    onChange={(event) => setReportDraft(event.target.value)}
                                />
                                <p
                                    id={`dmarc-report-to-${domain}-hint`}
                                    className={
                                        reportTyped && !reportValid
                                            ? "text-danger text-xs"
                                            : "text-muted-foreground text-xs"
                                    }
                                >
                                    {reportTyped && !reportValid
                                        ? t("fix.reportTo.invalid")
                                        : t("fix.reportTo.hint", { domain })}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <p
                        role="alert"
                        className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                    >
                        {error}
                    </p>
                )}
                {outcome && (
                    <p
                        role="status"
                        className="bg-warning-soft text-warning-ink rounded-md px-3 py-2 text-sm"
                    >
                        {outcome}
                    </p>
                )}

                {changes === null ? (
                    <div
                        className="flex flex-col gap-2"
                        aria-busy="true"
                        aria-label={t("fix.loading")}
                    >
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ) : changes.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        {current && policy === "keep"
                            ? asksForReports
                                ? t("fix.noneButReports")
                                : t("fix.noneButPolicy")
                            : t("fix.none")}
                    </p>
                ) : (
                    <ul className="flex min-w-0 flex-col">
                        {changes.map((change) => (
                            <ChangeRow
                                key={change.fingerprint}
                                change={change}
                                checked={!left.has(change.fingerprint)}
                                onToggle={(next) =>
                                    setLeft((previous) => {
                                        const copy = new Set(previous);
                                        if (next) copy.delete(change.fingerprint);
                                        else copy.add(change.fingerprint);
                                        return copy;
                                    })
                                }
                            />
                        ))}
                    </ul>
                )}

                <DialogFooter>
                    <Button variant="ghost" disabled={applying} onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        aria-disabled={applying || chosen.length === 0}
                        disabled={applying || chosen.length === 0}
                        onClick={() => void apply()}
                    >
                        {applying
                            ? t("fix.applying")
                            : chosen.length === 0
                              ? t("fix.nothingToApply")
                              : t("fix.apply", { count: chosen.length })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
