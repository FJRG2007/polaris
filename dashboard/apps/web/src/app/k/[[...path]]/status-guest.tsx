/**
 * A NAS, a server or a domain as somebody with its link sees it: its name, up
 * or down, and how long it has been up where that is known. Drawn on the
 * server from `guestStatusView`, which never carries where it is reached.
 */

import type { GuestStatusView } from "@/lib/access/guest-status";
import { getTranslations } from "@/lib/i18n/request";
import { GuestWhen } from "./guest-when";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

/** Seconds as the largest two units that say anything: "3 d 4 h", "12 min". */
function span(seconds: number, words: (key: "days" | "hours" | "minutes", n: number) => string) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0)
        return [words("days", days), hours > 0 ? words("hours", hours) : ""].join(" ").trim();
    if (hours > 0)
        return [words("hours", hours), minutes > 0 ? words("minutes", minutes) : ""]
            .join(" ")
            .trim();
    return words("minutes", Math.max(1, minutes));
}

export async function StatusGuest({ view }: { view: GuestStatusView }) {
    const t = await getTranslations("publicPages");
    const tone = view.state === "up" ? "success" : view.state === "down" ? "danger" : "neutral";
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate" title={view.name}>
                        {view.name}
                    </span>
                    <Badge variant={tone}>{t(`guestStatus.state.${view.state}`)}</Badge>
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>{t(`guestStatus.kind.${view.kind}`)}</p>
                {view.note ? <p>{view.note}</p> : null}
                {view.uptimeSeconds !== null && view.state === "up" ? (
                    <p>
                        {t("guestStatus.upFor", {
                            span: span(view.uptimeSeconds, (key, n) =>
                                t(`guestStatus.units.${key}`, { n })
                            )
                        })}
                    </p>
                ) : null}
                {view.checkedAt ? (
                    <GuestWhen at={view.checkedAt} message="guestStatus.checked" />
                ) : null}
                {view.until ? <GuestWhen at={view.until} message="guestLink.until" /> : null}
                <p className="text-xs">{t("guestStatus.seeOnly")}</p>
            </CardBody>
        </Card>
    );
}
