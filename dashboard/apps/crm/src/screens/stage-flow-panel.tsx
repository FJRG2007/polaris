"use client";

/**
 * How deals moved through the stages - how many reached each one, how long
 * they stayed, how many of those were won - and the deals won and lost with
 * the reasons given. Drawn under the forecast; fills in when it arrives, from
 * what this tab kept last time first.
 */

import { unwrap } from "./call";
import { useCrmT } from "./i18n";
import { cn } from "@polaris/ui";
import { useCallback } from "react";
import { fieldOf } from "../model/objects";
import { optionLabel } from "./custom-fields";
import * as actions from "../actions/forecast";
import { hostUi } from "@polaris/app-host/client";
import type { ReasonCount, StageFlow } from "../model/stage-flow";

type T = ReturnType<typeof useCrmT>;

const percentOf = (part: number, whole: number) =>
    whole === 0 ? null : Math.round((part / whole) * 100);

function Reasons({ title, reasons, t }: { title: string; reasons: ReasonCount[]; t: T }) {
    return (
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-3">
            <h3 className="mb-2 text-[0.8125rem] font-semibold">{title}</h3>
            {reasons.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">{t("forecast.flow.none")}</p>
            ) : (
                <ul className="flex flex-col gap-1 text-[0.8125rem]">
                    {reasons.map((entry) => (
                        <li key={entry.reason} className="flex min-w-0 items-baseline gap-2">
                            <span
                                className={cn(
                                    "min-w-0 flex-1 truncate",
                                    entry.reason === "" && "italic text-muted-foreground"
                                )}
                                title={entry.reason || undefined}
                            >
                                {entry.reason || t("forecast.flow.noReason")}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                                {entry.deals}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function StageFlowPanel({ mine }: { mine: boolean }) {
    const t = useCrmT();
    const load = useCallback(
        () => unwrap(() => actions.stageFlowAction({ mine }), t("errors.loadFailed")),
        [mine, t]
    );
    const reading = hostUi.liveRead.useLiveRead<{ flow: StageFlow }>({
        cacheKey: `crm:stage-flow:${mine ? "mine" : "all"}`,
        load
    });
    const flow = reading.data?.flow ?? null;
    const stageField = fieldOf("opportunities", "stage")!;
    const days = (value: number | null) =>
        value === null ? "-" : t("forecast.flow.days", { count: value });

    return (
        <section aria-labelledby="crm-stage-flow" className="flex flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 id="crm-stage-flow" className="text-[0.9375rem] font-semibold">
                    {t("forecast.flow.title")}
                </h2>
                {flow ? (
                    <p className="text-[0.8125rem] text-muted-foreground">
                        {flow.winRate === null
                            ? t("forecast.flow.noneDecided")
                            : t("forecast.flow.winRate", {
                                  rate: flow.winRate,
                                  won: flow.won,
                                  lost: flow.lost
                              })}
                    </p>
                ) : null}
            </div>
            {!flow && reading.error ? (
                <p className="text-[0.8125rem] text-destructive">{reading.error}</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                    <table className="w-full min-w-[30rem] text-[0.8125rem]">
                        <caption className="sr-only">{t("forecast.flow.title")}</caption>
                        <thead className="text-left text-muted-foreground">
                            <tr className="border-b border-border">
                                <th scope="col" className="sticky left-0 bg-card px-3 py-2 font-medium">
                                    {t("forecast.flow.stage")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.flow.reached")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.flow.now")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.flow.stay")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.flow.converted")}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {flow
                                ? flow.steps.map((step) => {
                                      const rate = percentOf(step.won, step.reached);
                                      return (
                                          <tr
                                              key={step.stage}
                                              className="border-b border-border last:border-b-0"
                                          >
                                              <th
                                                  scope="row"
                                                  className="sticky left-0 bg-card px-3 py-2 text-left font-normal"
                                              >
                                                  {optionLabel(
                                                      t,
                                                      "opportunities",
                                                      stageField,
                                                      step.stage
                                                  )}
                                              </th>
                                              <td className="px-3 py-2 text-right tabular-nums">
                                                  {step.reached}
                                              </td>
                                              <td className="px-3 py-2 text-right tabular-nums">
                                                  {step.now}
                                              </td>
                                              <td className="px-3 py-2 text-right tabular-nums">
                                                  {days(step.averageDays)}
                                              </td>
                                              <td className="px-3 py-2 text-right tabular-nums">
                                                  {rate === null ? "-" : `${rate}%`}
                                              </td>
                                          </tr>
                                      );
                                  })
                                : [0, 1, 2, 3].map((row) => (
                                      <tr key={row} aria-hidden>
                                          <td colSpan={5} className="px-3 py-2">
                                              <span className="block h-4 animate-pulse rounded bg-muted" />
                                          </td>
                                      </tr>
                                  ))}
                        </tbody>
                    </table>
                </div>
            )}
            {flow?.capped ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                    {t("forecast.flow.capped")}
                </p>
            ) : null}
            {flow ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                    <Reasons
                        title={t("forecast.flow.wonReasons")}
                        reasons={flow.wonReasons}
                        t={t}
                    />
                    <Reasons
                        title={t("forecast.flow.lostReasons")}
                        reasons={flow.lostReasons}
                        t={t}
                    />
                </div>
            ) : null}
        </section>
    );
}
