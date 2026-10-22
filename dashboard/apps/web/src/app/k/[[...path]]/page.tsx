/**
 * Something in Places handed out as a link, for somebody with no account.
 *
 * No session: the token in the address is the whole of the right, and every
 * bound on it - dates, hours, uses, which actions, only near the place - is
 * judged on the server for each press (`lib/access/grants` `linkReach`). A
 * door and a camera are Places' to draw, so their page comes from the app's
 * bundle; a UPS, a NAS, a server and a domain are core's and drawn here. A link that opens nothing says why in one sentence
 * and nothing about what it was.
 */

import "@/lib/app-host/server";
import type { Metadata } from "next";
import { UpsGuest } from "./ups-guest";
import { StatusGuest } from "./status-guest";
import { notFound } from "next/navigation";
import { linkReach } from "@/lib/access/grants";
import { upsGuestView } from "@/lib/ups/ups-guest";
import { guestStatusView } from "@/lib/access/guest-status";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { LinkUnavailable, PublicShell } from "@/components/public-shell";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function GuestLinkPage(props: AppPageProps) {
    const { path = [] } = await props.params;
    if (path.length !== 1) notFound();
    const token = String(path[0]);
    const [reached, words] = await Promise.all([linkReach(token), getTranslations("publicPages")]);
    if (!reached) return <LinkUnavailable message={words("guestLink.gone")} />;
    if (reached.standing !== "live") {
        return <LinkUnavailable message={words(`guestLink.standing.${reached.standing}`)} />;
    }
    if (
        reached.subjectType === "place.device" ||
        reached.subjectType === "place.camera" ||
        reached.subjectType === "place.room"
    ) {
        return (
            <PublicShell>
                <Messages namespaces={["publicPages"]}>
                    {await renderAppPage("/k", "home", props, { public: true })}
                </Messages>
            </PublicShell>
        );
    }
    if (reached.subjectType === "place.ups") {
        const view = await upsGuestView(token);
        if (!view) return <LinkUnavailable message={words("guestLink.gone")} />;
        return (
            <PublicShell>
                <Messages namespaces={["servers", "publicPages"]}>
                    <UpsGuest token={token} initial={view} />
                </Messages>
            </PublicShell>
        );
    }
    if (
        reached.subjectType === "place.nas" ||
        reached.subjectType === "place.server" ||
        reached.subjectType === "place.domain"
    ) {
        const view = await guestStatusView(token);
        if (!view) return <LinkUnavailable message={words("guestLink.gone")} />;
        return (
            <PublicShell>
                <StatusGuest view={view} />
            </PublicShell>
        );
    }
    return <LinkUnavailable message={words("guestLink.gone")} />;
}
