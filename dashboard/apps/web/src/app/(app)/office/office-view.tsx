"use client";

/**
 * Everything somebody has made, and the way to make another.
 *
 * The list is fetched by the browser rather than rendered into the page, the
 * same arrangement Mail settled on and for the same reason: the heading, the
 * "New" button and the filters are on screen before anything has been asked
 * for, and a shelf that has been looked at once paints from what this tab kept.
 *
 * Rows rather than a grid of thumbnails. A thumbnail of a document is a picture
 * of a page of text, which tells nobody anything; what people actually pick a
 * document out of a list by is its name, when it was touched and who touched it.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { RelativeTime } from "@/components/relative-time";
import type { OfficeDocumentView } from "@/lib/office/documents";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Columns3,
    FileText,
    Loader2,
    Plus,
    Presentation,
    Search,
    Star,
    Table2,
    Trash2,
    Undo2,
    Users,
    Workflow
} from "lucide-react";
import {
    archiveDocumentAction,
    createDocumentAction,
    deleteDocumentAction,
    listDocumentsAction,
    ownerOptionsAction,
    starDocumentAction,
    trashDocumentAction
} from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    PageHeader,
    ScrollRow,
    Select,
    Skeleton,
    cn,
    useToast
} from "@polaris/ui";

/** The mark each kind is recognised by, before its name is read. */
const KIND_ICONS: Record<core.OfficeKind, typeof FileText> = {
    doc: FileText,
    sheet: Table2,
    slides: Presentation,
    diagram: Workflow,
    comparison: Columns3
};

/** The colour each kind carries, which is the whole of how a list of five kinds
 *  is scanned. Deliberately the same five everywhere they appear. */
const KIND_TONES: Record<core.OfficeKind, string> = {
    doc: "text-info",
    sheet: "text-success",
    slides: "text-warning",
    diagram: "text-primary",
    comparison: "text-foreground-subtle"
};

export interface OfficeViewProps {
    /** What this screen is: a shelf, one kind, or what somebody was given. */
    readonly shelf: "live" | "archived" | "trashed";
    readonly kind: core.OfficeKind | "";
    readonly starredOnly: boolean;
    readonly sharedOnly: boolean;
    readonly title: string;
    readonly description: string;
}

export function OfficeView({
    shelf,
    kind,
    starredOnly,
    sharedOnly,
    title,
    description
}: OfficeViewProps) {
    const router = useRouter();
    const toast = useToast();
    const [documents, setDocuments] = useState<OfficeDocumentView[] | null>(null);
    const [sort, setSort] = useState<core.OfficeSort>(core.DEFAULT_OFFICE_SORT);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [making, setMaking] = useState<core.OfficeKind | null>(null);

    const load = useCallback(async () => {
        const answer = await listDocumentsAction({ shelf, kind, starredOnly, sort, query });
        if (answer.error) {
            toast.show({ title: answer.error });
            setDocuments([]);
            return;
        }
        setDocuments(answer.documents ?? []);
    }, [shelf, kind, starredOnly, sort, query, toast]);

    // Searched as they type, after a beat. A query per keystroke is a round trip
    // per letter, and the answer to "in" is not worth one.
    useEffect(() => {
        const timer = setTimeout(() => void load(), query ? 250 : 0);
        return () => clearTimeout(timer);
    }, [load, query]);

    const shown = useMemo(
        () => (documents ?? []).filter((row) => !sharedOnly || row.shared),
        [documents, sharedOnly]
    );

    const act = async (run: () => Promise<{ error?: string }>, said: string): Promise<void> => {
        setBusy(true);
        const answer = await run();
        setBusy(false);
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: said });
        await load();
    };

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={title} description={description} />
                {shelf === "live" ? <NewButton onPick={setMaking} /> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search
                        className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-foreground-subtle"
                        aria-hidden
                    />
                    <Input
                        className="pl-8"
                        value={query}
                        placeholder="Search by name"
                        aria-label="Search documents"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="w-48"
                    aria-label="How to order these"
                    value={sort}
                    onValueChange={(next) => setSort(core.readOfficeSort(next))}
                    options={core.OFFICE_SORTS.map((one) => ({
                        value: one,
                        label: core.OFFICE_SORT_LABELS[one]
                    }))}
                />
            </div>

            {documents === null ? (
                <ul className="flex flex-col gap-1" aria-hidden>
                    {[0, 1, 2, 3, 4, 5].map((row) => (
                        <li
                            key={row}
                            className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                        >
                            <Skeleton className="size-8 shrink-0 rounded-md" />
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <Skeleton className="h-3.5 w-1/3" />
                                <Skeleton className="h-3 w-1/2" />
                            </div>
                            <Skeleton className="h-3 w-16 shrink-0" />
                        </li>
                    ))}
                </ul>
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={<FileText className="size-5 shrink-0" aria-hidden />}
                    title={emptyTitle(shelf, kind, starredOnly, sharedOnly, query)}
                    description={emptyBody(shelf, kind, starredOnly, sharedOnly, query)}
                    action={
                        shelf === "live" && !query && !sharedOnly ? (
                            <NewButton onPick={setMaking} />
                        ) : undefined
                    }
                />
            ) : (
                <ul className="flex flex-col gap-1">
                    {shown.map((row) => (
                        <Row
                            key={row.id}
                            row={row}
                            busy={busy}
                            onStar={() =>
                                void act(
                                    () => starDocumentAction(row.id, !row.starred),
                                    row.starred ? "Unstarred" : "Starred"
                                )
                            }
                            onArchive={() =>
                                void act(
                                    () => archiveDocumentAction(row.id, !row.archived),
                                    row.archived ? "Put back" : "Archived"
                                )
                            }
                            onTrash={() =>
                                void act(
                                    () => trashDocumentAction(row.id, !row.trashed),
                                    row.trashed ? "Put back" : "Moved to the bin"
                                )
                            }
                            onDelete={() =>
                                void act(() => deleteDocumentAction(row.id), "Deleted for good")
                            }
                        />
                    ))}
                </ul>
            )}

            <NewDialog
                kind={making}
                onClose={() => setMaking(null)}
                onMade={(id, made) => {
                    setMaking(null);
                    router.push(core.officeDocumentPath(made, id));
                }}
            />
        </div>
    );
}

