"use client";

/**
 * Everything about one container, in the dialog that opens from its row:
 * details, logs, a file browser, and an interactive console. Each tab loads only
 * when it is opened - a console is a live session and logs can be long, so
 * neither is paid for by someone who wanted to read the port mapping.
 *
 * The console is the same panel the Deploy app uses; only the ticket differs,
 * which is what keeps one terminal implementation in the product.
 */

import type { ContainerRow } from "./types";
import { useCallback, useEffect, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { TerminalPanel } from "@/app/(app)/apps/deploy/terminal-panel";
import { ChevronRight, Download, FileText, Folder, RefreshCw, TerminalSquare } from "lucide-react";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton, cn } from "@polaris/ui";

type Tab = "details" | "logs" | "files" | "console";

interface ContainerDetail {
    id: string;
    name: string;
    image: string;
    state: string;
    createdAt: string;
    startedAt: string | null;
    restartCount: number;
    command: string;
    ports: Array<{ container: string; host: string | null }>;
    mounts: Array<{ source: string; destination: string; rw: boolean }>;
    networks: string[];
    env: string[];
    composeProject: string | null;
}

interface FileEntry {
    name: string;
    isDir: boolean;
}

const TABS: Array<{ id: Tab; label: string }> = [
    { id: "details", label: "Details" },
    { id: "logs", label: "Logs" },
    { id: "files", label: "Files" },
    { id: "console", label: "Console" }
];

export function ContainerPanel({
    connectionId,
    container,
    initialTab,
    canAttach,
    onClose
}: {
    connectionId: string;
    container: ContainerRow;
    initialTab: Tab;
    canAttach: boolean;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<Tab>(initialTab);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-0 p-0">
                <DialogHeader className="border-b border-border px-4 py-3">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <span className="truncate">{container.name}</span>
                        <Badge variant={container.state === "running" ? "success" : "neutral"}>
                            {container.state}
                        </Badge>
                    </DialogTitle>
                    <nav className="mt-2 flex gap-1" role="tablist">
                        {TABS.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                role="tab"
                                aria-selected={tab === entry.id}
                                onClick={() => setTab(entry.id)}
                                className={cn(
                                    "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted",
                                    tab === entry.id ? "bg-muted font-medium" : "text-muted-foreground"
                                )}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </nav>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {tab === "details" ? <DetailsTab connectionId={connectionId} container={container} /> : null}
                    {tab === "logs" ? <LogsTab connectionId={connectionId} container={container} /> : null}
                    {tab === "files" ? <FilesTab connectionId={connectionId} container={container} /> : null}
                    {tab === "console" ? (
                        <ConsoleTab connectionId={connectionId} container={container} canAttach={canAttach} />
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function DetailsTab({ connectionId, container }: { connectionId: string; container: ContainerRow }) {
    const format = useDisplayFormat();
    const [detail, setDetail] = useState<ContainerDetail | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await fetchJson<{ detail: ContainerDetail }>(
                `/api/containers/inspect?c=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(container.id)}`
            );
            if (cancelled) return;
            if (!result.ok) setError(result.error);
            else setDetail(result.data.detail);
        })();
        return () => {
            cancelled = true;
        };
    }, [connectionId, container.id]);

    if (error) return <Notice tone="danger">{error}</Notice>;
    if (!detail) {
        return (
            <div className="space-y-2">
                {[0, 1, 2, 3, 4, 5].map((row) => (
                    <Skeleton key={row} className="h-5 w-full" />
                ))}
            </div>
        );
    }

    return (
        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <Field label="Image">{detail.image}</Field>
            <Field label="Command">
                <code className="break-all text-xs">{detail.command || "-"}</code>
            </Field>
            <Field label="Created">{format.dateTime(detail.createdAt)}</Field>
            <Field label="Started">{detail.startedAt ? format.dateTime(detail.startedAt) : "-"}</Field>
            <Field label="Restarts">{detail.restartCount}</Field>
            {detail.composeProject ? <Field label="Compose project">{detail.composeProject}</Field> : null}
            <Field label="Ports">
                {detail.ports.length === 0
                    ? "None published"
                    : detail.ports.map((port) => (
                          <div key={port.container}>
                              {port.host ? `${port.host} -> ` : ""}
                              {port.container}
                          </div>
                      ))}
            </Field>
            <Field label="Mounts">
                {detail.mounts.length === 0
                    ? "None"
                    : detail.mounts.map((mount) => (
                          <div key={mount.destination} className="break-all text-xs">
                              {mount.source} -&gt; {mount.destination} ({mount.rw ? "rw" : "ro"})
                          </div>
                      ))}
            </Field>
            <Field label="Networks">{detail.networks.join(", ") || "-"}</Field>
            <Field label="Environment">
                {detail.env.length === 0 ? (
                    "None"
                ) : (
                    <>
                        <span className="text-xs text-muted-foreground">Names only; values are never read.</span>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {detail.env.map((name) => (
                                <Badge key={name} variant="neutral">
                                    {name}
                                </Badge>
                            ))}
                        </div>
                    </>
                )}
            </Field>
        </dl>
    );
}

function LogsTab({ connectionId, container }: { connectionId: string; container: ContainerRow }) {
    const [logs, setLogs] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tail, setTail] = useState(200);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (lines: number) => {
            setLoading(true);
            const result = await fetchJson<{ logs: string }>(
                `/api/containers/logs?c=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(container.id)}&tail=${lines}`
            );
            setLoading(false);
            if (!result.ok) setError(result.error);
            else {
                setError(null);
                setLogs(result.data.logs);
            }
        },
        [connectionId, container.id]
    );

    useEffect(() => {
        void load(tail);
    }, [load, tail]);

    return (
        <div className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Last {tail} lines</span>
                <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setTail(tail >= 2000 ? 200 : tail * 5)}>
                        {tail >= 2000 ? "Show fewer" : "Show more"}
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => void load(tail)}
                        disabled={loading}
                        aria-label="Refresh logs"
                        title="Refresh logs"
                    >
                        <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                    </Button>
                </div>
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {logs === null && !error ? (
                <Skeleton className="h-64 w-full" />
            ) : (
                <pre className="min-h-0 flex-1 overflow-auto rounded-md bg-[#0b0e14] p-3 text-xs leading-relaxed text-[#c9d1d9]">
                    {logs?.trim() ? logs : "This container has printed nothing."}
                </pre>
            )}
        </div>
    );
}

