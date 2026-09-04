/**
 * Telemetry (/apps/telemetry).
 *
 * What broke, in the applications deployed here and in Polaris itself. Beside
 * Analytics and the firewall because it answers the third question about the
 * same things - who came, who was turned away, and what fell over - and it is
 * reached with the same permission for the same reason.
 *
 * The shell renders immediately and the list arrives into it: which project and
 * which filter change constantly, and holding the page back for a read every
 * time somebody clicks a tab is a blank page every time somebody clicks a tab.
 */

import { TelemetryView } from "./telemetry-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TelemetryPage({
    searchParams
}: {
    searchParams: Promise<{ project?: string; issue?: string; status?: string }>;
}) {
    await requirePermission("deploy.manage");
    const { project, issue, status } = await searchParams;

    return (
        <div className="flex w-full flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Telemetry</h1>
                <p className="text-sm text-muted-foreground">
                    What your applications report when they break, and what Polaris reports about
                    itself. Point any Sentry client at the address below.
                </p>
            </div>
            <TelemetryView
                projectId={project ?? null}
                issueId={issue ?? null}
                status={status ?? "unresolved"}
            />
        </div>
    );
}
