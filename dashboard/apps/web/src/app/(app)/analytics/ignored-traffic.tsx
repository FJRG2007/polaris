"use client";

/**
 * What a site never records, as a list like the Firewall's and the network
 * filter's: each entry's kind as a chip, its value, and edit and delete beside
 * it. Several can be added at once from a pasted list. Each change is saved on
 * its own, shown at once and put back if the save fails.
 */

import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Textarea
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Kind = "path" | "ip";
type Rules = core.AnalyticsSiteSettings;
interface Entry {
    readonly kind: Kind;
    readonly value: string;
}

const FIELD: Record<Kind, keyof Rules> = { path: "excludedPaths", ip: "ignoredIps" };
/** The most either list holds, as the schema says. */
const LIST_MAX = 50;

/** Whether one value is a valid entry of this kind, by the schema the server checks. */
export function validEntry(kind: Kind, value: string): boolean {
    return core.analyticsSiteSettingsSchema.shape[FIELD[kind]].element.safeParse(value).success;
}

/** Splits a paste into entries: one per line, comma or space. */
export function splitEntries(text: string): string[] {
    return [...new Set(text.split(/[\s,]+/).map((one) => one.trim()).filter(Boolean))];
}

/** The rules with one change made, or the reason it cannot be. */
export function applyEntryChange(
    rules: Rules,
    change: { op: "add"; kind: Kind; values: readonly string[] } | { op: "edit"; from: Entry; value: string } | { op: "delete"; from: Entry }
): Rules | "duplicate" | "tooMany" {
    const next: Rules = { excludedPaths: [...rules.excludedPaths], ignoredIps: [...rules.ignoredIps] };
    if (change.op === "delete") {
        next[FIELD[change.from.kind]] = next[FIELD[change.from.kind]].filter((one) => one !== change.from.value);
        return next;
    }
    if (change.op === "edit") {
        const list = next[FIELD[change.from.kind]];
        if (change.value !== change.from.value && list.includes(change.value)) return "duplicate";
        next[FIELD[change.from.kind]] = list.map((one) => (one === change.from.value ? change.value : one));
        return next;
    }
    const list = next[FIELD[change.kind]];
    const fresh = change.values.filter((one) => !list.includes(one));
    if (fresh.length === 0) return "duplicate";
    if (list.length + fresh.length > LIST_MAX) return "tooMany";
    next[FIELD[change.kind]] = [...list, ...fresh];
    return next;
}

