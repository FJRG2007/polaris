/**
 * One telemetry project (/telemetry/<project>[/<section>[/<id>]]): its issues,
 * an issue, its event stream, an event, its releases, and its setup.
 */

import { TelemetryView } from "../../telemetry-view";
import { sectionFor } from "../../project-sections";
import { searchFrom, telemetryScreen } from "../../screen";

export const dynamic = "force-dynamic";

export default async function TelemetryProjectPage({
    params,
    searchParams
}: {
    params: Promise<{ project: string; rest?: string[] }>;
    searchParams: Promise<{ query?: string; sort?: string }>;
}) {
    const { viewer, mayTask } = await telemetryScreen();
    const { project, rest = [] } = await params;
    const { query, sort } = searchFrom(await searchParams);
    return (
        <div className="flex w-full min-w-0 flex-col gap-4">
            <TelemetryView
                projectId={decodeURIComponent(project)}
                section={sectionFor(rest[0])}
                itemId={rest[1] ? decodeURIComponent(rest[1]) : null}
                query={query}
                sort={sort}
                viewer={viewer}
                mayTask={mayTask}
            />
        </div>
    );
}