/** One row: what it is, what it is called, and what has happened to it. */
function Row({
    row,
    busy,
    onStar,
    onArchive,
    onTrash,
    onDelete
}: {
    row: OfficeDocumentView;
    busy: boolean;
    onStar: () => void;
    onArchive: () => void;
    onTrash: () => void;
    onDelete: () => void;
}) {
    const Icon = KIND_ICONS[row.kind];
    return (
        <li className="group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-surface-hover">
            <span
                className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted",
                    KIND_TONES[row.kind]
                )}
            >
                <Icon className="size-4 shrink-0" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
                {/* The name opens it. A row whose name is text and whose only way
                    in is a menu is a row people click and nothing happens. */}
                <Link
                    href={core.officeDocumentPath(row.kind, row.id)}
                    className="block truncate text-[13px] font-medium text-foreground"
                    title={row.title}
                >
                    {row.title}
                </Link>
                <p className="flex flex-wrap items-center gap-1.5 truncate text-[12px] text-muted-foreground">
                    <span>{core.OFFICE_KIND_LABELS[row.kind]}</span>
                    {row.orgName ? (
                        <>
                            <span aria-hidden>-</span>
                            <span>{row.orgName}</span>
                        </>
                    ) : null}
                    {row.shared ? (
                        <>
                            <span aria-hidden>-</span>
                            <span className="flex items-center gap-1">
                                <Users className="size-3 shrink-0" aria-hidden />
                                Shared with you
                            </span>
                        </>
                    ) : null}
                    {row.editedBy ? (
                        <>
                            <span aria-hidden>-</span>
                            <span className="truncate">Last edited by {row.editedBy}</span>
                        </>
                    ) : null}
                </p>
            </div>
            {row.editedAt ? (
                <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
                    <RelativeTime iso={row.editedAt} />
                </span>
            ) : null}
            <div className="flex shrink-0 items-center gap-0.5">
                {row.trashed ? (
                    <>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={`Put ${row.title} back`}
                            title="Put back"
                            onClick={onTrash}
                        >
                            <Undo2 className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={`Delete ${row.title} for good`}
                            title="Delete for good"
                            onClick={onDelete}
                        >
                            <Trash2 className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </>
                ) : (
                    <>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-pressed={row.starred}
                            aria-label={row.starred ? `Unstar ${row.title}` : `Star ${row.title}`}
                            title={row.starred ? "Unstar" : "Star"}
                            onClick={onStar}
                        >
                            <Star
                                className={cn(
                                    "size-4 shrink-0",
                                    row.starred && "fill-current text-warning"
                                )}
                                aria-hidden
                            />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={
                                row.archived ? `Put ${row.title} back` : `Archive ${row.title}`
                            }
                            title={row.archived ? "Put back" : "Archive"}
                            onClick={onArchive}
                        >
                            <Undo2
                                className={cn("size-4 shrink-0", !row.archived && "hidden")}
                                aria-hidden
                            />
                            <Columns3
                                className={cn("size-4 shrink-0", row.archived && "hidden")}
                                aria-hidden
                            />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={`Move ${row.title} to the bin`}
                            title="Move to the bin"
                            onClick={onTrash}
                        >
                            <Trash2 className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </>
                )}
            </div>
        </li>
    );
}

