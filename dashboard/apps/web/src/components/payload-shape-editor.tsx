"use client";

/**
 * The expected shape of a payload: "Any", or a tree of fields with a type and
 * rules each, strict by default. Shared by everything that receives payloads
 * (webhook triggers, forms, alert topics). Controlled - the parent owns the
 * value; a sample pasted below is checked live against it, and can become the
 * shape in one click.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Plus, Trash2 } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Input, Select, Switch, Textarea, cn } from "@polaris/ui";

type Field = core.PayloadField;

const optionalNumber = (value: string) => (value.trim() === "" ? undefined : Number(value));

function FieldEditor({
    field,
    onChange,
    onRemove,
    depth,
    named
}: {
    field: Field;
    onChange: (next: Field) => void;
    onRemove?: () => void;
    depth: number;
    named: boolean;
}) {
    const t = useTranslations("components");
    const set = (change: Partial<Field>) => onChange({ ...field, ...change });
    const typed = (type: core.PayloadFieldType): Field => ({
        name: field.name,
        type,
        required: field.required,
        nullable: field.nullable,
        ...(type === "object" ? { fields: [], strict: true } : {}),
        ...(type === "enum" ? { values: ["a"] } : {}),
        ...(type === "array" ? { items: { name: "", type: "string", required: true, nullable: false } } : {})
    });
    const issue = core.payloadFieldSchema.safeParse(field);
    const number = (key: "minLength" | "maxLength" | "min" | "max", label: string) => (
        <Input
            type="number"
            inputMode="numeric"
            className="w-20"
            aria-label={label}
            placeholder={label}
            value={field[key] === undefined ? "" : String(field[key])}
            onChange={(event) => set({ [key]: optionalNumber(event.target.value) })}
        />
    );
    return (
        <div className={cn("min-w-0 space-y-2", depth > 0 && "border-l border-border pl-2")}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {named ? (
                    <Input
                        className="w-32 min-w-0 flex-1 font-mono"
                        value={field.name}
                        placeholder={t("payloadShape.name")}
                        aria-label={t("payloadShape.name")}
                        aria-invalid={field.name.trim() === ""}
                        onChange={(event) => set({ name: event.target.value })}
                    />
                ) : null}
                <div className="w-32">
                    <Select
                        value={field.type}
                        onValueChange={(type) => onChange(typed(type as core.PayloadFieldType))}
                        options={core.PAYLOAD_FIELD_TYPES.map((type) => ({
                            value: type,
                            label: t(`payloadShape.types.${type}` as NamespaceKey<"components">)
                        }))}
                        aria-label={t("payloadShape.type")}
                    />
                </div>
                {named ? (
                    <label className="flex items-center gap-1 text-xs">
                        <Switch checked={field.required} onChange={(required: boolean) => set({ required })} />
                        {t("payloadShape.required")}
                    </label>
                ) : null}
                <label className="flex items-center gap-1 text-xs">
                    <Switch checked={field.nullable} onChange={(nullable: boolean) => set({ nullable })} />
                    {t("payloadShape.nullable")}
                </label>
                {onRemove ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("payloadShape.remove")}
                        title={t("payloadShape.remove")}
                        onClick={onRemove}
                    >
                        <Trash2 aria-hidden="true" />
                    </Button>
                ) : null}
            </div>
            {field.type === "string" ? (
                <div className="flex min-w-0 flex-wrap gap-2">
                    {number("minLength", t("payloadShape.minLength"))}
                    {number("maxLength", t("payloadShape.maxLength"))}
                    <Input
                        className="min-w-0 flex-1 font-mono"
                        value={field.pattern ?? ""}
                        placeholder={t("payloadShape.pattern")}
                        aria-label={t("payloadShape.pattern")}
                        aria-invalid={Boolean(field.pattern) && !core.safePattern(field.pattern ?? "")}
                        onChange={(event) => set({ pattern: event.target.value || undefined })}
                    />
                </div>
            ) : null}
            {field.type === "number" || field.type === "integer" ? (
                <div className="flex flex-wrap gap-2">
                    {number("min", t("payloadShape.min"))}
                    {number("max", t("payloadShape.max"))}
                </div>
            ) : null}
            {field.type === "enum" ? (
                <Input
                    className="font-mono"
                    value={(field.values ?? []).join(", ")}
                    placeholder={t("payloadShape.values")}
                    aria-label={t("payloadShape.values")}
                    onChange={(event) =>
                        set({
                            values: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean)
                        })
                    }
                />
            ) : null}
            {field.type === "array" ? (
                <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap gap-2">
                        {number("minLength", t("payloadShape.minItems"))}
                        {number("maxLength", t("payloadShape.maxItems"))}
                    </div>
                    <p className="text-xs text-muted-foreground">{t("payloadShape.items")}</p>
                    <FieldEditor
                        field={field.items ?? { name: "", type: "string", required: true, nullable: false }}
                        onChange={(items) => set({ items })}
                        depth={depth + 1}
                        named={false}
                    />
                </div>
            ) : null}
            {field.type === "object" ? (
                <div className="min-w-0 space-y-2">
                    <label className="flex items-center gap-1 text-xs">
                        <Switch checked={field.strict !== false} onChange={(strict: boolean) => set({ strict })} />
                        {t("payloadShape.strict")}
                    </label>
                    {(field.fields ?? []).map((child, at) => (
                        <FieldEditor
                            key={at}
                            field={child}
                            depth={depth + 1}
                            named
                            onChange={(next) =>
                                set({ fields: (field.fields ?? []).map((entry, i) => (i === at ? next : entry)) })
                            }
                            onRemove={() => set({ fields: (field.fields ?? []).filter((_, i) => i !== at) })}
                        />
                    ))}
                    {depth + 1 < core.PAYLOAD_SHAPE_LIMITS.depth ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                set({
                                    fields: [
                                        ...(field.fields ?? []),
                                        { name: "", type: "string", required: true, nullable: false }
                                    ]
                                })
                            }
                        >
                            <Plus aria-hidden="true" />
                            {t("payloadShape.addField")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {!issue.success && named && field.name.trim() !== "" ? (
                <p className="text-xs text-destructive">{t("payloadShape.checkField")}</p>
            ) : null}
        </div>
    );
}

export function PayloadShapeEditor({
    label,
    value,
    onChange
}: {
    label: string;
    value: core.PayloadShape;
    onChange: (next: core.PayloadShape) => void;
}) {
    const t = useTranslations("components");
    const [sample, setSample] = useState("");
    let parsed: { ok: true; value: unknown } | { ok: false } = { ok: false };
    if (sample.trim()) {
        try {
            parsed = { ok: true, value: JSON.parse(sample) };
        } catch {
            parsed = { ok: false };
        }
    }
    const valid = core.payloadShapeSchema.safeParse(value).success;
    const check = parsed.ok && valid ? core.checkPayload(value, parsed.value) : null;
    return (
        <div className="min-w-0 space-y-2 text-sm" data-payload-shape>
            <span>{label}</span>
            <div className="w-40">
                <Select
                    value={value.kind}
                    onValueChange={(kind) =>
                        onChange(kind === "any" ? core.ANY_PAYLOAD : core.emptyStructuredShape())
                    }
                    options={[
                        { value: "any", label: t("payloadShape.any") },
                        { value: "structured", label: t("payloadShape.structured") }
                    ]}
                    aria-label={label}
                />
            </div>
            {value.kind === "structured" ? (
                <FieldEditor
                    field={value.root}
                    depth={0}
                    named={false}
                    onChange={(root) => onChange({ ...value, root })}
                />
            ) : null}
            {!valid ? <p className="text-xs text-destructive">{t("payloadShape.invalid")}</p> : null}
            <Textarea
                rows={3}
                className="font-mono text-xs"
                value={sample}
                placeholder={t("payloadShape.samplePlaceholder")}
                aria-label={t("payloadShape.sample")}
                onChange={(event) => setSample(event.target.value)}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {sample.trim() ? (
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate text-xs",
                            check?.ok ? "text-success" : "text-destructive"
                        )}
                    >
                        {!parsed.ok
                            ? t("payloadShape.notJson")
                            : check?.ok
                              ? t("payloadShape.matches")
                              : t("payloadShape.fails", { path: check && !check.ok ? check.path : "" })}
                    </span>
                ) : null}
                <Button
                    variant="outline"
                    size="sm"
                    disabled={!parsed.ok}
                    onClick={() => parsed.ok && onChange(core.inferShape(parsed.value))}
                >
                    {t("payloadShape.useSample")}
                </Button>
            </div>
        </div>
    );
}
