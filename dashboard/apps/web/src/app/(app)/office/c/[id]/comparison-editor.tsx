"use client";

/**
 * Competitors, and the things that actually matter, in a table several people
 * can fill in at once.
 *
 * Why this is its own kind rather than a spreadsheet is `comparison.ts` in
 * @polaris/core, and the short version is that a cell here is not a number - it
 * is a claim, the evidence for it, where to check, and when somebody last did.
 * What this file adds is the one thing a screen can add to that: **it says how
 * old every claim is, right there in the table.** A comparison whose numbers are
 * from last March, presented as current, is worse than no comparison at all.
 *
 * Rows are criteria and columns are competitors, which is the way round these
 * are read: a person opens one to answer "how do we compare on price", and that
 * is a row.
 *
 * Everything is stored in the shared document, so two people filling in
 * different rows is two independent changes - see `use-office-document`.
 */

import * as Y from "yjs";
import * as core from "@polaris/core";
import { useDisplayFormat } from "@/components/display-format";
import { useOfficeDocument } from "@/app/(app)/office/use-office-document";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { CircleAlert, Link2, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";

/** Where each half of the table lives in the shared document. */
const SUBJECTS = "subjects";
const CRITERIA = "criteria";
const CELLS = "cells";

export function ComparisonEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}) {
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const subjects = useMemo(() => doc.getArray<core.Subject>(SUBJECTS), [doc]);
    const criteria = useMemo(() => doc.getArray<core.Criterion>(CRITERIA), [doc]);
    const cells = useMemo(() => doc.getMap<core.Cell>(CELLS), [doc]);

    // Redrawn whenever the document moves, from wherever. `useSyncExternalStore`
    // rather than a state mirror: the document is the state, and a copy of it in
    // React is a second thing to keep in step.
    const version = useDocumentVersion(doc);
    const columns = useMemo(() => subjects.toArray(), [subjects, version]);
    const rows = useMemo(
        // Heaviest first, so what matters most is what somebody reads first.
        () => [...criteria.toArray()].sort((left, right) => right.weight - left.weight),
        [criteria, version]
    );

    const [editing, setEditing] = useState<{ subjectId: string; criterionId: string } | null>(null);

    const cellOf = useCallback(
        (subjectId: string, criterionId: string): core.Cell =>
            cells.get(core.cellKey(subjectId, criterionId)) ?? core.EMPTY_CELL,
        [cells, version]
    );

    return (
        <div className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
                {columns.length === 0 && rows.length === 0 ? (
                    <Empty editable={editable} onStart={() => seed(doc)} />
                ) : (
                    /* Its own scroller: a comparison of nine competitors is wider
                       than any screen, and a table that widened the page would
                       take the whole app sideways with it. */
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[40rem] border-collapse text-[13px]">
                            <thead>
                                <tr className="border-b border-border bg-surface">
                                    <th className="sticky left-0 z-10 min-w-48 bg-surface px-3 py-2 text-left font-medium">
                                        Criterion
                                    </th>
                                    {columns.map((subject) => (
                                        <th
                                            key={subject.id}
                                            className={cn(
                                                "min-w-40 px-3 py-2 text-left font-medium",
                                                // The column that is ours reads
                                                // differently, because the gap is
                                                // the point of the exercise.
                                                subject.us && "bg-primary/5 text-foreground"
                                            )}
                                        >
                                            <span className="flex items-center gap-1.5">
                                                {subject.url ? (
                                                    <a
                                                        href={subject.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer nofollow"
                                                        className="truncate hover:underline"
                                                    >
                                                        {subject.name}
                                                    </a>
                                                ) : (
                                                    <span className="truncate" title={subject.name}>{subject.name}</span>
                                                )}
                                                {subject.us ? <Badge variant="primary">Us</Badge> : null}
                                                {editable ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="ml-auto"
                                                        aria-label={`Remove ${subject.name}`}
                                                        title="Remove"
                                                        onClick={() => removeSubject(doc, subject.id)}
                                                    >
                                                        <Trash2 className="size-3.5 shrink-0" aria-hidden />
                                                    </Button>
                                                ) : null}
                                            </span>
                                        </th>
                                    ))}
                                    {editable ? (
                                        <th className="w-10 px-2 py-2">
                                            <AddSubject doc={doc} />
                                        </th>
                                    ) : null}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((criterion) => (
                                    <tr key={criterion.id} className="border-b border-border/60">
                                        <th
                                            scope="row"
                                            className="sticky left-0 z-10 bg-background px-3 py-2 text-left align-top font-normal"
                                        >
                                            <span className="block truncate font-medium">
                                                {criterion.name}
                                            </span>
                                            <span className="block text-[12px] text-muted-foreground">
                                                {core.CRITERION_KIND_LABELS[criterion.kind]}
                                                {criterion.note ? ` - ${criterion.note}` : ""}
                                            </span>
                                        </th>
                                        {columns.map((subject) => (
                                            <CellBox
                                                key={subject.id}
                                                cell={cellOf(subject.id, criterion.id)}
                                                kind={criterion.kind}
                                                editable={editable}
                                                onOpen={() =>
                                                    setEditing({
                                                        subjectId: subject.id,
                                                        criterionId: criterion.id
                                                    })
                                                }
                                            />
                                        ))}
                                        {editable ? (
                                            <td className="px-2 py-2 align-top">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Remove ${criterion.name}`}
                                                    title="Remove"
                                                    onClick={() => removeCriterion(doc, criterion.id)}
                                                >
                                                    <Trash2 className="size-3.5 shrink-0" aria-hidden />
                                                </Button>
                                            </td>
                                        ) : null}
                                    </tr>
                                ))}
                                {editable ? (
                                    <tr>
                                        <td className="px-3 py-2" colSpan={columns.length + 2}>
                                            <AddCriterion doc={doc} />
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {editing ? (
                <CellDialog
                    doc={doc}
                    subject={columns.find((one) => one.id === editing.subjectId) ?? null}
                    criterion={rows.find((one) => one.id === editing.criterionId) ?? null}
                    cell={cellOf(editing.subjectId, editing.criterionId)}
                    onClose={() => setEditing(null)}
                />
            ) : null}
        </div>
    );
}

/** One answer, with how old it is said beside it. */
function CellBox({
    cell,
    kind,
    editable,
    onOpen
}: {
    cell: core.Cell;
    kind: core.CriterionKind;
    editable: boolean;
    onOpen: () => void;
}) {
    const format = useDisplayFormat();
    const read = core.cellReads(cell, kind);
    const stale = core.isStale(cell.checkedAt);
    return (
        <td className="px-3 py-2 align-top">
            <button
                type="button"
                disabled={!editable}
                onClick={onOpen}
                className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                    editable && "hover:bg-surface-hover",
                    !editable && "cursor-default"
                )}
            >
                {read ? (
                    <span className="block truncate" title={read}>{read}</span>
                ) : (
                    <span className="block text-muted-foreground">Not answered</span>
                )}
                {cell.evidence ? (
                    <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                        {cell.evidence}
                    </span>
                ) : null}
                {/* The two things a spreadsheet cannot say. Unchecked and out of
                    date are different facts and they are said differently: one is
                    "nobody has looked", the other is "somebody looked, a while
                    ago". */}
                {read && !cell.checkedAt ? (
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <CircleAlert className="size-3 shrink-0" aria-hidden />
                        Nobody has checked this
                    </span>
                ) : null}
                {stale ? (
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-warning">
                        <TriangleAlert className="size-3 shrink-0" aria-hidden />
                        Checked {format.date(new Date(cell.checkedAt))}
                    </span>
                ) : null}
                {cell.source ? (
                    <span className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                        <Link2 className="size-3 shrink-0" aria-hidden />
                        {sourceReads(cell.source)}
                    </span>
                ) : null}
            </button>
        </td>
    );
}

/** The four fields, on one form. Filling in a claim and filling in why anybody
 *  believes it are the same act, and splitting them is how the evidence column
 *  ends up empty. */
function CellDialog({
    doc,
    subject,
    criterion,
    cell,
    onClose
}: {
    doc: Y.Doc;
    subject: core.Subject | null;
    criterion: core.Criterion | null;
    cell: core.Cell;
    onClose: () => void;
}) {
    const toast = useToast();
    const [value, setValue] = useState(cell.value);
    const [evidence, setEvidence] = useState(cell.evidence);
    const [source, setSource] = useState(cell.source);
    if (!subject || !criterion) return null;

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {subject.name} - {criterion.name}
                    </DialogTitle>
                    <DialogDescription>
                        {criterion.note || core.CRITERION_KIND_HINTS[criterion.kind]}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                        The answer
                        <Answer kind={criterion.kind} value={value} onChange={setValue} />
                    </label>
                    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                        Why - what you actually saw
                        <Textarea
                            rows={3}
                            value={evidence}
                            placeholder="Their pricing page lists it at £35 a seat"
                            onChange={(event) => setEvidence(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                        Where to check
                        <Input
                            value={source}
                            placeholder="https://"
                            onChange={(event) => setSource(event.target.value)}
                        />
                    </label>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => {
                                const parsed = core.cellSchema.safeParse({
                                    value,
                                    evidence,
                                    source,
                                    // Saving IS checking. The date is not a field
                                    // somebody has to remember to change, which is
                                    // exactly how it ends up wrong.
                                    checkedAt: new Date().toISOString()
                                });
                                if (!parsed.success) {
                                    toast.show({
                                        title: parsed.error.issues[0]?.message ?? "That did not save"
                                    });
                                    return;
                                }
                                doc
                                    .getMap<core.Cell>(CELLS)
                                    .set(core.cellKey(subject.id, criterion.id), parsed.data);
                                onClose();
                            }}
                        >
                            Save
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The field the answer is given in, which is the whole reason a criterion has a
 *  kind: a rating people type by hand is a rating nobody can compare. */
function Answer({
    kind,
    value,
    onChange
}: {
    kind: core.CriterionKind;
    value: string;
    onChange: (next: string) => void;
}) {
    if (kind === "rating") {
        return (
            <Select
                value={value}
                aria-label="Rating"
                placeholder="Pick one"
                onValueChange={onChange}
                options={core.RATING_SCALE.map((score) => ({
                    value: String(score),
                    label: core.RATING_LABELS[score] ?? String(score)
                }))}
            />
        );
    }
    if (kind === "yesNo") {
        return (
            <Select
                value={value}
                aria-label="Yes or no"
                placeholder="Pick one"
                onValueChange={onChange}
                options={core.YES_NO_ANSWERS.map((one) => ({
                    value: one,
                    label: core.YES_NO_LABELS[one]
                }))}
            />
        );
    }
    return <Input value={value} onChange={(event) => onChange(event.target.value)} />;
}

function AddSubject({ doc }: { doc: Y.Doc }) {
    const [name, setName] = useState("");
    const [open, setOpen] = useState(false);
    if (!open) {
        return (
            <Button
                variant="ghost"
                size="icon"
                aria-label="Add a competitor"
                title="Add a competitor"
                onClick={() => setOpen(true)}
            >
                <Plus className="size-4 shrink-0" aria-hidden />
            </Button>
        );
    }
    const add = (): void => {
        const parsed = core.subjectSchema.safeParse({ name });
        if (!parsed.success) return;
        doc.getArray<core.Subject>(SUBJECTS).push([
            { id: crypto.randomUUID(), name: parsed.data.name, url: parsed.data.url, us: false }
        ]);
        setName("");
        setOpen(false);
    };
    return (
        <Input
            autoFocus
            value={name}
            placeholder="Competitor"
            aria-label="Competitor's name"
            className="w-40"
            onChange={(event) => setName(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => {
                if (event.key === "Enter") add();
                if (event.key === "Escape") setOpen(false);
            }}
        />
    );
}

function AddCriterion({ doc }: { doc: Y.Doc }) {
    const [name, setName] = useState("");
    const [kind, setKind] = useState<core.CriterionKind>("rating");
    const add = (): void => {
        const parsed = core.criterionSchema.safeParse({ name, kind });
        if (!parsed.success) return;
        doc.getArray<core.Criterion>(CRITERIA).push([
            {
                id: crypto.randomUUID(),
                name: parsed.data.name,
                kind: parsed.data.kind,
                note: parsed.data.note,
                weight: parsed.data.weight
            }
        ]);
        setName("");
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Input
                value={name}
                placeholder="What to compare on"
                aria-label="What to compare on"
                className="w-56"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && add()}
            />
            <Select
                value={kind}
                aria-label="What kind of answer"
                className="w-40"
                onValueChange={(next) => setKind(next as core.CriterionKind)}
                options={core.CRITERION_KINDS.map((one) => ({
                    value: one,
                    label: core.CRITERION_KIND_LABELS[one]
                }))}
            />
            <Button size="sm" variant="secondary" disabled={!name.trim()} onClick={add}>
                <Plus className="size-4 shrink-0" aria-hidden />
                Add
            </Button>
        </div>
    );
}

function Empty({ editable, onStart }: { editable: boolean; onStart: () => void }) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <p className="text-[13px] font-medium">Nothing to compare yet</p>
            <p className="max-w-md text-[13px] text-muted-foreground">
                Competitors go across, the things that matter go down, and every answer carries the
                evidence for it and the day somebody last checked.
            </p>
            {editable ? (
                <Button onClick={onStart}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    Start with the usual columns
                </Button>
            ) : null}
        </div>
    );
}

/** A first table rather than an empty one. Nobody starts a comparison from
 *  nothing, and these five are on every one anybody has ever made. */
function seed(doc: Y.Doc): void {
    doc.transact(() => {
        doc.getArray<core.Subject>(SUBJECTS).push([
            { id: crypto.randomUUID(), name: "Us", url: "", us: true },
            { id: crypto.randomUUID(), name: "Competitor", url: "", us: false }
        ]);
        doc.getArray<core.Criterion>(CRITERIA).push(
            [
                { name: "Price", kind: "money" as const, weight: 5 },
                { name: "The feature they lead with", kind: "text" as const, weight: 5 },
                { name: "Ease of setup", kind: "rating" as const, weight: 4 },
                { name: "Support", kind: "rating" as const, weight: 3 },
                { name: "Runs on your own machine", kind: "yesNo" as const, weight: 3 }
            ].map((one) => ({ id: crypto.randomUUID(), note: "", ...one }))
        );
    });
}

function removeSubject(doc: Y.Doc, subjectId: string): void {
    doc.transact(() => {
        const subjects = doc.getArray<core.Subject>(SUBJECTS);
        const at = subjects.toArray().findIndex((one) => one.id === subjectId);
        if (at >= 0) subjects.delete(at, 1);
        // And their answers with them, or the document keeps a column nobody can
        // see and every export grows a phantom.
        const cells = doc.getMap<core.Cell>(CELLS);
        for (const key of [...cells.keys()]) {
            if (key.startsWith(`${subjectId}::`)) cells.delete(key);
        }
    });
}

function removeCriterion(doc: Y.Doc, criterionId: string): void {
    doc.transact(() => {
        const criteria = doc.getArray<core.Criterion>(CRITERIA);
        const at = criteria.toArray().findIndex((one) => one.id === criterionId);
        if (at >= 0) criteria.delete(at, 1);
        const cells = doc.getMap<core.Cell>(CELLS);
        for (const key of [...cells.keys()]) {
            if (key.endsWith(`::${criterionId}`)) cells.delete(key);
        }
    });
}

/** A number that changes whenever the document does, so the table redraws. */
function useDocumentVersion(doc: Y.Doc): number {
    return useSyncExternalStore(
        useCallback(
            (onChange: () => void) => {
                doc.on("update", onChange);
                return () => doc.off("update", onChange);
            },
            [doc]
        ),
        () => doc.store.clients.size + Number(doc.store.pendingStructs?.update?.length ?? 0),
        () => 0
    );
}

/** A link, said as its site rather than as four hundred characters of query
 *  string. */
function sourceReads(source: string): string {
    try {
        return new URL(source).hostname.replace(/^www\./, "");
    } catch {
        return source;
    }
}
