"use client";

/**
 * The workbench's three writes that are not a statement somebody typed: a new
 * table, a new row, and removing picked rows.
 *
 * Each form checks itself against the schema the server checks with
 * (`row-edit-schema.ts`) as it is filled in, and an empty field is unfinished
 * rather than wrong - the button waits instead of the form shouting. What a
 * request turns into is decided on the server (`row-edit.ts`); nothing here
 * builds a statement.
 */

import { Plus, Trash2 } from "lucide-react";
import { dataText } from "@/lib/data/words";
import { useDataSource } from "./data-source";
import type { DataColumn } from "@/lib/data/driver";
import { useMemo, useState, type FormEvent } from "react";
import { tableDraftSchema } from "@/lib/data/row-edit-schema";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    TABLE_TYPES,
    expressionsFor,
    isAutoType,
    type ColumnDraft,
    type DefaultExpression,
    type TableType
} from "@/lib/data/row-edit";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** A column as the form holds it: the default split into what the selector says
 *  and what is typed beside it. */
interface ColumnRow {
    readonly id: number;
    name: string;
    type: TableType;
    nullable: boolean;
    primaryKey: boolean;
    unique: boolean;
    /** "none", "value", or one of the expressions. */
    fallback: string;
    value: string;
}

let nextRow = 1;

function idColumn(): ColumnRow {
    return {
        id: nextRow++,
        name: "id",
        type: "bigserial",
        nullable: false,
        primaryKey: true,
        unique: false,
        fallback: "none",
        value: ""
    };
}

function blankColumn(): ColumnRow {
    return {
        id: nextRow++,
        name: "",
        type: "text",
        nullable: true,
        primaryKey: false,
        unique: false,
        fallback: "none",
        value: ""
    };
}

function toDraft(row: ColumnRow): ColumnDraft {
    return {
        name: row.name,
        type: row.type,
        nullable: row.nullable,
        primaryKey: row.primaryKey,
        unique: row.unique,
        defaultValue:
            row.fallback === "value"
                ? { kind: "value", value: row.value }
                : row.fallback === "none"
                  ? { kind: "none" }
                  : { kind: "expression", expression: row.fallback as DefaultExpression }
    };
}

