/**
 * This deployment's connectivity record as somebody with its link sees it:
 * whether it is online now, how much of each period it was, and the recent
 * outages with how long each lasted. Drawn on the server from the record as
 * anybody but an administrator is sent it (`sharedConnectivityReport`), so
 * nothing here names the network it was measured on.
 */

import type { ConnectivityReport } from "@/lib/connectivity/outage-tracker";
import { getTranslations } from "@/lib/i18n/request";
import { GuestWhen } from "./guest-when";
import { span } from "./status-guest";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

/** The most outages the page lists. The link is a glance, not the archive. */
const RECENT = 20;

export async function ConnectivityGuest({
    report,
    until
}: {
    report: ConnectivityReport;
    until: string | null;
}) {
    const t = await getTranslations("publicPages");
    const state = report.open ? "down" : report.lastPass ? "up" : "unknown";
    const tone = state === "up" ? "success" : state === "down" ? "danger" : "neutral";
    const units = (key: "days" | "hours" | "minutes", n: number) =>
        t(`guestStatus.units.${key}`, { n });
    const recent = report.outages.slice(0, RECENT);
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate">{t("guestConnectivity.title")}</span>
                    <Badge variant={tone}>{t(`guestStatus.state.${state}`)}</Badge>
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 text-sm text-muted-foreground">
                <ul className="flex flex-col gap-1">
                    {report.periods.map((period) =>
                        period.uptime === null ? null : (
                            <li key={period.key}>
                                {t("guestConnectivity.uptime", {
                                    period: t(`guestConnectivity.periods.${period.key}`),
                                    share: `${(Math.floor(period.uptime * 10_000) / 100).toFixed(2)}%`
                                })}
                            </li>
                        )
                    )}
                </ul>
                <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium text-foreground">
                        {t("guestConnectivity.recent")}
                    </h2>
                    {recent.length === 0 ? <p>{t("guestConnectivity.none")}</p> : null}
                    <ul className="flex flex-col gap-2">
                        {recent.map((outage) => {
                            const end = Date.parse(outage.endedAt ?? outage.lastSeenAt);
                            const seconds = Math.max(
                                0,
                                Math.round((end - Date.parse(outage.startedAt)) / 1000)
                            );
                            return (
                                <li key={outage.id} className="flex min-w-0 flex-col">
                                    <span className="text-foreground">
                                        {t(`guestConnectivity.kind.${outage.kind}`)}
                                    </span>
                                    <GuestWhen at={outage.startedAt} message="guestConnectivity.started" />
                                    <span>
                                        {outage.endedAt === null
                                            ? t("guestConnectivity.ongoing")
                                            : t("guestConnectivity.lasted", {
                                                  span: span(seconds, units)
                                              })}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
                {until ? <GuestWhen at={until} message="guestLink.until" /> : null}
                <p className="text-xs">{t("guestConnectivity.seeOnly")}</p>
            </CardBody>
        </Card>
    );
}
