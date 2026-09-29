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
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BillingView({ rates }: { rates: core.BillingRates | null }) {
    const t = useTranslations("admin");
    const { data, error, stale, refreshing, refresh, month, months } = parts.useStatement(
        "/api/admin/billing",
        "admin.billing"
    );

    return (
        <>
            <PageHeader
                title={t("billing.title")}
                description={t("billing.description")}
                actions={
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label={t("billing.refresh")}
                        title={t("billing.refresh")}
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
                    <p className="text-warning-ink text-sm">{t("billing.stale", { reason: stale })}</p>
                ) : null}
                <parts.StatementTotals view={data} />
                <OwnersTable view={data} />
                <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("billing.projects")}</h2>
                    <parts.StatementTable
                        view={data}
                        showOwner
                        emptyLabel={t("billing.noProjects")}
                    />
                </div>
                <parts.StatementNotes view={data} />
            </section>
        </>
    );
}

/** Each owner's month, with its budget beside it when it has one. */
function OwnersTable({ view }: { view: parts.BillingResponse | null }) {
    const t = useTranslations("admin");
    const statement = view?.statement ?? null;
    const format = parts.useStatementFormat(statement?.rates?.currency);
    if (statement && statement.owners.length === 0) return null;

    return (
        <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{t("billing.owners.title")}</h2>
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[32rem] text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{t("billing.owners.owner")}</th>
                            <th className="px-3 py-2 font-medium text-right">{t("billing.owners.projects")}</th>
                            <th className="px-3 py-2 font-medium text-right">{t("billing.owners.cpu")}</th>
                            <th className="px-3 py-2 font-medium text-right">{t("billing.owners.cost")}</th>
                            <th className="px-3 py-2 font-medium text-right">{t("billing.owners.budget")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {statement === null
                            ? [0, 1].map((row) => (
                                  <tr key={row} className="border-t border-border">
                                      <td colSpan={5} className="px-3 py-2.5">
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
                                          className="border-t border-border hover:bg-card-hover"
                                      >
                                          <td className="w-full max-w-0 px-3 py-2">
                                              <OwnerName owner={entry.owner} />
                                          </td>
                                          <td className="px-3 py-2 text-right tabular-nums">
                                              {entry.projects}
                                          </td>
                                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                              {t("billing.owners.cpuHours", { hours: parts.quantity(entry.usage.cpuHours) })}
                                          </td>
                                          <td className="px-3 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                                              {entry.cost ? format.currency(entry.cost.total) : "-"}
                                          </td>
                                          <td
                                              className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                                                  level >= 100
                                                      ? "text-danger"
                                                      : level >= 80
                                                        ? "text-warning-ink"
                                                        : "text-muted-foreground"
                                              }`}
                                          >
                                              {budget === null
                                                  ? "-"
                                                  : t("billing.owners.budgetUsed", {
                                                        percent: Math.round((spent / budget) * 100),
                                                        budget: format.currency(budget)
                                                    })}
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
    const t = useTranslations("admin");
    const href = parts.ownerHref(owner);
    const label = (
        <>
            <span className="truncate" title={owner.name}>
                {owner.name}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
                {owner.kind === "org" ? t("billing.owners.organization") : t("billing.owners.personal")}
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
