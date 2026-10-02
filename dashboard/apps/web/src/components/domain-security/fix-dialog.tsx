"use client";

/**
 * The preview of what Polaris would change, and the one button that changes it.
 *
 * Every change shows what is there now beside what would be there after, and
 * each can be left out. A stricter DMARC policy is never in the plan by itself:
 * it appears only once somebody picks one here, because moving to quarantine or
 * reject before every sender passes is how real mail gets lost.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    Select,
    Skeleton
} from "@polaris/ui";
import {
    applyDomainSecurityAction,
    planDomainSecurityAction,
    type PreviewChange,
    type SecurityRef
} from "@/app/(app)/account/domains/security-actions";

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
    onClose,
    onApplied
}: {
    scope: SecurityRef;
    domain: string;
    report: SecurityReport;
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
    const [policy, setPolicy] = useState<Policy>("keep");
    const [changes, setChanges] = useState<PreviewChange[] | null>(null);
    const [left, setLeft] = useState<Set<string>>(new Set());
    const [error, setError] = useState("");
    const [applying, setApplying] = useState(false);
    const [outcome, setOutcome] = useState("");

    useEffect(() => {
        let cancelled = false;
        setChanges(null);
        void (async () => {
            const result = await planDomainSecurityAction(
                scope,
                domain,
                policy === "keep" ? null : policy
            ).catch(() => null);
            if (cancelled) return;
            if (result?.changes) setChanges(result.changes);
            else setError(result?.error ?? t("errors.failed"));
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-planned when the policy changes
    }, [policy]);

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
                    policy === "keep" ? null : policy
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
            policy === "keep" ? null : policy
        ).catch(() => null);
        if (again?.changes) setChanges(again.changes);
    }

    const policyOptions = [
        { value: "keep", label: t("fix.policy.keep") },
        ...(current === "none" ? [{ value: "quarantine", label: t("fix.policy.quarantine") }] : []),
        { value: "reject", label: t("fix.policy.reject") }
    ];

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
                        <p className="text-muted-foreground text-xs">
                            {t("fix.policy.hint", { domain })}
                        </p>
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
                    <p className="text-muted-foreground text-sm">{t("fix.none")}</p>
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
                        {applying ? t("fix.applying") : t("fix.apply", { count: chosen.length })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
