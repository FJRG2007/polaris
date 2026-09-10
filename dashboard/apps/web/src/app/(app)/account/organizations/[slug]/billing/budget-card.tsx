"use client";

/**
 * The organization's monthly budget: how far into it the month is, and the field
 * that sets it.
 *
 * Checked as it is typed against the schema the server saves with. An empty field
 * is not yet a budget rather than a wrong one, so it disables Save instead of
 * drawing an error. Saving shows the new budget at once and puts the old one back
 * if the server refuses it.
 *
 * With no prices on the instance there is nothing to measure a budget against,
 * and the card says so rather than offering a field that could only be refused.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { Button, Card, CardBody, Input, cn } from "@polaris/ui";
import { clearOrgBudgetAction, saveOrgBudgetAction } from "./actions";
import { useStatementFormat } from "@/components/billing/statement-parts";
import { budgetLevel, BUDGET_THRESHOLDS, orgBudgetInputSchema, type CurrencyCode } from "@polaris/core";

type Budget = { amount: number; currency: CurrencyCode };

export function BudgetCard({
    orgId,
    currency,
    initial,
    spent,
    monthLabel,
    canSetPrices
}: {
    orgId: string;
    /** The currency the instance prices in, or null when it has no prices. */
    currency: CurrencyCode | null;
    initial: Budget | null;
    /** What the month on screen came to, or null while it is being read. */
    spent: number | null;
    monthLabel: string | null;
    canSetPrices: boolean;
}) {
    const [saved, setSaved] = useState<Budget | null>(initial);
    const [draft, setDraft] = useState(initial ? String(initial.amount) : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirm, confirmDialog] = useConfirm();
    const format = useStatementFormat(saved?.currency ?? currency);

    const parsed = useMemo(() => orgBudgetInputSchema.safeParse({ amount: draft }), [draft]);
    const problem = draft.trim() === "" || parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
    const matches = saved !== null && saved.currency === currency;
    const unchanged = parsed.success && matches && parsed.data.amount === saved.amount;

    const save = async () => {
        if (!parsed.success || unchanged || !currency) return;
        const previous = saved;
        setSaved({ amount: parsed.data.amount, currency });
        setBusy(true);
        setError("");
        const result = await runAction(() => saveOrgBudgetAction(orgId, { amount: draft }), setError);
        setBusy(false);
        if (!result || result.error) {
            setSaved(previous);
            if (result?.error) setError(result.error);
            return;
        }
        if (result.budget) {
            setSaved(result.budget);
            setDraft(String(result.budget.amount));
        }
    };

    const clear = async () => {
        const ok = await confirm({
            title: "Remove the budget?",
            description: "Nobody will be told when this organization's spending passes 80% or 100% of a month.",
            confirmLabel: "Remove budget",
            danger: true
        });
        if (!ok) return;
        const previous = saved;
        const previousDraft = draft;
        setSaved(null);
        setDraft("");
        setBusy(true);
        setError("");
        const result = await runAction(() => clearOrgBudgetAction(orgId), setError);
        setBusy(false);
        if (!result || result.error) {
            setSaved(previous);
            setDraft(previousDraft);
            if (result?.error) setError(result.error);
        }
    };

    if (!currency) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Monthly budget</h2>
                    <p className="text-muted-foreground text-xs">
                        This Polaris has no prices set, so the statement shows usage only and there is nothing to measure
                        a budget against.{" "}
                        {canSetPrices ? (
                            <Link href="/admin/billing" className="text-foreground underline underline-offset-2">
                                Set prices
                            </Link>
                        ) : (
                            "Its administrators set them."
                        )}
                    </p>
                </CardBody>
            </Card>
        );
    }

    const share = matches && spent !== null ? (spent / saved.amount) * 100 : null;
    const level = matches && spent !== null ? budgetLevel(spent, saved.amount) : 0;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">Monthly budget</h2>
                        <p className="text-muted-foreground text-xs">
                            The people who run this organization&apos;s settings are told when a month reaches{" "}
                            {BUDGET_THRESHOLDS.map((threshold) => `${threshold}%`).join(" and ")} of it.
                        </p>
                    </div>
                    {matches && share !== null ? (
                        <p
                            className={cn(
                                "shrink-0 text-sm font-medium tabular-nums",
                                level >= 100 ? "text-danger" : level >= 80 ? "text-warning-ink" : "text-foreground"
                            )}
                        >
                            {format.currency(spent)} of {format.currency(saved.amount)}
                        </p>
                    ) : null}
                </div>

                {saved && !matches ? (
                    <p className="border-warning-edge bg-warning-soft text-warning-ink rounded-md border px-3 py-2 text-xs">
                        This budget was set in {saved.currency} and prices are now in {currency}. Set it again in{" "}
                        {currency} to keep it measured.
                    </p>
                ) : null}

                {matches && share !== null ? (
                    <div className="flex flex-col gap-1">
                        <div
                            className="bg-muted h-2 overflow-hidden rounded-full"
                            role="progressbar"
                            aria-label="Budget used"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.min(100, Math.round(share))}
                        >
                            <div
                                className={cn(
                                    "h-full rounded-full",
                                    level >= 100 ? "bg-danger" : level >= 80 ? "bg-warning" : "bg-primary"
                                )}
                                style={{ width: `${Math.min(100, share)}%` }}
                            />
                        </div>
                        <p className="text-muted-foreground text-xs">
                            {Math.round(share)}% used{monthLabel ? ` in ${monthLabel}` : ""}.
                        </p>
                    </div>
                ) : null}

                <div className="flex flex-wrap items-start gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                        <label htmlFor="org-budget" className="sr-only">
                            Monthly budget in {currency}
                        </label>
                        <div className="flex items-center gap-2">
                            <Input
                                id="org-budget"
                                className="w-40"
                                inputMode="decimal"
                                autoComplete="off"
                                placeholder="250"
                                value={draft}
                                aria-invalid={problem ? true : undefined}
                                aria-describedby={problem ? "org-budget-error" : undefined}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") void save();
                                }}
                            />
                            <span className="text-muted-foreground text-xs">{currency} a month</span>
                        </div>
                        {problem ? (
                            <p id="org-budget-error" className="text-danger text-xs">
                                {problem}
                            </p>
                        ) : null}
                    </div>
                    <Button
                        size="sm"
                        onClick={() => void save()}
                        disabled={busy || !parsed.success || unchanged}
                        aria-disabled={busy || !parsed.success || unchanged}
                    >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                        {saved ? "Save budget" : "Set budget"}
                    </Button>
                    {saved ? (
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => void clear()}
                            disabled={busy}
                            aria-label="Remove the budget"
                            title="Remove the budget"
                        >
                            <Trash2 className="size-4" aria-hidden />
                        </Button>
                    ) : null}
                </div>

                {error ? <p className="text-danger text-sm">{error}</p> : null}
            </CardBody>
            {confirmDialog}
        </Card>
    );
}
