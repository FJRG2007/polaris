"use client";

/**
 * Project logs: every service's runtime output, merged.
 *
 * A service's own panel already shows its log; what that cannot answer is "what
 * happened across the environment at 14:02", which is the question worth a screen
 * of its own. Each line names the container that printed it, so a merged view
 * stays readable, and one service can be isolated without leaving the page.
 *
 * Live follows every running service's containers as they print; History
 * searches what was kept over the last week across the same services.
 */

import { Select } from "@polaris/ui";
import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { RuntimeLogs } from "@/components/runtime-logs";

const ALL = "__all__";

/** The most services one live view follows; the stream refuses more. */
const MAX_FOLLOWED = 20;

/** The most services one search covers; the search refuses more. */
const MAX_SEARCHED = 50;

interface ServiceRef {
    id: string;
    name: string;
    running: boolean;
}

export function LogsView({
    environmentName,
    services
}: {
    environmentName: string;
    services: ServiceRef[];
}) {
    const [selected, setSelected] = useState<string>(ALL);

    const watched = useMemo(() => {
        if (selected !== ALL) return services.filter((service) => service.id === selected);
        // A service that is not running has nothing to follow, and asking for it
        // would only return its last lines again every time the follow reopens.
        const running = services.filter((service) => service.running);
        return running.length > 0 ? running : services;
    }, [selected, services]);
    const followed = watched.slice(0, MAX_FOLLOWED);
    const serviceIds = useMemo(() => followed.map((service) => service.id), [followed]);
    // What was kept outlives the container, so history covers stopped services
    // too - that is most of why it is kept.
    const historyIds = useMemo(
        () =>
            (selected === ALL ? services : services.filter((service) => service.id === selected))
                .slice(0, MAX_SEARCHED)
                .map((service) => service.id),
        [selected, services]
    );

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Logs</h1>
                    <p className="text-sm text-muted-foreground">
                        Runtime output across {environmentName}. Build logs live on each deployment.
                    </p>
                </div>
                <Select
                    value={selected}
                    onValueChange={setSelected}
                    options={[
                        { value: ALL, label: `All services (${services.length})` },
                        ...services.map((service) => ({ value: service.id, label: service.name }))
                    ]}
                    className="h-9 w-52"
                    aria-label="Service"
                />
            </div>

            {services.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 px-4 py-16 text-center">
                    <ScrollText className="size-5 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                        No services in this environment to log.
                    </p>
                </div>
            ) : (
                <RuntimeLogs
                    serviceIds={serviceIds}
                    historyIds={historyIds}
                    name={`${environmentName}-logs`}
                    className="h-[calc(100vh-21rem)] min-h-[24rem]"
                    followNote={
                        watched.length > followed.length
                            ? `Showing the first ${MAX_FOLLOWED} services. Pick one to see the rest.`
                            : undefined
                    }
                />
            )}
        </div>
    );
}