export function NewTableDialog({
    open,
    onOpenChange,
    namespace,
    onCreated
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    namespace: string | null;
    onCreated: (name: string) => void;
}) {
    const t = useTranslations("databases");
    const source = useDataSource();
    const [name, setName] = useState("");
    const [columns, setColumns] = useState<ColumnRow[]>(() => [idColumn(), blankColumn()]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const draft = useMemo(
        () => ({ namespace, name: name.trim(), columns: columns.map(toDraft) }),
        [namespace, name, columns]
    );
    const parsed = useMemo(() => tableDraftSchema.safeParse(draft), [draft]);
    /** Each problem by where it is, shown only once that field has something in it. */
    const issues = useMemo(() => {
        const found = new Map<string, string>();
        if (parsed.success) return found;
        for (const issue of parsed.error.issues) {
            const at = issue.path.join(".");
            if (!found.has(at)) found.set(at, dataText(t, issue.message));
        }
        return found;
    }, [parsed, t]);
    const incomplete = !name.trim() || columns.some((column) => !column.name.trim());

    function update(id: number, change: Partial<ColumnRow>) {
        setColumns((current) =>
            current.map((column) => {
                if (column.id !== id) return column;
                const next = { ...column, ...change };
                // A default that no longer fits the type is cleared rather than
                // kept as a refusal waiting to happen.
                if (isAutoType(next.type)) next.fallback = "none";
                else if (
                    next.fallback !== "none" &&
                    next.fallback !== "value" &&
                    !expressionsFor(next.type).includes(next.fallback as DefaultExpression)
                ) {
                    next.fallback = "none";
                }
                if (next.primaryKey) next.nullable = false;
                return next;
            })
        );
    }

    function reset() {
        setName("");
        setColumns([idColumn(), blankColumn()]);
        setError("");
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!parsed.success || saving) return;
        setSaving(true);
        setError("");
        const result = await source.createTable(parsed.data);
        setSaving(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        const created = parsed.data.name;
        reset();
        onOpenChange(false);
        onCreated(created);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) reset();
                onOpenChange(next);
            }}
        >
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t("newTable.title")}</DialogTitle>
                    <DialogDescription>
                        {namespace
                            ? t("newTable.inSchema", { schema: namespace })
                            : t("newTable.description")}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-4"
                    onSubmit={(event) => void submit(event)}
                >
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">
                            {t("newTable.name")} <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            value={name}
                            autoFocus
                            placeholder="orders"
                            onChange={(event) => setName(event.target.value)}
                            aria-invalid={Boolean(name.trim() && issues.get("name"))}
                        />
                        {name.trim() && issues.get("name") ? (
                            <span className="text-xs text-danger">{issues.get("name")}</span>
                        ) : null}
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">{t("newTable.columns")}</span>
                        <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
                            {columns.map((column, index) => {
                                const nameIssue = column.name.trim()
                                    ? issues.get(`columns.${index}.name`)
                                    : undefined;
                                const auto = isAutoType(column.type);
                                return (
                                    <div
                                        key={column.id}
                                        className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
                                    >
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
                                            <Input
                                                value={column.name}
                                                placeholder={t("newTable.columnName")}
                                                aria-label={t("newTable.columnName")}
                                                aria-invalid={Boolean(nameIssue)}
                                                onChange={(event) =>
                                                    update(column.id, { name: event.target.value })
                                                }
                                            />
                                            <Select
                                                value={column.type}
                                                aria-label={t("newTable.type")}
                                                onValueChange={(type) =>
                                                    update(column.id, { type: type as TableType })
                                                }
                                                options={TABLE_TYPES.map((type) => ({
                                                    value: type,
                                                    label: t(`newTable.types.${type}`)
                                                }))}
                                            />
                                            <Select
                                                value={column.fallback}
                                                disabled={auto}
                                                aria-label={t("newTable.default")}
                                                onValueChange={(fallback) =>
                                                    update(column.id, { fallback })
                                                }
                                                options={[
                                                    {
                                                        value: "none",
                                                        label: auto
                                                            ? t("newTable.defaults.auto")
                                                            : t("newTable.defaults.none")
                                                    },
                                                    {
                                                        value: "value",
                                                        label: t("newTable.defaults.value")
                                                    },
                                                    ...expressionsFor(column.type).map(
                                                        (expression) => ({
                                                            value: expression,
                                                            label: t(
                                                                `newTable.defaults.${expression}`
                                                            )
                                                        })
                                                    )
                                                ]}
                                            />
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                title={t("newTable.removeColumn")}
                                                aria-label={t("newTable.removeColumn")}
                                                disabled={columns.length === 1}
                                                onClick={() =>
                                                    setColumns((current) =>
                                                        current.filter(
                                                            (entry) => entry.id !== column.id
                                                        )
                                                    )
                                                }
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                        {column.fallback === "value" ? (
                                            <Input
                                                value={column.value}
                                                placeholder={t("newTable.defaultValue")}
                                                aria-label={t("newTable.defaultValue")}
                                                onChange={(event) =>
                                                    update(column.id, { value: event.target.value })
                                                }
                                            />
                                        ) : null}
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                            <label className="flex items-center gap-1.5">
                                                <Checkbox
                                                    checked={column.primaryKey}
                                                    onChange={(event) =>
                                                        update(column.id, {
                                                            primaryKey: event.target.checked
                                                        })
                                                    }
                                                />
                                                {t("newTable.primaryKey")}
                                            </label>
                                            <label className="flex items-center gap-1.5">
                                                <Checkbox
                                                    checked={column.nullable && !column.primaryKey}
                                                    disabled={column.primaryKey}
                                                    onChange={(event) =>
                                                        update(column.id, {
                                                            nullable: event.target.checked
                                                        })
                                                    }
                                                />
                                                {t("newTable.nullable")}
                                            </label>
                                            <label className="flex items-center gap-1.5">
                                                <Checkbox
                                                    checked={column.unique && !column.primaryKey}
                                                    disabled={column.primaryKey}
                                                    onChange={(event) =>
                                                        update(column.id, {
                                                            unique: event.target.checked
                                                        })
                                                    }
                                                />
                                                {t("newTable.unique")}
                                            </label>
                                        </div>
                                        {nameIssue ? (
                                            <span className="text-xs text-danger">{nameIssue}</span>
                                        ) : null}
                                        {(() => {
                                            const other = [...issues.entries()].find(
                                                ([at]) =>
                                                    at.startsWith(`columns.${index}.`) &&
                                                    at !== `columns.${index}.name`
                                            );
                                            return other &&
                                                (column.fallback !== "value" || column.value) ? (
                                                <span className="text-xs text-danger">
                                                    {other[1]}
                                                </span>
                                            ) : null;
                                        })()}
                                    </div>
                                );
                            })}
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="self-start"
                            onClick={() => setColumns((current) => [...current, blankColumn()])}
                        >
                            <Plus className="size-4" />
                            {t("newTable.addColumn")}
                        </Button>
                    </div>

                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("newTable.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={incomplete || !parsed.success || saving}
                            disabled={saving}
                            className={incomplete || !parsed.success ? "opacity-60" : undefined}
                        >
                            {saving ? t("newTable.creating") : t("newTable.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** One field of a new row: left alone, a value, or SQL NULL. */
interface FieldState {
    mode: "default" | "value" | "null";
    value: string;
}

export function NewRowDialog({
    open,
    onOpenChange,
    namespace,
    relation,
    columns,
    onAdded
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    namespace: string | null;
    relation: string;
    columns: readonly DataColumn[];
    onAdded: () => void;
}) {
    const t = useTranslations("databases");
    const source = useDataSource();
    const [fields, setFields] = useState<Record<string, FieldState>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    function field(name: string): FieldState {
        return fields[name] ?? { mode: "default", value: "" };
    }

    function set(name: string, next: FieldState) {
        setFields((current) => ({ ...current, [name]: next }));
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (saving) return;
        const values: Record<string, string | null> = {};
        for (const column of columns) {
            const state = field(column.name);
            if (state.mode === "null") values[column.name] = null;
            else if (state.mode === "value") values[column.name] = state.value;
        }
        setSaving(true);
        setError("");
        const result = await source.insertRow({ namespace, relation, values });
        setSaving(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setFields({});
        onOpenChange(false);
        onAdded();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setFields({});
                    setError("");
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t("newRow.title", { table: relation })}</DialogTitle>
                    <DialogDescription>{t("newRow.description")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => void submit(event)}
                >
                    <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto overscroll-contain pr-1">
                        {columns.map((column) => {
                            const state = field(column.name);
                            return (
                                <label
                                    key={column.name}
                                    className="flex min-w-0 flex-col gap-1 text-sm"
                                >
                                    <span className="flex min-w-0 items-baseline gap-2">
                                        <span className="truncate font-medium" title={column.name}>
                                            {column.name}
                                        </span>
                                        <span className="truncate font-mono text-xs text-muted-foreground">
                                            {column.type}
                                        </span>
                                        {column.primaryKey ? (
                                            <span className="text-xs text-muted-foreground">
                                                {t("newRow.key")}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <Input
                                            className="font-mono"
                                            value={state.mode === "value" ? state.value : ""}
                                            disabled={state.mode === "null"}
                                            placeholder={
                                                state.mode === "null" ? "NULL" : t("newRow.default")
                                            }
                                            onChange={(event) =>
                                                set(column.name, {
                                                    mode:
                                                        event.target.value === ""
                                                            ? "default"
                                                            : "value",
                                                    value: event.target.value
                                                })
                                            }
                                        />
                                        {column.nullable ? (
                                            <span className="flex shrink-0 items-center gap-1.5 text-xs">
                                                <Checkbox
                                                    checked={state.mode === "null"}
                                                    aria-label={t("newRow.nullFor", {
                                                        column: column.name
                                                    })}
                                                    onChange={(event) =>
                                                        set(column.name, {
                                                            mode: event.target.checked
                                                                ? "null"
                                                                : "default",
                                                            value: ""
                                                        })
                                                    }
                                                />
                                                NULL
                                            </span>
                                        ) : null}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("newTable.cancel")}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? t("newRow.adding") : t("newRow.add")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Removing the picked rows, confirmed in words that say how many and from where. */
export function DeleteRowsDialog({
    open,
    onOpenChange,
    namespace,
    relation,
    keys,
    onDeleted
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    namespace: string | null;
    relation: string;
    keys: readonly Record<string, unknown>[];
    onDeleted: (changed: number) => void;
}) {
    const t = useTranslations("databases");
    const source = useDataSource();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function confirm() {
        setPending(true);
        setError(null);
        const result = await source.deleteRows({ namespace, relation, keys: [...keys] });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onDeleted(result.changed ?? 0);
    }

    return (
        <ConfirmDeleteDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) setError(null);
                onOpenChange(next);
            }}
            name={relation}
            requireTyping={false}
            kind={t("deleteRows.kind")}
            title={t("deleteRows.title", { count: keys.length })}
            question={t("deleteRows.question", { count: keys.length, table: relation })}
            description={t("deleteRows.description")}
            confirmLabel={t("deleteRows.confirm", { count: keys.length })}
            error={error}
            pending={pending}
            onConfirm={() => void confirm()}
        />
    );
}