export function IgnoredTraffic({
    rules,
    canEdit,
    save
}: {
    rules: Rules;
    canEdit: boolean;
    /** Saves the whole set; resolves to an error, or null. */
    save: (next: Rules) => Promise<string | null>;
}) {
    const t = useTranslations("analytics");
    const [pending, setPending] = useState<Rules | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | Kind>("all");
    const [editing, setEditing] = useState<{ from: Entry | null } | null>(null);

    const current = pending ?? rules;
    const all = useMemo<Entry[]>(
        () => [
            ...current.excludedPaths.map((value) => ({ kind: "path" as const, value })),
            ...current.ignoredIps.map((value) => ({ kind: "ip" as const, value }))
        ],
        [current]
    );
    const needle = search.trim().toLowerCase();
    const rows = all.filter((row) => (filter === "all" || row.kind === filter) && (!needle || row.value.toLowerCase().includes(needle)));

    /** Shown at once, saved, and put back when the save fails. */
    async function commit(change: Parameters<typeof applyEntryChange>[1]): Promise<string | null> {
        const next = applyEntryChange(current, change);
        if (typeof next === "string") return t(`ignore.refusal.${next}`);
        setPending(next);
        setError(null);
        const failure = await save(next);
        setPending(null);
        if (failure) setError(failure);
        return failure;
    }

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <CardTitle className="text-sm">{t("site.ignoreTitle")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("site.ignoreIntro")}</p>
                </div>
                {canEdit ? (
                    <Button size="sm" onClick={() => setEditing({ from: null })}>
                        <Plus className="size-4 shrink-0" aria-hidden />
                        {t("ignore.add")}
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                {all.length > 0 ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative min-w-0 flex-1">
                            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input className="pl-8" value={search} placeholder={t("ignore.search")} aria-label={t("ignore.search")} onChange={(event) => setSearch(event.target.value)} />
                        </div>
                        <Select
                            className="w-full sm:w-40"
                            value={filter}
                            aria-label={t("ignore.filter")}
                            onValueChange={(value) => setFilter(value as "all" | Kind)}
                            options={[
                                { value: "all", label: t("ignore.filterAll") },
                                { value: "path", label: t("ignore.kind.path") },
                                { value: "ip", label: t("ignore.kind.ip") }
                            ]}
                        />
                    </div>
                ) : null}
                {error ? (
                    <p role="alert" className="text-xs text-danger-ink">
                        {error}
                    </p>
                ) : null}
                {all.length === 0 ? (
                    <EmptyState bare title={t("ignore.empty")} description={t("ignore.emptyHint")} />
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ignore.noMatch")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border" aria-label={t("site.ignoreTitle")}>
                        {rows.map((row) => (
                            <li key={`${row.kind}:${row.value}`} className="flex min-w-0 items-center gap-2 py-2">
                                <Badge variant="neutral" className="shrink-0">
                                    {t(`ignore.kind.${row.kind}`)}
                                </Badge>
                                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                    <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={row.value}>
                                        {row.value}
                                    </code>
                                    <span className="max-w-full truncate text-xs text-muted-foreground">{t(`ignore.covers.${coverage(row)}`, { value: coverValue(row) })}</span>
                                </span>
                                {canEdit ? (
                                    <>
                                        <Button size="sm" variant="ghost" aria-label={t("ignore.edit", { value: row.value })} title={t("ignore.edit", { value: row.value })} onClick={() => setEditing({ from: row })}>
                                            <Pencil className="size-4 shrink-0" aria-hidden />
                                        </Button>
                                        <Button size="sm" variant="ghost" aria-label={t("ignore.remove", { value: row.value })} title={t("ignore.remove", { value: row.value })} onClick={() => void commit({ op: "delete", from: row })}>
                                            <Trash2 className="size-4 shrink-0" aria-hidden />
                                        </Button>
                                    </>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
                {!canEdit ? <p className="text-xs text-muted-foreground">{t("site.viewOnly")}</p> : null}
            </CardBody>
            {editing ? (
                <EntryDialog
                    from={editing.from}
                    onClose={() => setEditing(null)}
                    onSubmit={(kind, values) =>
                        commit(editing.from ? { op: "edit", from: editing.from, value: values[0]! } : { op: "add", kind, values })
                    }
                />
            ) : null}
        </Card>
    );
}

function coverage(row: Entry): "prefix" | "page" | "range" | "address" {
    if (row.kind === "path") return row.value.endsWith("*") ? "prefix" : "page";
    return row.value.includes("/") ? "range" : "address";
}

function coverValue(row: Entry): string {
    return row.kind === "path" && row.value.endsWith("*") ? row.value.slice(0, -1) : row.value;
}

/** Adding entries or editing one, checked as it is typed against the schema the
 *  server checks it with. Adding takes several at once. */
function EntryDialog({
    from,
    onClose,
    onSubmit
}: {
    from: Entry | null;
    onClose: () => void;
    onSubmit: (kind: Kind, values: string[]) => Promise<string | null>;
}) {
    const t = useTranslations("analytics");
    const [kind, setKind] = useState<Kind>(from?.kind ?? "path");
    const [text, setText] = useState(from?.value ?? "");
    const [refusal, setRefusal] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const values = from ? (text.trim() ? [text.trim()] : []) : splitEntries(text);
    const bad = values.filter((one) => !validEntry(kind, one));
    // An empty field is unfinished, not wrong.
    const ready = values.length > 0 && bad.length === 0 && !(from && values[0] === from.value);

    async function submit() {
        if (!ready || busy) return;
        setBusy(true);
        const failure = await onSubmit(kind, values);
        setBusy(false);
        if (failure) setRefusal(failure);
        else onClose();
    }

    const placeholder = kind === "path" ? "/admin*" : "203.0.113.7";
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{from ? t("ignore.editTitle") : t("ignore.addTitle")}</DialogTitle>
                    <DialogDescription>{kind === "path" ? t("ignore.pathSyntax") : t("ignore.ipSyntax")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("ignore.kindLabel")}</span>
                        <Select
                            value={kind}
                            disabled={from !== null}
                            aria-label={t("ignore.kindLabel")}
                            onValueChange={(value) => {
                                setKind(value as Kind);
                                setRefusal(null);
                            }}
                            options={[
                                { value: "path", label: t("ignore.kind.path") },
                                { value: "ip", label: t("ignore.kind.ip") }
                            ]}
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span>
                            {from ? t("ignore.value") : t("ignore.valueMany")} <span aria-hidden>*</span>
                        </span>
                        {from ? (
                            <Input
                                value={text}
                                autoFocus
                                spellCheck={false}
                                className="font-mono text-xs"
                                placeholder={placeholder}
                                aria-invalid={bad.length > 0}
                                onChange={(event) => {
                                    setText(event.target.value);
                                    setRefusal(null);
                                }}
                            />
                        ) : (
                            <Textarea
                                value={text}
                                autoFocus
                                rows={3}
                                spellCheck={false}
                                className="font-mono text-xs"
                                placeholder={placeholder}
                                aria-invalid={bad.length > 0}
                                onChange={(event) => {
                                    setText(event.target.value);
                                    setRefusal(null);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                        event.preventDefault();
                                        void submit();
                                    }
                                }}
                            />
                        )}
                        {bad.length > 0 ? (
                            <span className="truncate text-xs text-danger-ink">
                                {kind === "path" ? t("site.badPath", { value: bad[0]! }) : t("site.badIp", { value: bad[0]! })}
                            </span>
                        ) : values.length > 1 ? (
                            <span className="text-xs text-muted-foreground">{t("ignore.counted", { count: values.length })}</span>
                        ) : null}
                        {refusal ? (
                            <span role="alert" className="text-xs text-danger-ink">
                                {refusal}
                            </span>
                        ) : null}
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("ignore.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready || busy}>
                            {from ? t("ignore.save") : values.length > 1 ? t("ignore.addMany", { count: values.length }) : t("ignore.addOne")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
