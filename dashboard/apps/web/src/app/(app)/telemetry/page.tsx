/**
 * Telemetry (/telemetry): every project this account reports into or was
 * lent, a page at a time.
 *
 * What broke, in the applications deployed here and in Polaris itself. Beside
 * Analytics and the firewall because it answers the third question about the
 * same things, and it is reached with the same permission for the same reason.
 *
 * Links from before each section had its own address (`?project=&issue=&section=`)
 * are sent on to where that screen lives now.
 */

import { redirect } from "next/navigation";
import { ProjectsHome } from "./telemetry-view";
import { projectHref } from "./paths";
import { sectionFor } from "./project-sections";
import { telemetryScreen } from "./screen";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function TelemetryPage({
    searchParams
}: {
    searchParams: Promise<{ project?: string; issue?: string; section?: string }>;
}) {
    const { manages } = await telemetryScreen();
    const { project, issue, section } = await searchParams;
    if (project) {
        redirect(
            issue
                ? projectHref(project, "issues", issue)
                : projectHref(project, sectionFor(section))
        );
    }
    const t = await getTranslations("telemetry");
    return (
        <div className="flex w-full min-w-0 flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("page.description")}</p>
            </div>
            <ProjectsHome mayCreate={manages} />
        </div>
    );
}
