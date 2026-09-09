"use client";

/**
 * Choosing files, from wherever they are.
 *
 * One dialog for every screen in Polaris that accepts a file, because the
 * alternative is what was here before: a bare "choose a file" button on each,
 * and a reader who has the thing they want to attach sitting in their own Drive
 * has to download it and upload it again.
 *
 * The shape is the one everybody already knows - somewhere recent, your own
 * files, the ones other people shared, and your machine - and it hands back
 * where the files ARE rather than their bytes. That distinction is the whole
 * design: attaching something already on this server has to be the server
 * copying it, not a round trip out to the browser and back.
 */

import type { PickedFile } from "./picked-file";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn, Button, Dialog, DialogContent, EmptyState, Input, Select } from "@polaris/ui";
import {
    ArrowLeft,
    Check,
    Clock,
    File as FileIcon,
    Folder,
    HardDrive,
    Link2,
    Loader2,
    Search,
    Upload,
    Users
} from "lucide-react";

/** Where the dialog is looking. */
type Tab = "recent" | "mine" | "shared" | "upload" | "url";

const TABS: readonly { id: Tab; label: string; icon: typeof Clock }[] = [
    { id: "recent", label: "Recent", icon: Clock },
    { id: "mine", label: "My files", icon: HardDrive },
    { id: "shared", label: "Shared with me", icon: Users },
    { id: "upload", label: "Upload", icon: Upload },
    { id: "url", label: "By address", icon: Link2 }
];

/** What a listing row looks like, whichever endpoint answered. */
interface Entry {
    readonly name: string;
    readonly path: string;
    readonly kind: string;
    readonly size: string;
    readonly modifiedAt: string;
}

/** One of the storages this reader can reach. */
interface Source {
    readonly id: string;
    readonly name: string;
    readonly shared: boolean;
    readonly rootPath: string;
}

/** The kinds worth filtering by. Named for what somebody is looking for rather
 *  than for a MIME type, which is not a thing anybody thinks in. */
const KINDS: readonly { id: string; label: string; matches: RegExp }[] = [
    { id: "image", label: "Images", matches: /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i },
    { id: "document", label: "Documents", matches: /\.(?:pdf|docx?|odt|rtf|txt|md|pages)$/i },
    { id: "sheet", label: "Spreadsheets", matches: /\.(?:xlsx?|ods|csv|numbers)$/i },
    { id: "media", label: "Audio and video", matches: /\.(?:mp3|wav|flac|m4a|ogg|mp4|mov|mkv|webm|avi)$/i },
    { id: "archive", label: "Archives", matches: /\.(?:zip|tar|gz|bz2|xz|7z|rar)$/i }
];

