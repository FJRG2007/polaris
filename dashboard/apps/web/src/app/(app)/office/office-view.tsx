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
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/confirm-dialog";
import { useShelfScope } from "@/components/shelf-scope";
import { RelativeTime } from "@/components/relative-time";
import { asFiles } from "@/components/file-picker/as-files";
import type { OfficeDocumentView } from "@/lib/office/documents";
import { OFFICE_KIND_HINT_KEYS, OFFICE_KIND_KEYS } from "./office-kinds";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PickedFile } from "@/components/file-picker/picked-file";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import {
    Columns3,
    FileText,
    Loader2,
    Plus,
    Upload,
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
    starDocumentAction,
    trashDocumentAction
} from "./actions";
import {
    Button,
    ConfirmDeleteDialog,
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

const EMPTY_KIND_KEYS = {
    doc: "view.emptyKind.doc",
    sheet: "view.emptyKind.sheet",
    slides: "view.emptyKind.slides",
    diagram: "view.emptyKind.diagram",
    comparison: "view.emptyKind.comparison"
} as const satisfies Record<core.OfficeKind, NamespaceKey<"office">>;

const SORT_KEYS = {
    opened: "view.sorts.opened",
    edited: "view.sorts.edited",
    created: "view.sorts.created",
    title: "view.sorts.title"
} as const satisfies Record<core.OfficeSort, NamespaceKey<"office">>;

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
    const t = useTranslations("office");
    const router = useRouter();
    const toast = useToast();
    const on = useShelfScope();
    const [documents, setDocuments] = useState<OfficeDocumentView[] | null>(null);
    const [sort, setSort] = useState<core.OfficeSort>(core.DEFAULT_OFFICE_SORT);
    const [query, setQuery] = useState("");
    const [confirm, confirmDialog] = useConfirm();
    /**
     * Making one is pressing the button, and nothing else.
     *
     * It used to be a form asking for a name and a shelf, which is two questions
     * nobody has an answer to yet: the name is decided by what ends up in the
     * document, and the shelf is the one they are already working on. Every
     * other editor - Google's, Office's - makes an untitled document and opens
     * it, and the title is a field at the top of it that somebody fills in when
     * they have something to say. So does this: the server names it
     * "Untitled spreadsheet" until somebody renames it, and files it where they
     * are - see `officeCreateSchema`.
     */
    const [making, setMaking] = useState<core.OfficeKind | null>(null);
    /** The document about to be deleted for good, and what it is called - which
     *  is what the question has to name. */
    const [burning, setBurning] = useState<{ id: string; title: string } | null>(null);

    const make = useCallback(
        (kind: core.OfficeKind) => {
            if (making) return;
            setMaking(kind);
            void (async () => {
                const answer = await createDocumentAction({ kind });
                setMaking(null);
                if (answer.error || !answer.id) {
                    toast.show({ title: answer.error ?? t("view.makeFailed") });
                    return;
                }
                router.push(core.officeDocumentPath(kind, answer.id));
            })();
        },
        [making, router, toast, t]
    );
    const [importing, setImporting] = useState(false);
    const [reading, setReading] = useState(false);

    const load = useCallback(async () => {
        const answer = await listDocumentsAction({ shelf, kind, starredOnly, sort, query });
        if (answer.error) {
            toast.show({ title: answer.error });
            setDocuments([]);
            return;
        }
        setDocuments(answer.documents ?? []);
        // `on` is not read: the list is narrowed by the shelf on the server,
        // from the cookie, so what this is for is the dependency itself. Without
        // it the switch changed what the server rendered and this effect never
        // ran again, leaving one shelf's documents under another's name.
    }, [on, shelf, kind, starredOnly, sort, query, toast]);

    // A different shelf is a different list, so what is on screen is not a
    // stale copy of it - it is somebody else's. Cleared rather than left to be
    // replaced when the answer lands.
    useEffect(() => {
        setDocuments(null);
    }, [on]);

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

    /**
     * A file somebody already has, opened as a document.
     *
     * The picker is the one every other screen that takes a file uses, so a
     * spreadsheet sitting in Drive never travels through the browser twice and
     * "import" means the same thing here as it does in a message.
     *
     * One document per file, and a file that cannot be read says so by name
     * rather than stopping the rest: choosing four and having the third refused
     * should leave three documents, not none.
     */
    const importPicked = useCallback(
        async (picked: readonly PickedFile[]) => {
            setImporting(false);
            if (picked.length === 0) return;
            setReading(true);
            try {
                const { files, failed } = await asFiles(picked);
                for (const said of failed) toast.show({ title: said });

                const opened: { id: string; kind: core.OfficeKind }[] = [];
                for (const file of files) {
                    const form = new FormData();
                    form.set("file", file);
                    if (on) form.set("orgId", on);
                    const answer = await fetch("/api/office/import", {
                        method: "POST",
                        body: form
                    });
                    const body = (await answer.json().catch(() => null)) as {
                        id?: string;
                        kind?: core.OfficeKind;
                        error?: string;
                    } | null;
                    if (!answer.ok || !body?.id || !body.kind) {
                        toast.show({ title: body?.error ?? t("view.openFailed", { name: file.name }) });
                        continue;
                    }
                    opened.push({ id: body.id, kind: body.kind });
                }

                const first = opened[0];
                if (!first) return;
                // Straight into the one that was just made when it is the only
                // one: somebody importing a file is about to look at it. Several
                // at once is a list to come back to, so the list is refreshed
                // and nothing is opened over the top of it.
                if (files.length === 1) {
                    router.push(core.officeDocumentPath(first.kind, first.id));
                    return;
                }
                // What was opened, never what was chosen: the refusals above are
                // still on screen, and "4 files opened" over three of them is
                // the screen contradicting itself.
                toast.show({
                    title: t("view.opened", { count: opened.length })
                });
                await load();
            } finally {
                setReading(false);
            }
        },
        [load, on, router, toast, t]
    );

    /**
     * A row moves when it is pressed, not when the server agrees.
     *
     * Everything here is one write away - starred, archived, binned - and the
     * screen used to disable every button on every row and wait for the answer,
     * then ask for the whole list again. That makes the common case, the write
     * succeeding, the one that reads as broken. So the row goes where it is
     * going now; a refusal puts the list back exactly as it was and says why.
     */
    const act = useCallback(
        async (
            change: (rows: OfficeDocumentView[]) => OfficeDocumentView[],
            run: () => Promise<{ error?: string }>,
            said: string
        ): Promise<void> => {
            const before = documents;
            setDocuments((rows) => (rows === null ? rows : change(rows)));
            const answer = await run();
            if (answer.error) {
                setDocuments(before);
                toast.show({ title: answer.error });
                return;
            }
            toast.show({ title: said });
            await load();
        },
        [documents, load, toast]
    );

    /** Off this list: every screen here is one shelf, so archiving, binning and
     *  putting back all mean the row belongs somewhere else now. */
    const drop = (id: string) => (rows: OfficeDocumentView[]) =>
        rows.filter((row) => row.id !== id);

    /**
     * Into the bin, once they have said so.
     *
     * Asked, because a bin icon on a row of a list is pressed by accident and
     * the document it takes is the one somebody was working on. Putting one
     * back is not asked: nothing is lost by it.
     */
    const bin = useCallback(
        async (row: OfficeDocumentView): Promise<void> => {
            if (!row.trashed) {
                const sure = await confirm({
                    title: t("view.binTitle", { name: row.title }),
                    description: t("view.binBody"),
                    confirmLabel: t("view.bin"),
                    danger: true
                });
                if (!sure) return;
            }
            await act(
                drop(row.id),
                () => trashDocumentAction(row.id, !row.trashed),
                row.trashed ? t("view.restored") : t("view.binned")
            );
        },
        [act, confirm, t]
    );

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={title} description={description} />
                {shelf === "live" ? (
                    <NewButton
                        onPick={make}
                        onImport={() => setImporting(true)}
                        busy={reading}
                    />
                ) : null}
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
                        placeholder={t("view.search")}
                        aria-label={t("view.searchLabel")}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="w-48"
                    aria-label={t("view.sortLabel")}
                    value={sort}
                    onValueChange={(next) => setSort(core.readOfficeSort(next))}
                    options={core.OFFICE_SORTS.map((one) => ({
                        value: one,
                        label: t(SORT_KEYS[one])
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
                    title={t(emptyTitle(shelf, kind, starredOnly, sharedOnly, query))}
                    description={t(emptyBody(shelf, kind, starredOnly, sharedOnly, query))}
                    action={
                        shelf === "live" && !query && !sharedOnly ? (
                            <NewButton
                                onPick={make}
                                onImport={() => setImporting(true)}
                                busy={reading}
                            />
                        ) : undefined
                    }
                />
            ) : (
                <ul className="flex flex-col gap-1">
                    {shown.map((row) => (
                        <Row
                            key={row.id}
                            row={row}
                            onStar={() =>
                                void act(
                                    // Unstarred on the starred shelf is a row
                                    // that no longer belongs to this list.
                                    starredOnly
                                        ? drop(row.id)
                                        : (rows) =>
                                              rows.map((one) =>
                                                  one.id === row.id
                                                      ? { ...one, starred: !row.starred }
                                                      : one
                                              ),
                                    () => starDocumentAction(row.id, !row.starred),
                                    row.starred ? t("view.unstarred") : t("view.starred")
                                )
                            }
                            onArchive={() =>
                                void act(
                                    drop(row.id),
                                    () => archiveDocumentAction(row.id, !row.archived),
                                    row.archived ? t("view.restored") : t("view.archived")
                                )
                            }
                            onTrash={() => void bin(row)}
                            onDelete={() => setBurning({ id: row.id, title: row.title })}
                        />
                    ))}
                </ul>
            )}

            {importing ? (
                <FilePickerDialog
                    title={t("view.importTitle")}
                    accept={core.OFFICE_IMPORT_ACCEPT}
                    onPick={(picked) => void importPicked(picked)}
                    onClose={() => setImporting(false)}
                />
            ) : null}

            {/* The permanent one, and the only delete here that asks: the bin
                is where a document waits, and this is the end of it. */}
            {burning ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next: boolean) => (next ? undefined : setBurning(null))}
                    name={burning.title}
                    requireTyping={false}
                    kind="document"
                    title={t("view.burnTitle", { name: burning.title })}
                    question={t.rich("view.burnQuestion", {
                        name: burning.title,
                        strong: (chunks) => (
                            <span key="name" className="font-medium text-foreground">
                                {chunks}
                            </span>
                        )
                    })}
                    description={t("view.burnBody")}
                    confirmLabel={t("view.burn")}
                    onConfirm={() => {
                        const gone = burning;
                        setBurning(null);
                        void act(
                            drop(gone.id),
                            () => deleteDocumentAction(gone.id),
                            t("view.burned")
                        );
                    }}
                />
            ) : null}

            {confirmDialog}
        </div>
    );
}

