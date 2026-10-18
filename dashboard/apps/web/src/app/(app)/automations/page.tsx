/**
 * The automations on the open shelf (/automations). The shell paints at once;
 * the list is fetched by the client and only its own region waits.
 *
 * `?app=<id>` narrows it to what one app made, and `&ref=<id>` to one thing of
 * that app (a place). The filter shows as chips that each take it off, and the
 * app draws its own ways to start one beside the list.
 */

import * as core from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { redirect } from "next/navigation";
import { FilterChips } from "./filter-chips";
import { getTranslations } from "@/lib/i18n/request";
import { AutomationsList } from "./automations-list";
import { appAutomationsFilter } from "@/lib/app-extensions/registry";
import { AppSlotView } from "@/components/app-extensions/installed-client";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function AutomationsPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const t = await getTranslations("automations");
    const query = await searchParams;
    const asked = one(query.app);
    const parsed = asked
        ? core.automationsListFilterSchema.safeParse({ app: asked, ref: one(query.ref) })
        : null;
    // A filter that names nothing this viewer can see is dropped, not shown empty.
    if (parsed && !parsed.success) redirect(core.AUTOMATIONS_LIST_PATH);
    const filter = parsed?.success ? parsed.data : null;
    const app = filter ? await appAutomationsFilter(filter.app, filter.ref) : null;
    if (filter && !app) redirect(core.AUTOMATIONS_LIST_PATH);
    if (filter?.ref && app && !app.refName) redirect(core.automationsListHref(filter.app));

    return (
        <div className="mx-auto w-full max-w-4xl">
            <PageHeader title={t("title")} description={t("description")} />
            {filter && app ? (
                <FilterChips
                    app={{ name: app.name, clear: core.AUTOMATIONS_LIST_PATH }}
                    item={
                        filter.ref && app.refName
                            ? { name: app.refName, clear: core.automationsListHref(filter.app) }
                            : null
                    }
                />
            ) : null}
            <AutomationsList
                key={filter ? `${filter.app}.${filter.ref ?? ""}` : "all"}
                from={filter ? { origin: filter.app, originRef: filter.ref } : undefined}
                actions={app?.actions ? <AppSlotView slot={app.actions} /> : undefined}
                after={app?.after ? <AppSlotView slot={app.after} /> : undefined}
            />
        </div>
    );
}
