"use client";

/**
 * Records from a CSV file: pick the file, say which field each column goes to,
 * see which rows will be refused and why, then import the rest in batches with
 * the progress on screen. The rows are checked here with the same rules the
 * server applies again, so the preview is what the import does.
 */

import { useCrmT } from "./i18n";
import { Upload } from "lucide-react";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/records";
import { useMemo, useState } from "react";
import { fieldLabel, useCustomFields } from "./custom-fields";
import { fieldsOf, primaryField, type CrmObject, type FieldDef } from "../model/objects";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    useToast
} from "@polaris/ui";
import {
    batches,
    checkRow,
    guessMapping,
    MAX_IMPORT_BYTES,
    MAX_IMPORT_COLUMNS,
    MAX_IMPORT_ROWS,
    parseCsv,
    type RowProblem
} from "../model/import";
import { hostUi } from "@polaris/app-host/client";

const { useChooseFiles } = hostUi.filePicker;

/** The value of the "do not import" choice. */
const SKIP = "__skip";

/** How many problem rows are listed before "and N more". */
const SHOWN_PROBLEMS = 20;

interface Loaded {
    readonly header: string[];
    readonly rows: string[][];
}

interface Finished {
    readonly created: number;
    readonly failed: { readonly row: number; readonly problems: RowProblem[] }[];
}

export interface ImportDialogProps {
    readonly object: CrmObject;
    readonly open: boolean;
    readonly onClose: () => void;
    /** Some records were made: the list should read them. */
    readonly onImported: () => void;
}