function FilesTab({ connectionId, container }: { connectionId: string; container: ContainerRow }) {
    const [path, setPath] = useState("/");
    const [entries, setEntries] = useState<FileEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        void (async () => {
            const result = await fetchJson<{ entries: FileEntry[] }>(
                `/api/containers/files?c=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(container.id)}&p=${encodeURIComponent(path)}`
            );
            if (cancelled) return;
            if (!result.ok) {
                setError(result.error);
                setEntries([]);
            } else {
                setError(null);
                setEntries(result.data.entries);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [connectionId, container.id, path]);

    const segments = path.split("/").filter(Boolean);

    return (
        <div className="flex h-full flex-col gap-2">
            <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Breadcrumb">
                <button type="button" className="hover:underline" onClick={() => setPath("/")}>
                    /
                </button>
                {segments.map((segment, index) => (
                    <span key={`${segment}-${index}`} className="flex items-center gap-1">
                        <ChevronRight className="size-3 text-muted-foreground" />
                        <button
                            type="button"
                            className="hover:underline"
                            onClick={() => setPath(`/${segments.slice(0, index + 1).join("/")}`)}
                        >
                            {segment}
                        </button>
                    </span>
                ))}
            </nav>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {entries === null ? (
                <div className="space-y-1">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
                        <Skeleton key={row} className="h-8 w-full" />
                    ))}
                </div>
            ) : entries.length === 0 && !error ? (
                <p className="py-8 text-center text-sm text-muted-foreground">This directory is empty.</p>
            ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
                    {entries.map((entry) => {
                        const full = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
                        return (
                            <li
                                key={entry.name}
                                className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0 hover:bg-card-hover"
                            >
                                {entry.isDir ? (
                                    <>
                                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                                        <button
                                            type="button"
                                            className="flex-1 truncate text-left hover:underline"
                                            onClick={() => setPath(full)}
                                        >
                                            {entry.name}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="flex-1 truncate">{entry.name}</span>
                                        <a
                                            href={`/api/containers/file?c=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(container.id)}&p=${encodeURIComponent(full)}`}
                                            aria-label={`Download ${entry.name}`}
                                            title={`Download ${entry.name}`}
                                            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                        >
                                            <Download className="size-4" />
                                        </a>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function ConsoleTab({
    connectionId,
    container,
    canAttach
}: {
    connectionId: string;
    container: ContainerRow;
    canAttach: boolean;
}) {
    if (container.state !== "running") {
        return (
            <Notice tone="muted">
                <TerminalSquare className="mb-2 size-5" />
                Start this container to open a console in it.
            </Notice>
        );
    }
    if (!canAttach) {
        return (
            <Notice tone="muted">
                This host does not offer an interactive session. Its engine is reached through the host daemon,
                which brokers one bounded call at a time.
            </Notice>
        );
    }
    return (
        <TerminalPanel
            target={{ kind: "docker", connectionId, containerRef: container.id }}
            label={`${container.name} - /bin/sh`}
        />
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </>
    );
}

function Notice({ tone, children }: { tone: "danger" | "muted"; children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "rounded-md border p-3 text-sm",
                tone === "danger"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-border bg-card text-muted-foreground"
            )}
        >
            {children}
        </div>
    );
}

/** Fetch JSON and normalize both a transport failure and an `{ error }` body
 *  into one shape, so every caller handles failure the same way. */
async function fetchJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
        const response = await fetch(url);
        const payload = (await response.json()) as T & { error?: string };
        if (!response.ok || payload.error) {
            return { ok: false, error: payload.error ?? `Request failed (${response.status})` };
        }
        return { ok: true, data: payload };
    } catch {
        return { ok: false, error: "Could not reach Polaris" };
    }
}
