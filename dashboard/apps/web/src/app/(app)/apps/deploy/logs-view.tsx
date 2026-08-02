"use client";

/**
 * Project logs: every service's runtime output, merged.
 *
 * A service's own panel already shows its log; what that cannot answer is "what
 * happened across the environment at 14:02", which is the question worth a screen
 * of its own. Each line is prefixed with the service that printed it, so a merged
 * view stays readable, and one service can be isolated without leaving the page.
 *
 * Polled rather than streamed. The runtime log is read on demand from the
 * container, so a socket per service would cost far more than a periodic read of
 * the tail - and the tail is what anyone actually looks at.
 */

import { Button, Select } from "@polaris/ui";
import { LogViewer } from "@/components/log-viewer";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Play, ScrollText } from "lucide-react";

const ALL = "__all__";
const POLL_MS = 4000;
const TAIL = 300;

interface ServiceRef {
    id: string;
    name: string;
    running: boolean;
}

/** One service's tail, prefixed so a merged view says who said what. */
function prefixLines(name: string, log: string): string[] {
    return log
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `[${name}] ${line}`);
}

export function LogsView({ environmentName, services }: { environmentName: string; services: ServiceRef[] }) {
    const [selected, setSelected] = useState<string>(ALL);
    const [log, setLog] = useState<string | null>(null);
    const [live, setLive] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const liveRef = useRef(live);
    liveRef.current = live;

    const watched = useMemo(
        () => (selected === ALL ? services : services.filter((service) => service.id === selected)),
        [selected, services]
    );

    useEffect(() => {
        if (watched.length === 0) {
            setLog("");
            return;
        }
        let active = true;
        let timer: ReturnType<typeof setTimeout>;

        async function poll(): Promise<void> {
            // A backgrounded tab is not being read, so it does not need the data.
            if ((typeof document !== "undefined" && document.hidden) || !liveRef.current) {
                timer = setTimeout(poll, POLL_MS);
                return;
            }
            try {
                const results = await Promise.all(
                    watched.map(async (service) => {
                        const res = await fetch(`/api/deploy/apps/${service.id}/logs?tail=${TAIL}`, {
                            cache: "no-store"
                        });
                        if (!res.ok) return [];
                        const data = (await res.json()) as { log?: string };
                        // A single service reads better without its own name on
                        // every line; a merged view needs it on all of them.
                        return watched.length === 1
                            ? (data.log ?? "").split("\n").filter((line) => line.length > 0)
                            : prefixLines(service.name, data.log ?? "");
                    })
                );
                if (!active) return;
                setLog(results.flat().join("\n"));
                setError(null);
            } catch {
                if (active) setError("Could not read the logs");
            }
            if (active) timer = setTimeout(poll, POLL_MS);
        }

        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [watched]);

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold">Logs</h1>
                    <p className="text-sm text-muted-foreground">
                        Runtime output across {environmentName}. Build logs live on each deployment.
                    </p>
                </div>
                <div className="flex items-center gap-2">
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
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setLive((value) => !value)}
                        aria-label={live ? "Pause updates" : "Resume updates"}
                        title={live ? "Pause" : "Resume"}
                    >
                        {live ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                </div>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {services.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 px-4 py-16 text-center">
                    <ScrollText className="size-5 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No services in this environment to log.</p>
                </div>
            ) : log === null ? (
                <div className="flex items-center justify-center rounded-lg border border-border/60 py-16 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            ) : (
                <>
                    {live && (
                        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs text-success">
                            <span className="size-1.5 animate-pulse rounded-full bg-success" /> Live
                        </span>
                    )}
                    <LogViewer
                        log={log || "Nothing has been printed yet."}
                        name={`${environmentName}-logs`}
                        searchable
                        className="h-[calc(100vh-19rem)] min-h-[24rem]"
                    />
                </>
            )}
        </div>
    );
}
