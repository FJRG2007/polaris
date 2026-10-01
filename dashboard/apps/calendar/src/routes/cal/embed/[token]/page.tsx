/**
 * A published calendar for another web page to frame: `/cal/embed/<token>`.
 * The grid and its own buttons, nothing around them. Same rules as the public
 * page: the token is the right, and the link's mode decides what is shown.
 */

import { notFound } from "next/navigation";
import { host } from "@polaris/app-host";
import { publishedCalendar } from "../../../../lib/sharing";
import { PublicCalendar } from "../../../../screens/public/public-calendar";

export const dynamic = "force-dynamic";

export default async function EmbeddedCalendarPage({ params }: { params: Promise<Record<string, string | string[]>> }) {
    const { token } = await params;
    const calendar = typeof token === "string" ? await publishedCalendar(token) : null;
    if (!calendar || typeof token !== "string") notFound();
    return (
        <PublicCalendar
            token={token}
            name={calendar.name}
            color={calendar.color}
            description=""
            mode={calendar.publicMode === "full" ? "full" : "busy"}
            base={await host.domainService.appBaseUrl()}
            embed
        />
    );
}
