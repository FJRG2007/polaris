"use client";

/**
 * Skills from outside Polaris: the import dialog (an address or files, then a
 * review of what was found before anything is added), the skills.sh search,
 * and the downloads that take skills out again.
 *
 * Nothing found is added until the person picks it, and a skill that cannot be
 * added as it is (no description, too long, a name they already use) opens in
 * the editor to be fixed instead of being dropped.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FlaskConical, Plus, Search, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton
} from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DirectoryAudit, DirectoryEntry } from "@/lib/polar/skills/remote";
import { DIRECTORY_SOURCE, type SkillInput, type SkillView } from "@/lib/polar/skills/shared";
import { skillBundleOf, skillFileOf, type SkillCandidate } from "@/lib/polar/skills/skill-file";
import {
    importSkillsAction,
    previewSkillImportAction,
    searchSkillDirectoryAction,
    type SkillPreview
} from "./skills-actions";

/** What the review lists: the preview, and the directory entry it was read from. */
export interface ImportReview {
    preview: SkillPreview;
    directory: string | null;
}

/** A skill to fix in the editor before it is added. */
export interface SkillDraft {
    draft: SkillInput;
    directory: string | null;
}

const TEXT_BYTES = 300_000;
const ZIP_BYTES = 5 * 1024 * 1024;
const FILES_MAX = 30;

