"use client";

/**
 * One organization's statement, with its budget above it.
 *
 * The budget is measured against the month on screen, so looking back at August
 * says how August went against it, and the running month says how this one is
 * going. The same figure the hourly pass announces from, at 80% and at 100%.
 */

import { Button } from "@polaris/ui";
import { RefreshCw } from "lucide-react";
import { BudgetCard } from "./budget-card";
import type { CurrencyCode } from "@polaris/core";
import * as parts from "@/components/billing/statement-parts";

export function BillingView({
    orgId,
    slug,
    currency,
    budget,
    canSetPrices
}: {
    orgId: string;
    slug: string;
    currency: CurrencyCode | null;
    budget: { amount: number; currency: CurrencyCode } | null;
    canSetPrices: boolean;
}) {
    const base = `/api/orgs/${encodeURIComponent(slug)}/billing`;
    const { data, error, stale, refreshing, refresh, month, months } = parts.useStatement(base, `org.billing:${slug}`);

    return (
        <div className="flex flex-col gap-4">
            <BudgetCard
                orgId={orgId}
                currency={data?.statement.rates?.currency ?? currency}
                initial={budget}
                spent={data ? (data.statement.cost?.total ?? 0) : null}
                monthLabel={data?.monthLabel ?? null}
                canSetPrices={canSetPrices}
            />

            <parts.StatementToolbar month={month} months={months} exportEndpoint={`${base}/export`}>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={refresh}
                    disabled={refreshing}
                    aria-label="Refresh"
                    title="Refresh"
                >
                    <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden />
                </Button>
            </parts.StatementToolbar>
            {error ? <p className="text-danger text-sm">{error}</p> : null}
            {stale ? <p className="text-warning-ink text-sm">Showing the last statement read. {stale}</p> : null}
            <parts.StatementTotals view={data} />
            <parts.StatementTable
                view={data}
                showOwner={false}
                emptyLabel="This organization has no projects yet. A project created while it is the open shelf belongs to it."
            />
            <parts.StatementNotes view={data} />
        </div>
    );
}
