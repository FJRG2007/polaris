"use client";

/**
 * The instance's statement: the prices, the month's totals, what each owner
 * spent against their budget, and a line per project.
 *
 * Owners get their own table above the projects because that is the question a
 * charge-back starts with - how much does each team owe - and the project lines
 * under it are the detail somebody asks for when they dispute it.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { RefreshCw } from "lucide-react";
import { RatesCard } from "./rates-card";
import { Button, PageHeader, Skeleton } from "@polaris/ui";
import * as parts from "@/components/billing/statement-parts";

export function BillingView({ rates }: { rates: core.BillingRates | null }) {
    const { data, error, stale, refreshing, refresh, month, months } = parts.useStatement(
        "/api/admin/billing",
        "admin.billing"
    );

    return (
        <>
            <PageHeader
                title="Billing"
                description="What each project and organization used, month by month, priced at the rates you set. Nothing is charged anywhere - this is for your own statements."
                actions={
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw
                            className={refreshing ? "size-4 animate-spin" : "size-4"}
                            aria-hidden
                        />
                    </Button>
                }
            />

            <RatesCard rates={rates} onChange={refresh} />

            <section className="flex flex-col gap-4">
                <parts.StatementToolbar
                    month={month}
                    months={months}
                    exportEndpoint="/api/admin/billing/export"
                />
                {error ? <p className="text-danger text-sm">{error}</p> : null}
                {stale ? (
                    <p className="text-warning-ink text-sm">
                        Showing the last statement read. {stale}
                    </p>
                ) : null}
                <parts.StatementTotals view={data} />
                <OwnersTable view={data} />
                <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">Projects</h2>
                    <parts.StatementTable
                        view={data}
                        showOwner
                        emptyLabel="There are no projects on this Polaris yet."
                    />
                </div>
                <parts.StatementNotes view={data} />
            </section>
        </>
    );
}

/** Each owner's month, with its budget beside it when it has one. */
function OwnersTable({ view }: { view: parts.BillingResponse | null }) {
    const statement = view?.statement ?? null;
    const format = parts.useStatementFormat(statement?.rates?.currency);
    if (statement && statement.owners.length === 0) return null;

    return (
        <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">By owner</h2>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                    <thead>
                        <tr className="border-border/60 border-b text-left">
                            <th className="w-full max-w-0 px-2 py-1.5">Owner</th>
                            <th className="px-2 py-1.5 text-right">Projects</th>
                            <th className="px-2 py-1.5 text-right">CPU</th>
                            <th className="px-2 py-1.5 text-right">Cost</th>
                            <th className="px-2 py-1.5 text-right">Budget</th>
                        </tr>
                    </thead>
                    <tbody>
                        {statement === null
                            ? [0, 1].map((row) => (
                                  <tr key={row} className="border-border/40 border-b last:border-0">
                                      <td colSpan={5} className="px-2 py-2.5">
                                          <Skeleton className="h-4 w-full" />
                                      </td>
                                  </tr>
                              ))
                            : statement.owners.map((entry) => {
                                  const budget =
                                      entry.owner.kind === "org"
                                          ? (view?.budgets?.[entry.owner.id] ?? null)
                                          : null;
                                  const spent = entry.cost?.total ?? 0;
                                  const level =
                                      budget === null ? 0 : core.budgetLevel(spent, budget);
                                  return (
                                      <tr
                                          key={`${entry.owner.kind}:${entry.owner.id}`}
                                          className="border-border/40 border-b last:border-0"
                                      >
                                          <td className="w-full max-w-0 px-2 py-2">
                                              <OwnerName owner={entry.owner} />
                                          </td>
                                          <td className="px-2 py-2 text-right tabular-nums">
                                              {entry.projects}
                                          </td>
                                          <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                                              {parts.quantity(entry.usage.cpuHours)} vCPU-h
                                          </td>
                                          <td className="px-2 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                                              {entry.cost ? format.currency(entry.cost.total) : "-"}
                                          </td>
                                          <td
                                              className={`px-2 py-2 text-right tabular-nums whitespace-nowrap ${
                                                  level >= 100
                                                      ? "text-danger"
                                                      : level >= 80
                                                        ? "text-warning-ink"
                                                        : "text-muted-foreground"
                                              }`}
                                          >
                                              {budget === null
                                                  ? "-"
                                                  : `${Math.round((spent / budget) * 100)}% of ${format.currency(budget)}`}
                                          </td>
                                      </tr>
                                  );
                              })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** An owner's name, leading to their own statement or profile. */
function OwnerName({ owner }: { owner: core.BillingOwner }) {
    const href = parts.ownerHref(owner);
    const label = (
        <>
            <span className="truncate" title={owner.name}>
                {owner.name}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
                {owner.kind === "org" ? "Organization" : "Personal"}
            </span>
        </>
    );
    if (!href) return <span className="flex min-w-0 items-center gap-2">{label}</span>;
    return (
        <Link
            href={href}
            className="hover:text-foreground flex min-w-0 items-center gap-2 font-medium"
        >
            {label}
        </Link>
    );
}