/** The five kinds, offered as one press each rather than a press and a menu. */
function NewButton({ onPick }: { onPick: (kind: core.OfficeKind) => void }) {
    return (
        <ScrollRow aria-label="Make something new">
            {core.OFFICE_KINDS.map((kind) => {
                const Icon = KIND_ICONS[kind];
                return (
                    <Button
                        key={kind}
                        size="sm"
                        variant={kind === "doc" ? "primary" : "secondary"}
                        title={core.OFFICE_KIND_HINTS[kind]}
                        onClick={() => onPick(kind)}
                    >
                        {kind === "doc" ? (
                            <Plus className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Icon className="size-4 shrink-0" aria-hidden />
                        )}
                        {core.OFFICE_KIND_LABELS[kind]}
                    </Button>
                );
            })}
        </ScrollRow>
    );
}

/** Name it, and say whose it is. Both on one form: the owner is the one choice
 *  renaming cannot undo afterwards. */
function NewDialog({
    kind,
    onClose,
    onMade
}: {
    kind: core.OfficeKind | null;
    onClose: () => void;
    onMade: (id: string, kind: core.OfficeKind) => void;
}) {
    const toast = useToast();
    const [title, setTitle] = useState("");
    const [owner, setOwner] = useState("");
    const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
    const [me, setMe] = useState<{ id: string; name: string } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!kind) return;
        setTitle("");
        void (async () => {
            const answer = await ownerOptionsAction();
            setOrgs(answer.orgs ?? []);
            setMe(answer.me ?? null);
            // The shelf that is open, for the reason the space picker learned.
            setOwner(answer.scopeOrgId ?? "");
        })();
    }, [kind]);

    if (!kind) return null;
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New {core.OFFICE_KIND_LABELS[kind].toLowerCase()}</DialogTitle>
                    <DialogDescription>{core.OFFICE_KIND_HINTS[kind]}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                        Name
                        <Input
                            autoFocus
                            value={title}
                            placeholder={core.OFFICE_KIND_UNTITLED[kind]}
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    </label>
                    {orgs.length > 0 ? (
                        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                            Who it belongs to
                            <Select
                                value={owner}
                                aria-label="Who this belongs to"
                                onValueChange={setOwner}
                                options={[
                                    { value: "", label: me?.name ?? "You" },
                                    ...orgs.map((org) => ({ value: org.id, label: org.name }))
                                ]}
                            />
                        </label>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            disabled={busy}
                            aria-disabled={busy}
                            onClick={async () => {
                                setBusy(true);
                                const answer = await createDocumentAction({
                                    kind,
                                    title,
                                    orgId: owner || null
                                });
                                setBusy(false);
                                if (answer.error || !answer.id) {
                                    toast.show({ title: answer.error ?? "That could not be made" });
                                    return;
                                }
                                onMade(answer.id, kind);
                            }}
                        >
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            ) : null}
                            Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** What an empty screen says. Never the same sentence twice: "nothing here" on
 *  a search and on an empty bin are different facts and lead somewhere
 *  different. */
function emptyTitle(
    shelf: string,
    kind: core.OfficeKind | "",
    starred: boolean,
    shared: boolean,
    query: string
): string {
    if (query) return "Nothing matched";
    if (shelf === "trashed") return "The bin is empty";
    if (shelf === "archived") return "Nothing archived";
    if (starred) return "Nothing starred";
    if (shared) return "Nothing shared with you";
    if (kind) return `No ${core.OFFICE_KIND_LABELS[kind].toLowerCase()}s yet`;
    return "Nothing here yet";
}

function emptyBody(
    shelf: string,
    kind: core.OfficeKind | "",
    starred: boolean,
    shared: boolean,
    query: string
): string {
    if (query) return "No document here has that in its name.";
    if (shelf === "trashed") return "Documents you delete wait here until you empty it.";
    if (shelf === "archived") return "Archiving takes something out of the way without deleting it.";
    if (starred) return "Star a document to keep it at the top of this list.";
    if (shared) return "Documents other people give you appear here.";
    if (kind) return core.OFFICE_KIND_HINTS[kind];
    return "Make a document, a spreadsheet, a presentation, a diagram or a comparison.";
}