/** Hands the browser a file to save. */
function save(name: string, type: string, body: string) {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSkill(skill: SkillInput) {
    save(`${skill.name}.SKILL.md`, "text/markdown", skillFileOf(skill));
}

export function downloadSkills(skills: readonly SkillInput[]) {
    save("polar-skills.json", "application/json", skillBundleOf(skills));
}

/** The text of every file chosen, a zip read for the `SKILL.md` files inside it. */
async function readChosen(
    files: readonly File[]
): Promise<{ files: { name: string; text: string }[]; unreadable: string[] }> {
    const read: { name: string; text: string }[] = [];
    const unreadable: string[] = [];
    for (const file of files) {
        if (read.length >= FILES_MAX) break;
        if (/\.zip$/i.test(file.name)) {
            if (file.size > ZIP_BYTES) {
                unreadable.push(file.name);
                continue;
            }
            try {
                const { default: JSZip } = await import("jszip");
                const zip = await JSZip.loadAsync(file);
                const entries = Object.values(zip.files).filter(
                    (entry) => !entry.dir && /(^|\/)skill\.md$/i.test(entry.name)
                );
                for (const entry of entries.slice(0, FILES_MAX - read.length)) {
                    const text = await entry.async("string");
                    if (text.length <= TEXT_BYTES) read.push({ name: entry.name, text });
                    else unreadable.push(entry.name);
                }
                if (entries.length === 0) unreadable.push(file.name);
            } catch {
                unreadable.push(file.name);
            }
            continue;
        }
        if (file.size > TEXT_BYTES) {
            unreadable.push(file.name);
            continue;
        }
        try {
            read.push({ name: file.name, text: await file.text() });
        } catch {
            unreadable.push(file.name);
        }
    }
    return { files: read, unreadable };
}

function AuditNote({ audit }: { audit: DirectoryAudit | null }) {
    const t = useTranslations("polar");
    if (!audit?.status) return null;
    const providers = audit.flaggedBy.join(", ");
    if (audit.status === "pass")
        return (
            <p className="flex items-center gap-1.5 text-xs text-success">
                <ShieldCheck className="size-3.5 shrink-0" />
                {t("settings.skills.audit.pass")}
            </p>
        );
    return (
        <p
            className={`flex items-center gap-1.5 text-xs ${audit.status === "fail" ? "text-danger" : "text-warning"}`}
        >
            <ShieldAlert className="size-3.5 shrink-0" />
            {t(`settings.skills.audit.${audit.status}`, { providers })}
        </p>
    );
}

export function SkillImportDialog({
    open,
    review: given,
    onClose,
    onAdded,
    onFix
}: {
    open: boolean;
    /** Opens straight on a review, as Add from the directory does. */
    review: ImportReview | null;
    onClose: () => void;
    onAdded: (views: SkillView[]) => void;
    onFix: (draft: SkillDraft) => void;
}) {
    const t = useTranslations("polar");
    const [address, setAddress] = useState("");
    const [review, setReview] = useState<ImportReview | null>(null);
    const [picked, setPicked] = useState<Set<number>>(new Set());
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [openedWith, setOpenedWith] = useState<ImportReview | null | undefined>(undefined);
    const [chooseFiles, chooser] = useChooseFiles();
    // The picker is a dialog of its own: this one steps aside while it is open.
    const [picking, setPicking] = useState(false);

    // Every opening starts from what it was opened with.
    const opening = open ? given : undefined;
    if (opening !== openedWith) {
        setOpenedWith(opening);
        setAddress("");
        setError(null);
        setPending(false);
        show(opening ?? null);
    }

    function show(next: ImportReview | null) {
        setReview(next);
        setPicked(
            new Set(
                next?.preview.candidates.flatMap((entry, index) =>
                    entry.problem ? [] : [index]
                ) ?? []
            )
        );
    }

    async function preview(
        input: Parameters<typeof previewSkillImportAction>[0],
        directory: string | null
    ) {
        setPending(true);
        setError(null);
        const answer = await previewSkillImportAction(input);
        setPending(false);
        if (answer.ok) show({ preview: answer.value, directory });
        else setError(answer.error);
    }

    async function pickFiles() {
        setPicking(true);
        const list = await chooseFiles({
            accept: ".md,.json,.zip,text/markdown,application/json,application/zip",
            multiple: true,
            title: t("settings.skills.importer.file"),
            onFailed: setError
        });
        setPicking(false);
        if (list.length === 0) return;
        const { files, unreadable } = await readChosen(list);
        if (files.length === 0) {
            setError(
                unreadable.length > 0
                    ? t("settings.skills.importer.unreadable", { name: unreadable.join(", ") })
                    : t("settings.skills.importer.nothingInFile")
            );
            return;
        }
        await preview({ files }, null);
        if (unreadable.length > 0)
            setError(t("settings.skills.importer.unreadable", { name: unreadable.join(", ") }));
    }

    async function add() {
        if (!review || picked.size === 0 || pending) return;
        const chosen = review.preview.candidates.filter((_, index) => picked.has(index));
        setPending(true);
        setError(null);
        const answer = await importSkillsAction({
            items: chosen.map((entry) => ({ skill: entry.skill, directory: review.directory }))
        });
        setPending(false);
        if (!answer.ok) {
            setError(answer.error);
            return;
        }
        const added = answer.value.flatMap((result) => (result.ok ? [result.value] : []));
        const refused = answer.value.flatMap((result) => (result.ok ? [] : [result.error]));
        if (added.length > 0) onAdded(added);
        if (refused.length === 0) onClose();
        else {
            setError(Array.from(new Set(refused)).join(" "));
            // What was added leaves the list; the rest stays, to be fixed or picked.
            const order = review.preview.candidates.flatMap((_, index) =>
                picked.has(index) ? [index] : []
            );
            const gone = new Set(order.filter((_, at) => answer.value[at]?.ok));
            const kept = review.preview.candidates.filter((_, index) => !gone.has(index));
            show({ ...review, preview: { ...review.preview, candidates: kept } });
        }
    }

    function submitAddress(event: FormEvent) {
        event.preventDefault();
        if (!address.trim() || pending) return;
        void preview({ url: address.trim() }, null);
    }

    const candidates = review?.preview.candidates ?? [];

    return (
        <>
            {chooser}
            <Dialog open={open && !picking} onOpenChange={(next) => !next && !pending && onClose()}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {review
                                ? t("settings.skills.importer.reviewTitle")
                                : t("settings.skills.importer.title")}
                        </DialogTitle>
                        <DialogDescription>
                            {review
                                ? t("settings.skills.importer.instructionsOnly")
                                : t("settings.skills.importer.body")}
                        </DialogDescription>
                    </DialogHeader>
                    {review ? (
                        <div className="flex flex-col gap-3">
                            <AuditNote audit={review.preview.audit} />
                            <ul className="flex max-h-[50vh] flex-col divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border">
                                {candidates.map((entry, index) => (
                                    <CandidateRow
                                        key={`${entry.origin}-${index}`}
                                        entry={entry}
                                        checked={picked.has(index)}
                                        onCheck={(on) =>
                                            setPicked((current) => {
                                                const next = new Set(current);
                                                if (on) next.add(index);
                                                else next.delete(index);
                                                return next;
                                            })
                                        }
                                        onFix={() =>
                                            onFix({
                                                draft: entry.skill,
                                                directory: review.directory
                                            })
                                        }
                                    />
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <form className="flex flex-col gap-1 text-sm" onSubmit={submitAddress}>
                                <label htmlFor="skill-import-address">
                                    {t("settings.skills.importer.url")}
                                </label>
                                <div className="flex gap-2">
                                    <Input
                                        id="skill-import-address"
                                        type="url"
                                        inputMode="url"
                                        autoFocus
                                        value={address}
                                        placeholder="https://github.com/owner/repo"
                                        className="min-w-0 flex-1"
                                        onChange={(event) => setAddress(event.target.value)}
                                    />
                                    <Button
                                        type="submit"
                                        variant="outline"
                                        className="shrink-0"
                                        aria-disabled={!address.trim() || pending}
                                        disabled={pending}
                                    >
                                        {t("settings.skills.importer.read")}
                                    </Button>
                                </div>
                            </form>
                            <p className="text-center text-xs text-muted-foreground">
                                {t("settings.skills.importer.or")}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={pending}
                                onClick={() => void pickFiles()}
                            >
                                <Upload className="h-3.5 w-3.5 shrink-0" />
                                {t("settings.skills.importer.file")}
                            </Button>
                            <p className="text-center text-xs text-muted-foreground">
                                {t("settings.skills.importer.fileHint")}
                            </p>
                            {pending ? <Skeleton className="h-16 w-full" /> : null}
                        </div>
                    )}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        {review && !given ? (
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => show(null)}
                            >
                                {t("settings.skills.importer.back")}
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={pending}
                                onClick={onClose}
                            >
                                {t("settings.skills.cancel")}
                            </Button>
                        )}
                        {review ? (
                            <Button
                                type="button"
                                aria-disabled={picked.size === 0 || pending}
                                disabled={pending}
                                onClick={() => void add()}
                            >
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                {t("settings.skills.importer.add", { count: picked.size })}
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function CandidateRow({
    entry,
    checked,
    onCheck,
    onFix
}: {
    entry: SkillCandidate;
    checked: boolean;
    onCheck: (on: boolean) => void;
    onFix: () => void;
}) {
    const t = useTranslations("polar");
    const id = `candidate-${entry.origin}`;
    return (
        <li className="flex items-start gap-3 px-3 py-2.5">
            <Checkbox
                id={id}
                className="mt-0.5"
                checked={checked}
                disabled={entry.problem !== null}
                onChange={(event) => onCheck(event.target.checked)}
            />
            <label htmlFor={id} className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm" title={entry.skill.name}>
                    {entry.skill.name || "-"}
                </span>
                <span
                    className="line-clamp-2 text-xs text-muted-foreground"
                    title={entry.skill.description}
                >
                    {entry.skill.description || entry.origin}
                </span>
                {entry.problem ? (
                    <span className="block text-xs text-danger">
                        {t(`settings.skills.importer.problems.${entry.problem}`)}
                    </span>
                ) : null}
            </label>
            {entry.problem ? (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={onFix}
                >
                    {t("settings.skills.importer.fix")}
                </Button>
            ) : null}
        </li>
    );
}

/** How long typing pauses before the directory is asked. */
const SEARCH_DELAY_MS = 350;

export function SkillDirectory({
    held,
    readOnly,
    onReview,
    onTry
}: {
    /** Names and sources the person already has, to show Added on. */
    held: { names: ReadonlySet<string>; sources: ReadonlySet<string> };
    readOnly: boolean;
    onReview: (review: ImportReview) => void;
    onTry: (draft: SkillInput) => void;
}) {
    const t = useTranslations("polar");
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<DirectoryEntry[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const asked = useRef(0);

    useEffect(() => {
        const wanted = query.trim();
        if (wanted.length < 2) {
            asked.current += 1;
            setResults(null);
            setSearching(false);
            return;
        }
        const turn = ++asked.current;
        setSearching(true);
        const timer = window.setTimeout(async () => {
            const answer = await searchSkillDirectoryAction({ query: wanted });
            // A newer search answers instead.
            if (turn !== asked.current) return;
            setSearching(false);
            if (answer.ok) {
                setError(null);
                setResults(answer.value);
            } else setError(answer.error);
        }, SEARCH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [query]);

    async function open(entry: DirectoryEntry, then: "review" | "try") {
        setBusy(entry.id);
        setError(null);
        const answer = await previewSkillImportAction({ directory: entry.id });
        setBusy(null);
        if (!answer.ok) {
            setError(answer.error);
            return;
        }
        const [found] = answer.value.candidates;
        if (then === "try" && found && found.problem !== "invalid" && found.problem !== "too_long")
            onTry(found.skill);
        else onReview({ preview: answer.value, directory: entry.id });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="min-w-0">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("settings.skills.directoryTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">
                    {t("settings.skills.directoryIntro")}
                </p>
            </div>
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                <Input
                    type="search"
                    value={query}
                    className="pl-9"
                    aria-label={t("settings.skills.directorySearch")}
                    placeholder={t("settings.skills.directorySearch")}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {query.trim().length === 1 ? (
                <p className="text-xs text-muted-foreground">
                    {t("settings.skills.directoryHint")}
                </p>
            ) : null}
            {searching && !results ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            ) : null}
            {results && results.length === 0 && !searching ? (
                <p className="text-sm text-muted-foreground">
                    {t("settings.skills.directoryEmpty")}
                </p>
            ) : null}
            {results && results.length > 0 ? (
                <Card className={searching ? "opacity-70" : undefined}>
                    <CardBody className="flex flex-col divide-y divide-border p-0">
                        {results.map((entry) => {
                            const added =
                                held.sources.has(`${DIRECTORY_SOURCE}${entry.id}`) ||
                                held.names.has(entry.name);
                            return (
                                <div key={entry.id} className="flex items-center gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <a
                                            href={`https://skills.sh/${entry.id}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block truncate font-mono text-sm font-medium hover:underline"
                                            title={entry.id}
                                        >
                                            {entry.name}
                                        </a>
                                        <p className="flex min-w-0 gap-2 text-xs text-muted-foreground">
                                            <span className="truncate" title={entry.source}>
                                                {entry.source}
                                            </span>
                                            <span className="shrink-0">
                                                {t("settings.skills.installs", {
                                                    count: format.number(entry.installs, {
                                                        notation: "compact"
                                                    })
                                                })}
                                            </span>
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="shrink-0"
                                        disabled={busy === entry.id}
                                        onClick={() => void open(entry, "try")}
                                    >
                                        <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                                        {t("settings.skills.try")}
                                    </Button>
                                    {added ? (
                                        <Badge variant="success" className="shrink-0">
                                            {t("settings.skills.added")}
                                        </Badge>
                                    ) : !readOnly ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            className="shrink-0"
                                            disabled={busy === entry.id}
                                            onClick={() => void open(entry, "review")}
                                        >
                                            <Plus className="h-3.5 w-3.5 shrink-0" />
                                            {t("settings.skills.add")}
                                        </Button>
                                    ) : null}
                                </div>
                            );
                        })}
                    </CardBody>
                </Card>
            ) : null}
        </div>
    );
}
