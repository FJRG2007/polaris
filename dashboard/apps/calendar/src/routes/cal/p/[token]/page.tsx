/**
 * A published calendar's public page: `/cal/p/<token>`. No session - the
 * token is the whole of the right to read it. Only what the link's mode shows
 * reaches the page: its name, colour and description, and the events the
 * range route answers in that mode.
 */

import { notFound } from "next/navigation";
import { host } from "@polaris/app-host";
import { publishedCalendar } from "../../../../lib/sharing";
import { PublicCalendar } from "../../../../screens/public/public-calendar";

export const dynamic = "force-dynamic";

export default async function PublishedCalendarPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { token } = await params;
    const calendar = typeof token === "string" ? await publishedCalendar(token) : null;
    if (!calendar || typeof token !== "string") notFound();
    return (
        <PublicCalendar
            token={token}
            name={calendar.name}
            color={calendar.color}
            description={calendar.publicMode === "full" ? calendar.description : ""}
            mode={calendar.publicMode === "full" ? "full" : "busy"}
            base={await host.domainService.appBaseUrl()}
        />
    );
}
