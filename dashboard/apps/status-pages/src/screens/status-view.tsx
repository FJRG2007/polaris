/**
 * A status page as it reads: the headline, each component with its ninety days
 * of bars, open and recent incidents, and maintenance coming up.
 *
 * No hooks and no state, so the public page draws it on the server and the
 * operator's preview draws it in the browser, each with its own translator.
 */

import { cn } from "@polaris/ui";
import type { StatusTranslator } from "../lib/i18n";
import type { PublicStatusPage } from "../lib/public";
import type { ComponentState, DayTone } from "../model/uptime";

const STATE_DOT: Readonly<Record<ComponentState, string>> = {
    operational: "bg-success",
    degraded: "bg-warning",
    down: "bg-danger",
    maintenance: "bg-primary",
    unknown: "bg-muted-foreground/40"
};

const BAR: Readonly<Record<DayTone, string>> = {
    ok: "bg-success",
    degraded: "bg-warning",
    down: "bg-danger",
    none: "bg-muted"
};

function when(iso: string, locale: string): string {
    return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function StatusView({
    view,
    t,
    locale
}: {
    view: PublicStatusPage;
    t: StatusTranslator;
    locale: string;
}) {
    const open = view.incidents.filter((incident) => incident.state !== "resolved");
    const past = view.incidents.filter((incident) => incident.state === "resolved");
    return (
        <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
            <header className="space-y-2">
                <h1 className="break-words text-2xl font-semibold tracking-tight">{view.title}</h1>
                {view.description ? (
                    <p className="break-words text-sm text-muted-foreground">{view.description}</p>
                ) : null}
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
                    <span className={cn("size-2.5 shrink-0 rounded-full", STATE_DOT[view.state])} />
                    <span className="min-w-0 text-sm font-medium">{t(`page.headline.${view.state}`)}</span>
                </div>
            </header>

            {open.length > 0 ? (
                <section className="space-y-3" aria-labelledby="status-open">
                    <h2 id="status-open" className="text-sm font-semibold">
                        {t("public.openIncidents")}
                    </h2>
                    {open.map((incident) => (
                        <Incident key={incident.id} incident={incident} t={t} locale={locale} />
                    ))}
                </section>
            ) : null}

            {view.maintenance.length > 0 ? (
                <section className="space-y-3" aria-labelledby="status-maintenance">
                    <h2 id="status-maintenance" className="text-sm font-semibold">
                        {t("public.maintenance")}
                    </h2>
                    {view.maintenance.map((window) => (
                        <div key={window.id} className="rounded-lg border border-border bg-card p-4">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="min-w-0 break-words text-sm font-medium">{window.title}</p>
                                <span className="text-xs text-muted-foreground">
                                    {window.active ? t("public.inProgress") : t("public.scheduled")}
                                </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {when(window.startsAt, locale)} - {when(window.endsAt, locale)}
                            </p>
                            {window.components.length > 0 ? (
                                <p className="mt-1 break-words text-xs text-muted-foreground">
                                    {t("public.affects", { names: window.components.join(", ") })}
                                </p>
                            ) : null}
                            {window.body ? (
                                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{window.body}</p>
                            ) : null}
                        </div>
                    ))}
                </section>
            ) : null}

            <section className="space-y-3" aria-labelledby="status-components">
                <h2 id="status-components" className="text-sm font-semibold">
                    {t("public.components")}
                </h2>
                {view.components.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("public.noComponents")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                        {view.components.map((component) => (
                            <li key={component.id} className="space-y-2 p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium" title={component.name}>
                                            {component.name}
                                        </p>
                                        {component.description ? (
                                            <p className="break-words text-xs text-muted-foreground">
                                                {component.description}
                                            </p>
                                        ) : null}
                                    </div>
                                    <span className="flex shrink-0 items-center gap-1.5 text-xs">
                                        <span className={cn("size-2 rounded-full", STATE_DOT[component.state])} />
                                        {t(`state.${component.state}`)}
                                    </span>
                                </div>
                                <div className="flex h-7 items-stretch gap-px" role="img" aria-label={t("public.barsLabel")}>
                                    {component.bars.map((bar) => (
                                        <span
                                            key={bar.day}
                                            className={cn("min-w-0 flex-1 rounded-[1px]", BAR[bar.tone])}
                                            title={
                                                bar.ratio === null
                                                    ? t("public.barNoData", { day: bar.day })
                                                    : t("public.barUptime", {
                                                          day: bar.day,
                                                          percent: (Math.floor(bar.ratio * 10_000) / 100).toString()
                                                      })
                                            }
                                        />
                                    ))}
                                </div>
                                <div className="flex justify-between text-[0.6875rem] text-muted-foreground">
                                    <span>{t("public.daysAgo")}</span>
                                    <span>
                                        {component.uptime === null
                                            ? t("public.noData")
                                            : t("public.uptime", { percent: component.uptime.toString() })}
                                    </span>
                                    <span>{t("public.today")}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="space-y-3" aria-labelledby="status-past">
                <h2 id="status-past" className="text-sm font-semibold">
                    {t("public.pastIncidents")}
                </h2>
                {past.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("public.noPastIncidents")}</p>
                ) : (
                    past.map((incident) => (
                        <Incident key={incident.id} incident={incident} t={t} locale={locale} />
                    ))
                )}
            </section>
        </div>
    );
}

function Incident({
    incident,
    t,
    locale
}: {
    incident: PublicStatusPage["incidents"][number];
    t: StatusTranslator;
    locale: string;
}) {
    return (
        <article className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="min-w-0 break-words text-sm font-medium">{incident.title}</h3>
                <span className="text-xs text-muted-foreground">
                    {t(`impact.${incident.impact}`)} - {t(`incidentState.${incident.state}`)}
                </span>
            </div>
            {incident.components.length > 0 ? (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                    {t("public.affects", { names: incident.components.join(", ") })}
                </p>
            ) : null}
            <ol className="mt-3 space-y-2 border-l border-border pl-3">
                {incident.updates.map((update) => (
                    <li key={update.at + update.state}>
                        <p className="text-xs">
                            <span className="font-medium">{t(`incidentState.${update.state}`)}</span>
                            <span className="text-muted-foreground"> - {when(update.at, locale)}</span>
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm">{update.body}</p>
                    </li>
                ))}
            </ol>
        </article>
    );
}