/** One row: what it is, what it is called, and what has happened to it. */
function Row({
    row,
    onStar,
    onArchive,
    onTrash,
    onDelete
}: {
    row: OfficeDocumentView;
    onStar: () => void;
    onArchive: () => void;
    onTrash: () => void;
    onDelete: () => void;
}) {
    const t = useTranslations("office");
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
                    <span>{t(OFFICE_KIND_KEYS[row.kind])}</span>
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
                                {t("view.sharedWithYou")}
                            </span>
                        </>
                    ) : null}
                    {row.editedBy ? (
                        <>
                            <span aria-hidden>-</span>
                            <span className="truncate">{t("view.editedBy", { name: row.editedBy })}</span>
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
                            aria-label={t("view.restoreNamed", { name: row.title })}
                            title={t("view.restore")}
                            onClick={onTrash}
                        >
                            <Undo2 className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("view.burnNamed", { name: row.title })}
                            title={t("view.burn")}
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
                            aria-pressed={row.starred}
                            aria-label={
                                row.starred
                                    ? t("view.unstarNamed", { name: row.title })
                                    : t("view.starNamed", { name: row.title })
                            }
                            title={row.starred ? t("view.unstar") : t("view.star")}
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
                            aria-label={
                                row.archived
                                    ? t("view.restoreNamed", { name: row.title })
                                    : t("view.archiveNamed", { name: row.title })
                            }
                            title={row.archived ? t("view.restore") : t("view.archive")}
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
                            aria-label={t("view.binNamed", { name: row.title })}
                            title={t("view.bin")}
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
function NewButton({
    onPick,
    onImport,
    busy
}: {
    onPick: (kind: core.OfficeKind) => void;
    onImport: () => void;
    /** A file is being read. The row stays put and the one button that started
     *  it says so, rather than the whole header being replaced by a spinner. */
    busy: boolean;
}) {
    const t = useTranslations("office");
    return (
        <ScrollRow className="-mx-1 flex items-center gap-2 px-1" aria-label={t("view.makeNew")}>
            {core.OFFICE_KINDS.map((kind) => {
                const Icon = KIND_ICONS[kind];
                return (
                    <Button
                        key={kind}
                        size="sm"
                        variant={kind === "doc" ? "primary" : "secondary"}
                        title={t(OFFICE_KIND_HINT_KEYS[kind])}
                        onClick={() => onPick(kind)}
                    >
                        {kind === "doc" ? (
                            <Plus className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Icon className="size-4 shrink-0" aria-hidden />
                        )}
                        {t(OFFICE_KIND_KEYS[kind])}
                    </Button>
                );
            })}
            {/* Last, and deliberately: the five above are what somebody makes,
                this is what they already have. */}
            <Button size="sm" variant="secondary" disabled={busy} onClick={onImport}>
                {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                ) : (
                    <Upload className="size-4 shrink-0" aria-hidden />
                )}
                {t("view.import")}
            </Button>
        </ScrollRow>
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
): NamespaceKey<"office"> {
    if (query) return "view.empty.query";
    if (shelf === "trashed") return "view.empty.trashed";
    if (shelf === "archived") return "view.empty.archived";
    if (starred) return "view.empty.starred";
    if (shared) return "view.empty.shared";
    if (kind) return EMPTY_KIND_KEYS[kind];
    return "view.empty.none";
}

function emptyBody(
    shelf: string,
    kind: core.OfficeKind | "",
    starred: boolean,
    shared: boolean,
    query: string
): NamespaceKey<"office"> {
    if (query) return "view.emptyBody.query";
    if (shelf === "trashed") return "view.emptyBody.trashed";
    if (shelf === "archived") return "view.emptyBody.archived";
    if (starred) return "view.emptyBody.starred";
    if (shared) return "view.emptyBody.shared";
    if (kind) return OFFICE_KIND_HINT_KEYS[kind];
    return "view.emptyBody.none";
}
