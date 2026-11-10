/** Telemetry's issues across every project the reader can see (/telemetry/issues). */

import { IssuesHome } from "../telemetry-view";
import { searchFrom, telemetryScreen } from "../screen";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function TelemetryIssuesPage({
    searchParams
}: {
    searchParams: Promise<{ query?: string; sort?: string }>;
}) {
    const { viewer, mayTask } = await telemetryScreen();
    const { query, sort } = searchFrom(await searchParams);
    const t = await getTranslations("telemetry");
    return (
        <div className="flex w-full min-w-0 flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("page.issuesTitle")}</h1>
                <p className="text-sm text-muted-foreground">{t("page.issuesDescription")}</p>
            </div>
            <IssuesHome query={query} sort={sort} viewer={viewer} mayTask={mayTask} />
        </div>
    );
}