export function FilePickerDialog({
    onPick,
    onClose,
    multiple = true,
    title = "Attach a file"
}: {
    onPick: (files: PickedFile[]) => void;
    onClose: () => void;
    multiple?: boolean;
    title?: string;
}) {
    const [tab, setTab] = useState<Tab>("recent");
    const [sources, setSources] = useState<Source[]>([]);
    const [sourceId, setSourceId] = useState("");
    const [path, setPath] = useState("");
    const [entries, setEntries] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(false);
    const [problem, setProblem] = useState("");
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState("");
    const [chosen, setChosen] = useState<Record<string, Entry>>({});
    const [address, setAddress] = useState("");
    const [dragging, setDragging] = useState(false);
    const file = useRef<HTMLInputElement | null>(null);

    // Which answer belongs to the listing on screen. A slow folder must not
    // overwrite the one somebody has since opened.
    const wanted = useRef("");

    useEffect(() => {
        void (async () => {
            try {
                const answer = await fetch("/api/drive/sources", { cache: "no-store" });
                if (!answer.ok) return;
                const body = (await answer.json()) as { sources?: Source[] };
                setSources(body.sources ?? []);
            } catch {
                // No storage reachable. The Upload and address tabs still work,
                // which is the whole of what this dialog has to keep doing.
            }
        })();
    }, []);

    const browsing = tab === "recent" || tab === "mine" || tab === "shared";
    const forTab = useMemo(
        () => sources.filter((one) => (tab === "shared" ? one.shared : !one.shared)),
        [sources, tab]
    );
    const active = sourceId || forTab[0]?.id || "";

    useEffect(() => {
        if (!browsing || !active) {
            if (browsing) setEntries([]);
            return;
        }
        const asked = `${tab}:${active}:${path}:${query}`;
        wanted.current = asked;
        setLoading(true);
        setProblem("");
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const url = query.trim()
                        ? `/api/drive/search?c=${encodeURIComponent(active)}&q=${encodeURIComponent(query.trim())}`
                        : tab === "recent"
                          ? `/api/drive/recent?c=${encodeURIComponent(active)}`
                          : `/api/drive/list?c=${encodeURIComponent(active)}&p=${encodeURIComponent(path)}`;
                    const answer = await fetch(url, { cache: "no-store" });
                    const body = (await answer.json()) as { entries?: Entry[]; error?: string };
                    if (wanted.current !== asked) return;
                    if (body.error) {
                        setProblem("That folder could not be opened.");
                        setEntries([]);
                        return;
                    }
                    setEntries(body.entries ?? []);
                } catch {
                    if (wanted.current === asked) setProblem("That folder could not be opened.");
                } finally {
                    if (wanted.current === asked) setLoading(false);
                }
            })();
            // Typed searches settle; opening a folder does not wait.
        }, query.trim() ? 250 : 0);
        return () => clearTimeout(timer);
    }, [browsing, tab, active, path, query]);

    const shown = useMemo(() => {
        const filter = KINDS.find((one) => one.id === kind);
        return entries.filter((entry) => {
            if (entry.kind === "dir") return !filter;
            return !filter || filter.matches.test(entry.name);
        });
    }, [entries, kind]);

    const toggle = useCallback(
        (entry: Entry) => {
            const key = `${active}:${entry.path}`;
            setChosen((held) => {
                if (held[key]) {
                    const { [key]: _gone, ...rest } = held;
                    return rest;
                }
                return multiple ? { ...held, [key]: entry } : { [key]: entry };
            });
        },
        [active, multiple]
    );

    function done(): void {
        const picks: PickedFile[] = Object.entries(chosen).map(([key, entry]) => ({
            kind: "drive",
            connectionId: key.slice(0, key.indexOf(":")),
            path: entry.path,
            name: entry.name,
            size: Number(entry.size) || 0
        }));
        if (picks.length === 0) return;
        onPick(picks);
        onClose();
    }

    function fromComputer(list: FileList | null): void {
        const files = [...(list ?? [])];
        if (files.length === 0) return;
        onPick((multiple ? files : files.slice(0, 1)).map((one) => ({ kind: "upload", file: one })));
        onClose();
    }

    const picked = Object.keys(chosen).length;

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-3xl">
                <div className="flex h-[30rem] min-h-0 flex-col">
                    <h2 className="mb-3 shrink-0 pr-8 text-[15px] font-semibold tracking-tight">{title}</h2>

                    <div className="flex min-h-0 flex-1 gap-3">
                        <nav className="w-40 shrink-0 space-y-0.5" aria-label="Where to look">
                            {TABS.map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className={cn(
                                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                                        tab === entry.id
                                            ? "bg-card text-foreground"
                                            : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                                    )}
                                    aria-current={tab === entry.id ? "page" : undefined}
                                    onClick={() => {
                                        setTab(entry.id);
                                        setPath("");
                                        setQuery("");
                                        setSourceId("");
                                    }}
                                >
                                    <entry.icon className="size-4 shrink-0" aria-hidden />
                                    {entry.label}
                                </button>
                            ))}
                        </nav>

                        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-md border border-border">
                            {browsing ? (
                                <>
                                    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
                                        {forTab.length > 1 ? (
                                            <Select
                                                value={active}
                                                aria-label="Which storage"
                                                className="h-7 w-40 shrink-0 text-[12px]"
                                                options={forTab.map((one) => ({
                                                    value: one.id,
                                                    label: one.name
                                                }))}
                                                onValueChange={(next) => {
                                                    setSourceId(next);
                                                    setPath("");
                                                }}
                                            />
                                        ) : null}
                                        <div className="relative min-w-0 flex-1">
                                            <Search
                                                className="pointer-events-none absolute left-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2 text-foreground-subtle"
                                                aria-hidden
                                            />
                                            <Input
                                                value={query}
                                                placeholder="Search these files"
                                                aria-label="Search these files"
                                                className="h-7 pl-7 text-[12px]"
                                                onChange={(event) => setQuery(event.target.value)}
                                            />
                                        </div>
                                        <Select
                                            value={kind}
                                            aria-label="Only show"
                                            className="h-7 w-36 shrink-0 text-[12px]"
                                            options={[
                                                { value: "", label: "Everything" },
                                                ...KINDS.map((one) => ({ value: one.id, label: one.label }))
                                            ]}
                                            onValueChange={setKind}
                                        />
                                    </div>

                                    {path && tab === "mine" && !query.trim() ? (
                                        <button
                                            type="button"
                                            className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
                                            onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
                                        >
                                            <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                                            {path}
                                        </button>
                                    ) : null}

                                    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
                                        {loading ? (
                                            <li className="flex items-center justify-center py-8 text-muted-foreground">
                                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                            </li>
                                        ) : shown.length === 0 ? (
                                            <li className="p-6">
                                                <EmptyState
                                                    icon={<Folder className="size-5 shrink-0" aria-hidden />}
                                                    title={problem || "Nothing here"}
                                                    description={
                                                        problem
                                                            ? "Try another storage, or upload from this machine."
                                                            : "Nothing in this folder matches what you are looking for."
                                                    }
                                                />
                                            </li>
                                        ) : (
                                            shown.map((entry) => {
                                                const key = `${active}:${entry.path}`;
                                                const isDir = entry.kind === "dir";
                                                return (
                                                    <li key={key}>
                                                        <button
                                                            type="button"
                                                            className={cn(
                                                                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]",
                                                                chosen[key]
                                                                    ? "bg-card text-foreground"
                                                                    : "hover:bg-card/60"
                                                            )}
                                                            onDoubleClick={() => {
                                                                if (isDir) setPath(entry.path);
                                                            }}
                                                            onClick={() => {
                                                                if (isDir) {
                                                                    setPath(entry.path);
                                                                    setQuery("");
                                                                    return;
                                                                }
                                                                toggle(entry);
                                                            }}
                                                        >
                                                            {isDir ? (
                                                                <Folder
                                                                    className="size-4 shrink-0 text-foreground-subtle"
                                                                    aria-hidden
                                                                />
                                                            ) : (
                                                                <FileIcon
                                                                    className="size-4 shrink-0 text-foreground-subtle"
                                                                    aria-hidden
                                                                />
                                                            )}
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {entry.name}
                                                            </span>
                                                            {isDir ? null : (
                                                                <span className="shrink-0 text-[11px] text-foreground-subtle">
                                                                    {readableSize(Number(entry.size) || 0)}
                                                                </span>
                                                            )}
                                                            {chosen[key] ? (
                                                                <Check
                                                                    className="size-3.5 shrink-0 text-primary"
                                                                    aria-hidden
                                                                />
                                                            ) : null}
                                                        </button>
                                                    </li>
                                                );
                                            })
                                        )}
                                    </ul>
                                </>
                            ) : tab === "upload" ? (
                                <div
                                    className={cn(
                                        "m-3 flex flex-1 flex-col items-center justify-center rounded-md border border-dashed p-6 text-center",
                                        dragging ? "border-primary bg-card" : "border-border"
                                    )}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        setDragging(true);
                                    }}
                                    onDragLeave={() => setDragging(false)}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        setDragging(false);
                                        fromComputer(event.dataTransfer.files);
                                    }}
                                >
                                    <Upload className="size-6 shrink-0 text-foreground-subtle" aria-hidden />
                                    <p className="mt-2 text-[13px] text-muted-foreground">
                                        Drop files here, or choose them from this machine.
                                    </p>
                                    <input
                                        ref={file}
                                        type="file"
                                        multiple={multiple}
                                        className="hidden"
                                        onChange={(event) => fromComputer(event.target.files)}
                                    />
                                    <Button className="mt-3" onClick={() => file.current?.click()}>
                                        Choose files
                                    </Button>
                                </div>
                            ) : (
                                <div className="m-3 flex-1">
                                    <label className="block">
                                        <span className="mb-1 block text-[12px] text-muted-foreground">
                                            Address of the file
                                        </span>
                                        <Input
                                            value={address}
                                            placeholder="https://example.com/report.pdf"
                                            aria-label="Address of the file"
                                            onChange={(event) => setAddress(event.target.value)}
                                        />
                                    </label>
                                    <p className="mt-1 text-[12px] text-foreground-subtle">
                                        Polaris fetches it, not your browser, so the site it comes from learns
                                        nothing about you.
                                    </p>
                                    <Button
                                        className="mt-3"
                                        disabled={!/^https?:\/\/\S+$/i.test(address.trim())}
                                        onClick={() => {
                                            onPick([{ kind: "url", url: address.trim() }]);
                                            onClose();
                                        }}
                                    >
                                        Attach it
                                    </Button>
                                </div>
                            )}
                        </div>
                    </div>

                    {browsing ? (
                        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
                            <span className="text-[12px] text-muted-foreground">
                                {picked === 0
                                    ? "Nothing chosen"
                                    : `${picked} ${picked === 1 ? "file" : "files"} chosen`}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button variant="ghost" onClick={onClose}>
                                    Cancel
                                </Button>
                                <Button disabled={picked === 0} onClick={done}>
                                    Attach
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** A file size somebody can read. Not a locale format: the units are the same
 *  everywhere and the number is deliberately coarse. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
