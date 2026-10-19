"use client";

/**
 * What a UPS says, raw: the variables it can have changed (NUT's upsrw),
 * edited one at a time against the kind the UPS declares; every variable it
 * reports, filterable and copyable; and the mapping that points a standard
 * name at this UPS's own when its firmware uses another.
 */

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
    Button,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    useToast
} from "@polaris/ui";
import type { UpsView } from "@/lib/ups/ups-service";
import type { UpsActionsAnswer } from "../ups-words";
import * as upsSettings from "@/lib/ups/ups-settings";
import { UpsActionHistory } from "./ups-commands-panel";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setUpsVarAction, updateUpsVariableMapAction } from "../actions";

export function UpsVariablesPanel({
    ups,
    vars,
    rw,
    onChanged
}: {
    ups: UpsView;
    vars: Record<string, string> | null;
    rw: upsSettings.UpsRwVar[] | null;
    onChanged: () => void;
}) {
    const t = useTranslations("servers");
    const history = useLiveResource<UpsActionsAnswer>({
        url: `/api/servers/ups/${ups.id}/actions?kind=variable`,
        cacheKey: `ups:${ups.id}:actions:variable`,
        intervalMs: 60_000,
        select: (body) => body as UpsActionsAnswer
    });
    const [editing, setEditing] = useState<upsSettings.UpsRwVar | null>(null);

    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="ups-rw" className="flex flex-col gap-3">
                <h3 id="ups-rw" className="text-sm font-medium">
                    {t("ups.variables.writable")}
                </h3>
                {rw === null ? (
                    <Skeleton className="h-24 w-full" />
                ) : rw.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ups.variables.noWritable")}</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-md border">
                        {rw.map((one) => (
                            <li
                                key={one.name}
                                className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm"
                            >
                                <code className="min-w-0 flex-1 truncate" title={one.name}>
                                    {one.name}
                                </code>
                                <span
                                    className="max-w-48 truncate font-medium tabular-nums"
                                    title={one.value}
                                >
                                    {one.value}
                                </span>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("ups.variables.edit", { name: one.name })}
                                    title={t("ups.variables.edit", { name: one.name })}
                                    onClick={() => setEditing(one)}
                                >
                                    <Pencil className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <h4 className="text-xs font-medium text-muted-foreground">
                    {t("ups.variables.history")}
                </h4>
                <UpsActionHistory answer={history.data} />
            </section>

            <UpsRawVariables vars={vars} />
            <UpsMappings ups={ups} vars={vars} onSaved={onChanged} />

            {editing ? (
                <EditVariableDialog
                    upsId={ups.id}
                    rw={editing}
                    onClose={() => setEditing(null)}
                    onDone={() => {
                        history.refresh();
                        onChanged();
                    }}
                />
            ) : null}
        </div>
    );
}

function EditVariableDialog({
    upsId,
    rw,
    onClose,
    onDone
}: {
    upsId: string;
    rw: upsSettings.UpsRwVar;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [value, setValue] = useState(rw.value);
    const [pending, setPending] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const error = value === "" ? null : upsSettings.rwValueError(rw, value);
    const ready = value !== "" && error === null && value !== rw.value;
    const hint =
        rw.kind === "range" && rw.ranges?.length
            ? t("ups.variables.range", {
                  ranges: rw.ranges.map(([min, max]) => `${min}-${max}`).join(", ")
              })
            : rw.kind === "string" && rw.maxLen
              ? t("ups.variables.maxLen", { count: rw.maxLen })
              : null;

    async function save() {
        setPending(true);
        setServerError(null);
        const outcome = await setUpsVarAction(upsId, { name: rw.name, value });
        setPending(false);
        if (!outcome.ok) {
            setServerError(t("ups.errors.failed"));
            return;
        }
        if (outcome.value.outcome === "invalid") {
            setServerError(
                t(
                    `ups.variables.errors.${(outcome.value.error ?? "invalidValue") as "invalidValue"}`
                )
            );
            return;
        }
        toast.show({
            key: `ups:${upsId}:set`,
            title: t(`ups.commandResult.${outcome.value.outcome}`)
        });
        onDone();
        if (outcome.value.outcome === "ok") onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("ups.variables.editTitle")}</DialogTitle>
                    <DialogDescription>
                        <code>{rw.name}</code>
                    </DialogDescription>
                </DialogHeader>
                <label className="flex flex-col gap-1 text-sm">
                    {t("ups.variables.value")} *
                    {rw.kind === "enum" ? (
                        <Select
                            value={value}
                            onValueChange={setValue}
                            options={(rw.options ?? []).map((one) => ({ value: one, label: one }))}
                        />
                    ) : (
                        <Input
                            value={value}
                            inputMode={
                                rw.kind === "number" || rw.kind === "range" ? "decimal" : undefined
                            }
                            maxLength={rw.maxLen ?? 64}
                            aria-invalid={error !== null}
                            onChange={(event) => setValue(event.target.value)}
                        />
                    )}
                </label>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                {error || serverError ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {serverError ?? t(`ups.variables.errors.${error as "invalidValue"}`)}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("ups.form.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!ready || pending}
                        disabled={pending}
                        onClick={() => {
                            if (ready) void save();
                        }}
                    >
                        {t("ups.variables.set")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function UpsRawVariables({ vars }: { vars: Record<string, string> | null }) {
    const t = useTranslations("servers");
    const [filter, setFilter] = useState("");
    const needle = filter.trim().toLowerCase();
    const rows = vars
        ? Object.entries(vars).filter(
              ([name, value]) =>
                  !needle || name.includes(needle) || value.toLowerCase().includes(needle)
          )
        : null;
    return (
        <section aria-labelledby="ups-raw" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="ups-raw" className="text-sm font-medium">
                    {t("ups.variables.raw")}
                </h3>
                <div className="flex items-center gap-2">
                    <Input
                        className="w-56"
                        value={filter}
                        placeholder={t("ups.variables.filter")}
                        aria-label={t("ups.variables.filter")}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                    {vars ? (
                        <CopyButton
                            value={Object.entries(vars)
                                .map(([name, value]) => `${name}: ${value}`)
                                .join("\n")}
                            label={t("ups.variables.copyAll")}
                        />
                    ) : null}
                </div>
            </div>
            {rows === null ? (
                <Skeleton className="h-40 w-full" />
            ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("ups.variables.noMatch")}</p>
            ) : (
                <div className="max-h-96 overflow-auto rounded-md border">
                    <table className="w-full table-fixed text-sm">
                        <tbody>
                            {rows.map(([name, value]) => (
                                <tr key={name} className="border-t first:border-t-0">
                                    <td
                                        className="w-1/2 truncate px-3 py-1.5 font-mono text-xs"
                                        title={name}
                                    >
                                        {name}
                                    </td>
                                    <td className="truncate px-3 py-1.5 tabular-nums" title={value}>
                                        {value}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function UpsMappings({
    ups,
    vars,
    onSaved
}: {
    ups: UpsView;
    vars: Record<string, string> | null;
    onSaved: () => void;
}) {
    const t = useTranslations("servers");
    const [saved, setSaved] = useState(ups.variableMap);
    const [rows, setRows] = useState<{ from: string; to: string }[]>(() =>
        Object.entries(ups.variableMap).map(([from, to]) => ({ from, to }))
    );
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const candidate = Object.fromEntries(
        rows.filter((row) => row.from && row.to).map((row) => [row.from, row.to.trim()])
    );
    const parsed = upsSettings.variableMapSchema.safeParse(candidate);
    const incomplete = rows.some((row) => !row.from || !row.to.trim());
    const dirty = JSON.stringify(candidate) !== JSON.stringify(saved);
    const used = new Set(rows.map((row) => row.from));

    async function save() {
        if (!parsed.success) return;
        setPending(true);
        setError(null);
        const outcome = await updateUpsVariableMapAction(ups.id, parsed.data);
        setPending(false);
        if (!outcome.ok) {
            setError(t("ups.errors.failed"));
            return;
        }
        setSaved(parsed.data);
        onSaved();
    }

    return (
        <section aria-labelledby="ups-mappings" className="flex flex-col gap-3">
            <h3 id="ups-mappings" className="text-sm font-medium">
                {t("ups.mappings.title")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("ups.mappings.intro")}</p>
            {rows.map((row, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("ups.mappings.standard")}
                        className="w-56"
                        value={row.from}
                        placeholder={t("ups.mappings.standard")}
                        onValueChange={(value) =>
                            setRows(
                                rows.map((one, at) =>
                                    at === index ? { ...one, from: value } : one
                                )
                            )
                        }
                        options={upsSettings.MAPPABLE_VARS.filter(
                            (name) => name === row.from || !used.has(name)
                        ).map((name) => ({ value: name, label: name }))}
                    />
                    <span className="text-muted-foreground" aria-hidden>
                        &larr;
                    </span>
                    <Select
                        aria-label={t("ups.mappings.own")}
                        className="w-56"
                        value={row.to}
                        placeholder={t("ups.mappings.own")}
                        onValueChange={(value) =>
                            setRows(
                                rows.map((one, at) => (at === index ? { ...one, to: value } : one))
                            )
                        }
                        options={Object.keys(vars ?? {})
                            .concat(row.to && !(vars ?? {})[row.to] ? [row.to] : [])
                            .map((name) => ({ value: name, label: name }))}
                    />
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("ups.mappings.remove")}
                        title={t("ups.mappings.remove")}
                        onClick={() => setRows(rows.filter((_, at) => at !== index))}
                    >
                        <Trash2 className="size-4 shrink-0" aria-hidden />
                    </Button>
                </div>
            ))}
            {!incomplete && !parsed.success ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {t("ups.mappings.invalid")}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {error}
                </p>
            ) : null}
            <div className="flex gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    aria-disabled={used.size >= upsSettings.MAPPABLE_VARS.length}
                    onClick={() => {
                        if (used.size < upsSettings.MAPPABLE_VARS.length)
                            setRows([...rows, { from: "", to: "" }]);
                    }}
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("ups.mappings.add")}
                </Button>
                <Button
                    size="sm"
                    aria-disabled={!dirty || incomplete || !parsed.success || pending}
                    disabled={pending}
                    onClick={() => {
                        if (dirty && !incomplete && parsed.success) void save();
                    }}
                >
                    {t("ups.mappings.save")}
                </Button>
            </div>
        </section>
    );
}
