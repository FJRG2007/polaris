"use client";

/**
 * Recent-files view. Pick a connection and one of three lenses - recently
 * modified, created, or opened - and see the matching files, newest first. The
 * name opens the file; the folder button shows it in its folder in Drive. The
 * lookup runs client-side against /api/drive/recent so switching lens or
 * connection never blocks a navigation.
 */

import Link from "next/link";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState } from "react";
import { formatBytes } from "@polaris/core";
import { recentKey } from "../listing-cache";
import { Card, CardBody, Select, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { Clock, File as FileIcon, FolderOpen } from "lucide-react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

/** How old a remembered answer may be and still be shown while the walk reruns. */
const CACHE_TTL_MS = 60_000;

interface RecentEntry {
    name: string;
    path: string;
    size: string;
    modifiedAt: string;
    createdAt: string;
    openedAt?: string;
}

type Lens = "modified" | "created" | "opened";

const LENSES: { id: Lens; label: NamespaceKey<"drive"> }[] = [
    { id: "modified", label: "recent.lens.modified" },
    { id: "created", label: "recent.lens.created" },
    { id: "opened", label: "recent.lens.opened" }
];

/** Parent folder of a path ("a/b/c.txt" -> "a/b"). */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

export function RecentView({ connections }: { connections: { id: string; name: string }[] }) {
    const t = useTranslations("drive");
    const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
    const [lens, setLens] = useState<Lens>("modified");
    const [entries, setEntries] = useState<RecentEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!connectionId) return;
        const controller = new AbortController();
        // Answering this walks the connection, so a lens switched away from and back
        // paints what it said a moment ago while the walk runs again behind it.
        const key = recentKey(connectionId, lens);
        const cached = readSnapshot<RecentEntry[]>(key, CACHE_TTL_MS)?.value;
        if (cached) setEntries(cached);
        setLoading(!cached);
        setError(null);
        const params = new URLSearchParams({ c: connectionId, by: lens });
        fetch(`/api/drive/recent?${params.toString()}`, { signal: controller.signal })
            .then((res) => res.json())
            .then((body) => {
                if (controller.signal.aborted) return;
                if (body.error) setError(body.error);
                else if (body.locked)
                    setError("This connection is locked. Unlock it in Files first.");
                else if (body.needsSmbShare)
                    setError("Finish setting up this connection in Files first.");
                else {
                    const next = Array.isArray(body.entries) ? (body.entries as RecentEntry[]) : [];
                    setEntries(next);
                    writeSnapshot(key, next);
                }
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
                    {t("recent.addAStorageConnectionIn")}
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
                            {t(entry.label)}
                        </button>
                    ))}
                </div>
                {connections.length > 1 ? (
                    <Select
                        className="h-8 w-48"
                        value={connectionId}
                        onValueChange={setConnectionId}
                        options={connections.map((connection) => ({
                            value: connection.id,
                            label: connection.name
                        }))}
                    />
                ) : null}
            </div>

            <Card>
                <CardBody className="p-0">
                    {loading ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                            {t("recent.loading")}
                        </p>
                    ) : error ? (
                        <p className="p-8 text-center text-sm text-danger">{error}</p>
                    ) : entries.length === 0 ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                            {lens === "opened"
                                ? t("recent.noFilesOpenedHereYet")
                                : t("recent.nothingHereYet")}
                        </p>
                    ) : (
                        <ul>
                            {entries.map((entry) => (
                                <li
                                    key={entry.path}
                                    className="flex items-center gap-3 border-t border-border px-4 py-2.5 transition-colors first:border-t-0 hover:bg-card-hover"
                                >
                                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        {/* The file itself, in its viewer - the row
                                            used to lead only to the folder. */}
                                        <Link
                                            href={`/drive/open?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(entry.path)}`}
                                            className="block truncate text-sm font-medium hover:underline"
                                            title={entry.name}
                                        >
                                            {entry.name}
                                        </Link>
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
                                    <Link
                                        href={`/drive?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(parentOf(entry.path))}`}
                                        aria-label={t("pages.favorites.showInFolder", {
                                            name: entry.name
                                        })}
                                        title={t("pages.favorites.showInFolder", {
                                            name: entry.name
                                        })}
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <FolderOpen className="size-4" />
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
