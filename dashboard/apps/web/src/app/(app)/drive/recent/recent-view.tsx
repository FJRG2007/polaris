"use client";

/**
 * Recent-files view. Pick a connection and one of three lenses - recently
 * modified, created, or opened - and see the matching files, newest first. Each
 * row links to the file's folder in Drive. The lookup runs client-side against
 * /api/drive/recent so switching lens or connection never blocks a navigation.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, File as FileIcon, FolderOpen } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Card, CardBody, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";

interface RecentEntry {
    name: string;
    path: string;
    size: string;
    modifiedAt: string;
    createdAt: string;
    openedAt?: string;
}

type Lens = "modified" | "created" | "opened";

const LENSES: { id: Lens; label: string }[] = [
    { id: "modified", label: "Modified" },
    { id: "created", label: "Created" },
    { id: "opened", label: "Opened" }
];

/** Parent folder of a path ("a/b/c.txt" -> "a/b"). */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

export function RecentView({ connections }: { connections: { id: string; name: string }[] }) {
    const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
    const [lens, setLens] = useState<Lens>("modified");
    const [entries, setEntries] = useState<RecentEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!connectionId) return;
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        const params = new URLSearchParams({ c: connectionId, by: lens });
        fetch(`/api/drive/recent?${params.toString()}`, { signal: controller.signal })
            .then((res) => res.json())
            .then((body) => {
                if (controller.signal.aborted) return;
                if (body.error) setError(body.error);
                else if (body.locked) setError("This connection is locked. Unlock it in Files first.");
                else if (body.needsSmbShare) setError("Finish setting up this connection in Files first.");
                else setEntries(Array.isArray(body.entries) ? body.entries : []);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError("Could not load recent files.");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [connectionId, lens]);

    function whenOf(entry: RecentEntry): string {
        if (lens === "created") return entry.createdAt;
        if (lens === "opened") return entry.openedAt ?? entry.modifiedAt;
        return entry.modifiedAt;
    }

    if (connections.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    Add a storage connection in Files to see recent activity.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    {LENSES.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            onClick={() => setLens(entry.id)}
                            className={cn(
                                "rounded px-3 py-1 text-xs transition-colors hover:bg-muted",
                                lens === entry.id ? "bg-muted font-medium" : "text-muted-foreground"
                            )}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
                {connections.length > 1 ? (
                    <select
                        value={connectionId}
                        onChange={(event) => setConnectionId(event.target.value)}
                        className="h-8 rounded-md border border-input bg-surface px-2 text-sm"
                    >
                        {connections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                                {connection.name}
                            </option>
                        ))}
                    </select>
                ) : null}
            </div>

            <Card>
                <CardBody className="p-0">
                    {loading ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">Loading...</p>
                    ) : error ? (
                        <p className="p-8 text-center text-sm text-danger">{error}</p>
                    ) : entries.length === 0 ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                            {lens === "opened"
                                ? "No files opened here yet."
                                : "Nothing here yet."}
                        </p>
                    ) : (
                        <ul>
                            {entries.map((entry) => (
                                <li key={entry.path} className="border-t border-border first:border-t-0">
                                    <Link
                                        href={`/drive?c=${connectionId}&p=${encodeURIComponent(parentOf(entry.path))}`}
                                        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-card-hover"
                                    >
                                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">{entry.name}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                /{parentOf(entry.path) || ""}
                                            </p>
                                        </div>
                                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                                            {formatBytes(BigInt(entry.size))}
                                        </span>
                                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                            <Clock className="size-3" />
                                            <RelativeTime iso={whenOf(entry)} />
                                        </span>
                                        <FolderOpen className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
