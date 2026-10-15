/**
 * Webhooks page (/account/webhooks): your own endpoints that Polaris posts the
 * events you pick to, signed, with what was delivered to each - and the deploy
 * hooks that let something outside redeploy one of your services.
 */

import { requireUser } from "@/lib/session";
import { NOTIFICATION_EVENTS } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { WebhooksView, type EventOption } from "./webhooks-view";
import { eventLabel, groupLabel } from "../notifications/event-names";
import { listOutboundHooks } from "@/lib/notifications/outbound-hooks";
import { appBaseUrl } from "@/lib/domain-service";
import { InboundHooksCard } from "./inbound-hooks-card";
import { listInboundHooks, redeployableServices } from "@/lib/deploy/inbound-hooks";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
    const user = await requireUser();
    const t = await getTranslations("accountNotifications");
    const [hooks, inboundHooks, services, baseUrl] = await Promise.all([
        listOutboundHooks(user.id),
        listInboundHooks(user.id),
        redeployableServices(user.id).catch(() => []),
        appBaseUrl().catch(() => "")
    ]);
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
            <InboundHooksCard hooks={inboundHooks} services={services} baseUrl={baseUrl} />
        </div>
    );
}
