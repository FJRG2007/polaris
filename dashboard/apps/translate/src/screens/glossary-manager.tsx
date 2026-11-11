"use client";

/**
 * The reader's glossaries at `/translate/glossaries`, as DeepL keeps them: one
 * per language pair, each a list of how terms come out, one of them the
 * pair's default; and the words never to translate at all, in any language.
 * A glossary comes in from a CSV (`source,target` per line) and goes out as
 * one. The list is drawn from the last visit before the server answers.
 */

import type { Shelf } from "./glossaries";
import { hostUi } from "@polaris/app-host/client";
import { languageName } from "../model/languages";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLanguageOptions } from "./language-options";
import type { Glossary, GlossarySummary } from "../lib/glossary";
import { BookA, Download, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { readCache, unwrap, useTranslateLocale, useTranslateT, writeCache } from "./i18n";
import {
    ENTRIES_MAX,
    GLOSSARIES_MAX,
    KEEP_MAX,
    TERM_MAX,
    fromCsv,
    glossaryInput,
    keepInput,
    normalizeTerm,
    toCsv,
    type GlossaryEntry
} from "../model/glossary";
import {
    deleteGlossaryAction,
    glossariesAction,
    glossaryAction,
    saveGlossaryAction,
    saveKeepAction
} from "../actions/translate";
import {
    Badge,
    Button,
    Card,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SearchableSelect,
    Skeleton,
    Switch,
    ListField,
    isDirty,
    useToast
} from "@polaris/ui";

const { useChooseFiles } = hostUi.filePicker;

/** A term row's height before it is measured: an input and the gap under it. */
const ROW_HEIGHT = 40;

/** What a CSV chooser offers. */
const CSV_ACCEPT = ".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values";

interface Draft {
    id: string | null;
    name: string;
    from: string;
    to: string;
    isDefault: boolean;
    entries: GlossaryEntry[];
}

const blank = (): Draft => ({
    id: null,
    name: "",
    from: "en",
    to: "es",
    isDefault: true,
    entries: [{ source: "", target: "" }]
});

/** A file saved from the browser, the way the document mode hands one over. */
function saveFile(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a glossary's name: letters, digits and dashes. */
export function csvName(name: string): string {
    const base = name
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    return `${base || "glossary"}.csv`;
}

export function GlossaryManager() {
    const t = useTranslateT();
    const locale = useTranslateLocale();
    const toast = useToast();
    const [shelf, setShelf] = useState<Shelf | null>(() => readCache<Shelf>("glossaries"));
    const [failed, setFailed] = useState(false);
    const [editing, setEditing] = useState<Draft | null>(null);
    const [opening, setOpening] = useState<string | null>(null);
    const [removing, setRemoving] = useState<GlossarySummary | null>(null);
    const [removePending, setRemovePending] = useState(false);

    const keep = (next: Shelf) => {
        setShelf(next);
        writeCache("glossaries", next);
    };

    const load = async () => {
        setFailed(false);
        try {
            const answer = await unwrap(() => glossariesAction(), t("glossary.errors.loadFailed"));
            keep({ glossaries: answer.glossaries, keep: answer.keep });
        } catch {
            setFailed(true);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
    }, []);

    const pair = (glossary: { from: string; to: string }) =>
        t("glossary.pair", {
            from: languageName(glossary.from, locale),
            to: languageName(glossary.to, locale)
        });

    const full = async (summary: GlossarySummary): Promise<Glossary | null> => {
        setOpening(summary.id);
        try {
            const answer = await unwrap(
                () => glossaryAction({ id: summary.id }),
                t("glossary.errors.loadFailed")
            );
            return answer.glossary;
        } catch (caught) {
            toast.show({ title: (caught as Error).message });
            return null;
        } finally {
            setOpening(null);
        }
    };

    const edit = async (summary: GlossarySummary) => {
        const glossary = await full(summary);
        if (!glossary) return;
        setEditing({
            id: glossary.id,
            name: glossary.name,
            from: glossary.from,
            to: glossary.to,
            isDefault: glossary.isDefault,
            entries: glossary.entries.length ? glossary.entries : [{ source: "", target: "" }]
        });
    };

    const exportCsv = async (summary: GlossarySummary) => {
        const glossary = await full(summary);
        if (glossary) saveFile(csvName(glossary.name), toCsv(glossary.entries));
    };

    const saved = (glossary: Glossary) => {
        const { entries: _entries, ...summary } = glossary;
        const rest = (shelf?.glossaries ?? [])
            .filter((other) => other.id !== glossary.id)
            .map((other) =>
                glossary.isDefault && other.from === glossary.from && other.to === glossary.to
                    ? { ...other, isDefault: false }
                    : other
            );
        keep({ glossaries: [summary, ...rest], keep: shelf?.keep ?? [] });
        setEditing(null);
    };

    const remove = async () => {
        if (!removing || !shelf) return;
        setRemovePending(true);
        const before = shelf;
        // Gone at once; back if the server says no.
        keep({ ...shelf, glossaries: shelf.glossaries.filter((g) => g.id !== removing.id) });
        try {
            await unwrap(
                () => deleteGlossaryAction({ id: removing.id }),
                t("glossary.errors.deleteFailed")
            );
            setRemoving(null);
        } catch (caught) {
            keep(before);
            toast.show({ title: (caught as Error).message });
        } finally {
            setRemovePending(false);
        }
    };

    const glossaries = shelf?.glossaries ?? null;
    const atLimit = (glossaries?.length ?? 0) >= GLOSSARIES_MAX;

    return (
        <div className="flex min-w-0 flex-col gap-6">
            <section aria-labelledby="glossaries-title" className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 id="glossaries-title" className="min-w-0 flex-1 text-sm font-semibold">
                        {t("glossary.listTitle")}
                    </h2>
                    <Button
                        size="sm"
                        onClick={() => setEditing(blank())}
                        disabled={atLimit || glossaries === null}
                        title={atLimit ? t("glossary.errors.limit") : undefined}
                    >
                        <Plus className="size-4 shrink-0" aria-hidden />
                        {t("glossary.new")}
                    </Button>
                </div>
                {glossaries === null && !failed ? (
                    <div className="flex flex-col gap-2" aria-busy>
                        <Skeleton className="h-14 w-full" />
                        <Skeleton className="h-14 w-full" />
                    </div>
                ) : failed && glossaries === null ? (
                    <EmptyState
                        title={t("glossary.errors.loadFailed")}
                        action={
                            <Button variant="outline" size="sm" onClick={() => void load()}>
                                {t("glossary.retry")}
                            </Button>
                        }
                    />
                ) : glossaries && glossaries.length === 0 ? (
                    <EmptyState
                        icon={<BookA className="size-5" aria-hidden />}
                        title={t("glossary.emptyTitle")}
                        description={t("glossary.emptyHint")}
                    />
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {(glossaries ?? []).map((glossary) => (
                            <li
                                key={glossary.id}
                                className="flex min-w-0 items-center gap-2 px-3 py-2"
                            >
                                <button
                                    type="button"
                                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                                    onClick={() => void edit(glossary)}
                                    disabled={opening === glossary.id}
                                >
                                    <span className="flex w-full min-w-0 items-center gap-2">
                                        <span
                                            className="truncate text-sm font-medium"
                                            title={glossary.name}
                                        >
                                            {glossary.name}
                                        </span>
                                        {glossary.isDefault ? (
                                            <Badge variant="primary">{t("glossary.default")}</Badge>
                                        ) : null}
                                    </span>
                                    <span className="w-full truncate text-xs text-muted-foreground">
                                        {pair(glossary)} ·{" "}
                                        {t("glossary.count", { count: glossary.count })}
                                    </span>
                                </button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("glossary.edit")}
                                    title={t("glossary.edit")}
                                    onClick={() => void edit(glossary)}
                                    disabled={opening === glossary.id}
                                >
                                    <Pencil className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("glossary.export")}
                                    title={t("glossary.export")}
                                    onClick={() => void exportCsv(glossary)}
                                    disabled={opening === glossary.id || glossary.count === 0}
                                >
                                    <Download className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("glossary.delete")}
                                    title={t("glossary.delete")}
                                    onClick={() => setRemoving(glossary)}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {failed && glossaries !== null ? (
                    <p className="text-xs text-destructive" role="status">
                        {t("glossary.errors.loadFailed")}
                    </p>
                ) : null}
            </section>

            <KeepList
                terms={shelf?.keep ?? null}
                onSaved={(terms) => keep({ glossaries: shelf?.glossaries ?? [], keep: terms })}
            />

            {editing ? (
                <GlossaryEditor draft={editing} onClose={() => setEditing(null)} onSaved={saved} />
            ) : null}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (!open ? setRemoving(null) : undefined)}
                name={removing?.name ?? ""}
                kind={t("glossary.kind")}
                requireTyping={false}
                title={t("glossary.deleteTitle")}
                question={t("glossary.deleteQuestion", { name: removing?.name ?? "" })}
                confirmLabel={t("glossary.delete")}
                pending={removePending}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

/** The words never translated, each one added and removed on its own, saved
 *  when the list differs from what is stored. */
function KeepList({
    terms,
    onSaved
}: {
    terms: string[] | null;
    onSaved: (terms: string[]) => void;
}) {
    const t = useTranslateT();
    const toast = useToast();
    const [draft, setDraft] = useState<string[] | null>(null);
    const [pending, setPending] = useState(false);
    const shown = draft ?? terms ?? [];
    const parsed = keepInput.safeParse(shown);
    const changed = terms !== null && isDirty(terms.join("\n"), shown.join("\n"));

    const save = async () => {
        if (!parsed.success || !changed) return;
        setPending(true);
        try {
            const answer = await unwrap(
                () => saveKeepAction(parsed.data),
                t("glossary.errors.saveFailed")
            );
            onSaved(answer.keep);
            setDraft(null);
        } catch (caught) {
            toast.show({ title: (caught as Error).message });
        } finally {
            setPending(false);
        }
    };

    return (
        <section aria-labelledby="keep-title" className="flex min-w-0 flex-col gap-2">
            <h2 id="keep-title" className="text-sm font-semibold">
                {t("glossary.keepTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("glossary.keepHint")}</p>
            {terms === null ? (
                <Skeleton className="h-28 w-full" />
            ) : (
                <Card className="flex min-w-0 flex-col gap-2 p-3">
                    <ListField
                        aria-label={t("glossary.keepTitle")}
                        value={shown}
                        max={KEEP_MAX}
                        maxLength={TERM_MAX}
                        caseInsensitive
                        disabled={pending}
                        placeholder={t("glossary.keepPlaceholder")}
                        onChange={(next) => setDraft(next.map(normalizeTerm).filter(Boolean))}
                    />
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                            className={
                                parsed.success
                                    ? "min-w-0 flex-1 text-xs text-muted-foreground"
                                    : "min-w-0 flex-1 text-xs text-destructive"
                            }
                            role="status"
                        >
                            {parsed.success
                                ? t("glossary.keepCount", { count: shown.length, max: KEEP_MAX })
                                : t("glossary.errors.keepInvalid", { max: KEEP_MAX })}
                        </span>
                        {draft !== null && changed ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDraft(null)}
                                disabled={pending}
                            >
                                {t("glossary.cancel")}
                            </Button>
                        ) : null}
                        <Button
                            size="sm"
                            onClick={() => void save()}
                            disabled={!changed || !parsed.success || pending}
                        >
                            {t("glossary.save")}
                        </Button>
                    </div>
                </Card>
            )}
        </section>
    );
}

/** One glossary written or changed: its name, pair, default mark and terms. */
function GlossaryEditor({
    draft,
    onClose,
    onSaved
}: {
    draft: Draft;
    onClose: () => void;
    onSaved: (glossary: Glossary) => void;
}) {
    const t = useTranslateT();
    const locale = useTranslateLocale();
    const toast = useToast();
    const languages = useLanguageOptions(locale);
    const [chooseFiles, chooser] = useChooseFiles();
    const [value, setValue] = useState<Draft>(draft);
    const latest = useRef(value);
    latest.current = value;
    const [filter, setFilter] = useState("");
    const [pending, setPending] = useState(false);

    // Rows left wholly blank are the empty line to type into, not an error.
    const filled = value.entries.filter((entry) => entry.source.trim() || entry.target.trim());
    const parsed = glossaryInput.safeParse({ ...value, entries: filled });
    const issue = (path: string) =>
        !parsed.success && parsed.error.issues.some((found) => found.path[0] === path);
    const halfRow = (entry: GlossaryEntry) =>
        !normalizeTerm(entry.source) !== !normalizeTerm(entry.target);
    const changed = draft.id === null || isDirty(draft, { ...value, entries: value.entries });

    const shownRows = useMemo(() => {
        const needle = filter.trim().toLocaleLowerCase();
        return value.entries
            .map((entry, index) => ({ entry, index }))
            .filter(
                ({ entry }) =>
                    !needle ||
                    entry.source.toLocaleLowerCase().includes(needle) ||
                    entry.target.toLocaleLowerCase().includes(needle)
            );
    }, [value.entries, filter]);

    // State, not a ref: the list is drawn in the dialog's portal, which mounts
    // after this renders, and the virtualizer only takes up a list it is handed.
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const rowWindow = useVirtualizer({
        count: shownRows.length,
        getScrollElement: () => scroller,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8
    });
    // A term just added is scrolled into view, since rows out of sight are not drawn.
    const revealLast = useRef(false);
    useEffect(() => {
        if (!revealLast.current || shownRows.length === 0) return;
        revealLast.current = false;
        rowWindow.scrollToIndex(shownRows.length - 1, { align: "end" });
    }, [shownRows.length, rowWindow]);

    const setEntry = (index: number, side: keyof GlossaryEntry, text: string) =>
        setValue((current) => ({
            ...current,
            entries: current.entries.map((entry, at) =>
                at === index ? { ...entry, [side]: text } : entry
            )
        }));

    const importCsv = () => {
        void chooseFiles({
            accept: CSV_ACCEPT,
            title: t("glossary.import"),
            onFailed: (message) => toast.show({ title: message })
        }).then(async ([file]) => {
            if (!file) return;
            const { entries, skipped } = fromCsv(await file.text());
            if (entries.length === 0) {
                toast.show({ title: t("glossary.errors.importEmpty") });
                return;
            }
            const kept = latest.current.entries.filter((e) => e.source.trim() || e.target.trim());
            const known = new Set(entries.map((e) => e.source.toLocaleLowerCase()));
            const others = kept.filter(
                (e) => !known.has(normalizeTerm(e.source).toLocaleLowerCase())
            );
            const added = entries.slice(0, Math.max(0, ENTRIES_MAX - others.length));
            const overflow = entries.length - added.length;
            setValue((current) => ({ ...current, entries: [...others, ...added] }));
            const notes = [
                skipped > 0 ? t("glossary.importSkipped", { count: skipped }) : null,
                overflow > 0
                    ? t("glossary.importOverflow", { count: overflow, max: ENTRIES_MAX })
                    : null
            ].filter(Boolean);
            toast.show({
                title: t("glossary.imported", { count: added.length }),
                body: notes.length > 0 ? notes.join(" ") : undefined
            });
        });
    };

    const save = async () => {
        if (!parsed.success || filled.some(halfRow)) return;
        setPending(true);
        try {
            const answer = await unwrap(
                () =>
                    saveGlossaryAction({
                        ...parsed.data,
                        ...(value.id ? { id: value.id } : {})
                    }),
                t("glossary.errors.saveFailed")
            );
            onSaved(answer.glossary);
        } catch (caught) {
            toast.show({ title: (caught as Error).message });
        } finally {
            setPending(false);
        }
    };

    const blocked = !parsed.success || filled.some(halfRow) || !changed || pending;

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-2xl sm:max-w-2xl">
                {chooser}
                <DialogHeader>
                    <DialogTitle>
                        {value.id ? t("glossary.editTitle") : t("glossary.newTitle")}
                    </DialogTitle>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span>{t("glossary.name")} *</span>
                        <Input
                            value={value.name}
                            maxLength={80}
                            aria-invalid={(issue("name") && value.name !== "") || undefined}
                            onChange={(event) => setValue({ ...value, name: event.target.value })}
                        />
                    </label>
                    <div className="grid grid-cols-1 min-w-0 gap-2 sm:grid-cols-2">
                        <SearchableSelect
                            className="w-full min-w-0"
                            aria-label={t("lang.from")}
                            value={value.from}
                            onValueChange={(from) => setValue({ ...value, from })}
                            options={languages}
                            searchPlaceholder={t("lang.search")}
                            emptyText={t("lang.none")}
                        />
                        <SearchableSelect
                            className="w-full min-w-0"
                            aria-label={t("lang.to")}
                            value={value.to}
                            onValueChange={(to) => setValue({ ...value, to })}
                            options={languages}
                            searchPlaceholder={t("lang.search")}
                            emptyText={t("lang.none")}
                        />
                    </div>
                    {value.from === value.to ? (
                        <p className="text-xs text-destructive" role="status">
                            {t("glossary.errors.samePair")}
                        </p>
                    ) : null}
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                        <Switch
                            checked={value.isDefault}
                            onChange={(isDefault) => setValue({ ...value, isDefault })}
                            aria-label={t("glossary.makeDefault")}
                        />
                        <span className="min-w-0">{t("glossary.makeDefault")}</span>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm font-medium">
                            {t("glossary.terms")}
                            <span className="ml-2 font-normal text-muted-foreground">
                                {t("glossary.termsCount", {
                                    count: filled.length,
                                    max: ENTRIES_MAX
                                })}
                            </span>
                        </span>
                        <Button variant="outline" size="sm" onClick={importCsv}>
                            <Upload className="size-4 shrink-0" aria-hidden />
                            {t("glossary.import")}
                        </Button>
                    </div>
                    {value.entries.length > 10 ? (
                        <Input
                            type="search"
                            value={filter}
                            aria-label={t("glossary.filter")}
                            placeholder={t("glossary.filter")}
                            onChange={(event) => setFilter(event.target.value)}
                        />
                    ) : null}
                    <div ref={setScroller} className="max-h-80 min-w-0 overflow-y-auto">
                        <ul
                            className="relative min-w-0"
                            style={{ height: rowWindow.getTotalSize() }}
                        >
                            {rowWindow.getVirtualItems().map((row) => {
                                const { entry, index } = shownRows[row.index]!;
                                return (
                                    <li
                                        key={index}
                                        data-index={row.index}
                                        ref={rowWindow.measureElement}
                                        className="absolute inset-x-0 top-0 flex min-w-0 items-center gap-2 pb-2"
                                        style={{ transform: `translateY(${row.start}px)` }}
                                    >
                                        <Input
                                            className="min-w-0 flex-1"
                                            value={entry.source}
                                            maxLength={200}
                                            aria-label={t("glossary.source")}
                                            placeholder={t("glossary.source")}
                                            aria-invalid={
                                                (halfRow(entry) && !entry.source.trim()) ||
                                                undefined
                                            }
                                            onChange={(event) =>
                                                setEntry(index, "source", event.target.value)
                                            }
                                        />
                                        <Input
                                            className="min-w-0 flex-1"
                                            value={entry.target}
                                            maxLength={200}
                                            aria-label={t("glossary.target")}
                                            placeholder={t("glossary.target")}
                                            aria-invalid={
                                                (halfRow(entry) && !entry.target.trim()) ||
                                                undefined
                                            }
                                            onChange={(event) =>
                                                setEntry(index, "target", event.target.value)
                                            }
                                        />
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t("glossary.removeTerm")}
                                            title={t("glossary.removeTerm")}
                                            onClick={() =>
                                                setValue({
                                                    ...value,
                                                    entries: value.entries.filter(
                                                        (_, at) => at !== index
                                                    )
                                                })
                                            }
                                        >
                                            <X className="size-4 shrink-0" aria-hidden />
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-fit"
                        disabled={value.entries.length >= ENTRIES_MAX}
                        onClick={() => {
                            setFilter("");
                            revealLast.current = true;
                            setValue({
                                ...value,
                                entries: [...value.entries, { source: "", target: "" }]
                            });
                        }}
                    >
                        <Plus className="size-4 shrink-0" aria-hidden />
                        {t("glossary.addTerm")}
                    </Button>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("glossary.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={blocked} aria-disabled={blocked}>
                        {t("glossary.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