export function ImportDialog(props: ImportDialogProps) {
    const { object, open } = props;
    const t = useCrmT();
    const toast = useToast();
    const custom = useCustomFields();
    const [chooseFiles, chooser] = useChooseFiles();
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [mapping, setMapping] = useState<(string | null)[]>([]);
    const [fileError, setFileError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [finished, setFinished] = useState<Finished | null>(null);
    const [dragging, setDragging] = useState(false);
    const [skipDuplicates, setSkipDuplicates] = useState(true);

    const fields = useMemo(
        () => fieldsOf(object, custom).filter((field) => !field.readOnly),
        [object, custom]
    );
    const labelOf = (field: FieldDef) => fieldLabel(t, object, field);
    const primary = primaryField(object);
    const size = MAX_IMPORT_BYTES / 1024 / 1024;

    const reset = () => {
        setLoaded(null);
        setMapping([]);
        setFileError(null);
        setProgress(null);
        setFinished(null);
    };

    const read = async (file: File) => {
        setFileError(null);
        if (!/\.(csv|txt)$/i.test(file.name) && file.type !== "text/csv") {
            setFileError(t("import.notCsv"));
            return;
        }
        if (file.size > MAX_IMPORT_BYTES) {
            setFileError(t("import.tooBig", { size }));
            return;
        }
        const parsed = parseCsv(await file.text());
        if (!parsed.ok) {
            setFileError(
                t(`import.${parsed.reason}`, { rows: MAX_IMPORT_ROWS, columns: MAX_IMPORT_COLUMNS })
            );
            return;
        }
        setLoaded({ header: parsed.header, rows: parsed.rows });
        setMapping(guessMapping(parsed.header, fields, labelOf));
    };

    const columns = useMemo(
        () => mapping.map((key) => fields.find((field) => field.key === key) ?? null),
        [mapping, fields]
    );
    const checked = useMemo(
        () => (loaded ? loaded.rows.map((cells) => checkRow(columns, cells, primary)) : []),
        [loaded, columns, primary]
    );
    const problemRows = checked.flatMap((row, index) =>
        row.problems.length > 0 ? [{ row: index, problems: row.problems }] : []
    );
    const readyCount = checked.length - problemRows.length;
    const hasName = columns.some((field) => field?.key === primary.key);

    const describe = (problem: RowProblem): string => {
        const field = fields.find((one) => one.key === problem.key);
        return `${field ? labelOf(field) : problem.key}: ${t(`invalid.${problem.reason}`)}`;
    };

    const start = async () => {
        if (!loaded) return;
        // Only the rows the preview passed, and only the mapped columns of each.
        const kept = mapping.flatMap((key, index) => (key === null ? [] : [index]));
        const good = loaded.rows
            .map((cells, index) => ({ cells, index }))
            .filter((_, index) => checked[index]!.problems.length === 0);
        const total = good.length;
        let created = 0;
        const failed: Finished["failed"] = problemRows.map((one) => ({ ...one }));
        setProgress({ done: 0, total });
        try {
            for (const batch of batches(good)) {
                const answer = await unwrap(
                    () =>
                        actions.importRecordsAction({
                            object,
                            mapping: kept.map((index) => mapping[index]),
                            rows: batch.map(({ cells }) => kept.map((index) => cells[index] ?? "")),
                            skipDuplicates
                        }),
                    t("errors.generic")
                );
                created += answer.created;
                for (const one of answer.failed) {
                    failed.push({ row: batch[one.row]!.index, problems: one.problems });
                }
                setProgress((before) => ({ done: (before?.done ?? 0) + batch.length, total }));
            }
            failed.sort((a, b) => a.row - b.row);
            setFinished({ created, failed });
            toast.show({ title: t("import.done", { count: created }) });
        } catch (caught) {
            toast.show({ title: t("import.failed", { count: created }), body: messageOf(caught) });
            setFinished({ created, failed });
        } finally {
            setProgress(null);
            if (created > 0) props.onImported();
        }
    };

    const close = () => {
        if (progress) return;
        reset();
        props.onClose();
    };

    const problemList = (rows: Finished["failed"]) => (
        <ul className="flex max-h-48 min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain text-[0.8125rem]">
            {rows.slice(0, SHOWN_PROBLEMS).map((one) => (
                <li key={one.row} className="min-w-0">
                    <span className="font-medium tabular-nums">
                        {/* The header is line 1 of the file. */}
                        {t("import.row", { row: one.row + 2 })}
                    </span>{" "}
                    <span className="break-words text-muted-foreground">
                        {one.problems.map(describe).join(" - ")}
                    </span>
                </li>
            ))}
            {rows.length > SHOWN_PROBLEMS ? (
                <li className="text-muted-foreground">
                    {t("import.moreProblems", { count: rows.length - SHOWN_PROBLEMS })}
                </li>
            ) : null}
        </ul>
    );

    let body: React.ReactNode;
    if (finished) {
        body = (
            <div className="flex flex-col gap-3">
                <p className="text-sm font-medium">
                    {t("import.done", { count: finished.created })}
                </p>
                {finished.failed.length > 0 ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {t("import.skipped", { count: finished.failed.length })}
                        </p>
                        {problemList(finished.failed)}
                    </>
                ) : null}
            </div>
        );
    } else if (!loaded) {
        body = (
            <div className="flex flex-col gap-2">
                <button
                    type="button"
                    onClick={() =>
                        void chooseFiles({ accept: ".csv,text/csv", onFailed: setFileError }).then(
                            (files) => {
                                if (files[0]) void read(files[0]);
                            }
                        )
                    }
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void read(file);
                    }}
                    className={`flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center ${
                        dragging ? "border-primary bg-muted" : "border-border-strong"
                    }`}
                >
                    <Upload className="size-5 text-muted-foreground" />
                    <span className="text-sm font-medium">{t("import.choose")}</span>
                    <span className="text-[0.8125rem] text-muted-foreground">
                        {t("import.drop", { rows: MAX_IMPORT_ROWS, size })}
                    </span>
                </button>
                {chooser}
                {fileError ? (
                    <p role="alert" className="text-[0.8125rem] text-destructive">
                        {fileError}
                    </p>
                ) : null}
            </div>
        );
    } else {
        const options = [
            { value: SKIP, label: t("import.skip") },
            ...fields.map((field) => ({ value: field.key, label: labelOf(field) }))
        ];
        body = (
            <div className="flex min-w-0 flex-col gap-3">
                <div className="max-h-72 min-h-0 overflow-y-auto overscroll-contain">
                    <table className="w-full table-fixed text-[0.8125rem]">
                        <thead>
                            <tr className="text-left text-muted-foreground">
                                <th className="w-1/3 py-1 pr-2 font-medium">
                                    {t("import.column")}
                                </th>
                                <th className="hidden w-1/3 py-1 pr-2 font-medium sm:table-cell">
                                    {t("import.sample")}
                                </th>
                                <th className="py-1 font-medium">{t("import.field")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loaded.header.map((name, index) => (
                                <tr key={index}>
                                    <td className="truncate py-1 pr-2" title={name}>
                                        {name || "-"}
                                    </td>
                                    <td
                                        className="hidden truncate py-1 pr-2 text-muted-foreground sm:table-cell"
                                        title={loaded.rows[0]?.[index] ?? ""}
                                    >
                                        {loaded.rows[0]?.[index] ?? ""}
                                    </td>
                                    <td className="min-w-0 py-1">
                                        <Select
                                            aria-label={name}
                                            value={mapping[index] ?? SKIP}
                                            onValueChange={(value) =>
                                                setMapping((before) =>
                                                    before.map((key, at) => {
                                                        if (at === index)
                                                            return value === SKIP ? null : value;
                                                        // A field takes one column: the old one lets go.
                                                        return key === value ? null : key;
                                                    })
                                                )
                                            }
                                            options={options}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {hasName ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm font-medium">
                            {t("import.ready", { count: readyCount })}
                        </p>
                        {problemRows.length > 0 ? (
                            <>
                                <p className="text-sm text-muted-foreground">
                                    {t("import.problems", { count: problemRows.length })}
                                </p>
                                {problemList(problemRows)}
                            </>
                        ) : null}
                        {columns.some(
                            (field) => field?.kind === "relation" || field?.kind === "member"
                        ) ? (
                            <p className="text-[0.8125rem] text-muted-foreground">
                                {t("import.refsChecked")}
                            </p>
                        ) : null}
                        <label className="flex min-w-0 items-start gap-2 text-[0.8125rem]">
                            <Checkbox
                                checked={skipDuplicates}
                                onChange={(event) => setSkipDuplicates(event.target.checked)}
                            />
                            <span className="min-w-0">
                                <span className="block">{t("import.skipDuplicates")}</span>
                                <span className="block text-muted-foreground">
                                    {t("import.skipDuplicatesHint")}
                                </span>
                            </span>
                        </label>
                    </div>
                ) : (
                    <p role="alert" className="text-[0.8125rem] text-destructive">
                        {t("import.needsName", { field: labelOf(primary) })}
                    </p>
                )}
                {progress ? (
                    <div className="flex flex-col gap-1" aria-live="polite">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-full bg-primary transition-[width]"
                                style={{
                                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`
                                }}
                            />
                        </div>
                        <p className="text-[0.8125rem] tabular-nums text-muted-foreground">
                            {t("import.progress", { done: progress.done, total: progress.total })}
                        </p>
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {t("import.title", { objects: t(`objects.${object}.plural`) })}
                    </DialogTitle>
                    <DialogDescription>{t("import.hint")}</DialogDescription>
                </DialogHeader>
                {body}
                <DialogFooter>
                    {finished ? (
                        <Button onClick={close}>{t("import.close")}</Button>
                    ) : loaded ? (
                        <>
                            <Button variant="ghost" disabled={progress !== null} onClick={reset}>
                                {t("import.back")}
                            </Button>
                            <Button
                                disabled={progress !== null || !hasName || readyCount === 0}
                                onClick={() => void start()}
                            >
                                {t("import.start", { count: readyCount })}
                            </Button>
                        </>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
