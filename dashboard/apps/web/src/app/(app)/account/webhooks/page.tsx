/**
 * Webhooks page (/account/webhooks): your own endpoints that Polaris posts the
 * events you pick to, signed, with what was delivered to each.
 */

import { requireUser } from "@/lib/session";
import { NOTIFICATION_EVENTS } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { WebhooksView, type EventOption } from "./webhooks-view";
import { eventLabel, groupLabel } from "../notifications/event-names";
import { listOutboundHooks } from "@/lib/notifications/outbound-hooks";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
    const user = await requireUser();
    const t = await getTranslations("accountNotifications");
    const hooks = await listOutboundHooks(user.id);
    const events: EventOption[] = NOTIFICATION_EVENTS.map((event) => ({
        id: event.id,
        label: eventLabel(t, event.id) ?? event.label,
        group: groupLabel(t, event.group)
    }));

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("webhooks.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("webhooks.page.intro")}</p>
            </div>
            <WebhooksView hooks={hooks} events={events} />
        </div>
    );
}
