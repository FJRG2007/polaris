"use client";

/**
 * Keeping server templates: the list, and the editor for one. Every field is
 * read through the same schema the server applies, as it is typed.
 */

import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TemplateView } from "@/lib/server-templates/service";
import { LIBRARY_KEYS, librarySpec, type LibraryKey } from "@/lib/server-templates/library";
import { hostTemplateInputSchema, type HostTemplateInput, type TemplateSpec } from "@polaris/core";
import { deleteTemplateAction, listTemplatesAction, saveTemplateAction } from "../template-actions";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Textarea
} from "@polaris/ui";

type T = ReturnType<typeof useTranslations<"servers">>;

interface Draft {
    name: string;
    description: string;
    packages: string;
    services: { name: string; running: boolean; enabled: boolean }[];
    files: { path: string; mode: string; content: string }[];
    sysctl: { key: string; value: string }[];
    users: { name: string; groups: string }[];
    firewall: { port: string; protocol: "tcp" | "udp" }[];
}

function draftOf(name: string, description: string, spec: Partial<TemplateSpec>): Draft {
    return {
        name,
        description,
        packages: (spec.packages ?? []).join("\n"),
        services: (spec.services ?? []).map((svc) => ({ ...svc })),
        files: (spec.files ?? []).map((file) => ({ ...file })),
        sysctl: (spec.sysctl ?? []).map((entry) => ({ ...entry })),
        users: (spec.users ?? []).map((user) => ({
            name: user.name,
            groups: user.groups.join(", ")
        })),
        firewall: (spec.firewall ?? []).map((rule) => ({
            port: String(rule.port),
            protocol: rule.protocol
        }))
    };
}

function inputOf(draft: Draft): HostTemplateInput {
    return {
        name: draft.name,
        description: draft.description,
        spec: {
            packages: draft.packages
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            services: draft.services,
            files: draft.files,
            sysctl: draft.sysctl,
            users: draft.users.map((user) => ({
                name: user.name,
                groups: user.groups
                    .split(",")
                    .map((group) => group.trim())
                    .filter(Boolean)
            })),
            firewall: draft.firewall.map((rule) => ({
                port: rule.port === "" ? Number.NaN : Number(rule.port),
                protocol: rule.protocol
            }))
        }
    };
}

const INVALID_CODES = new Set([
    "packageName",
    "serviceName",
    "filePath",
    "fileContent",
    "fileMode",
    "sysctlKey",
    "sysctlValue",
    "userName",
    "duplicate"
]);

/** Field path -> what is wrong with it, in words. */
function issuesOf(t: T, draft: Draft): Map<string, string> {
    const parsed = hostTemplateInputSchema.safeParse(inputOf(draft));
    const issues = new Map<string, string>();
    if (parsed.success) return issues;
    for (const issue of parsed.error.issues) {
        let path = issue.path.join(".");
        // A package is typed in one box, so its error is that box's.
        if (path.startsWith("spec.packages.")) path = "spec.packages";
        // A group is typed in its account's groups box.
        path = path.replace(/^(spec\.users\.\d+\.groups)\.\d+$/, "$1");
        if (issues.has(path)) continue;
        const code = INVALID_CODES.has(issue.message)
            ? issue.message
            : issue.code === "too_small"
              ? "required"
              : "other";
        issues.set(path, t(`templates.invalid.${code}` as Parameters<T>[0]));
    }
    return issues;
}

function Field({
    label,
    error,
    children,
    className
}: {
    label: string;
    error?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <label
            className={`flex min-w-0 flex-col gap-1 text-xs text-muted-foreground ${className ?? ""}`}
        >
            <span>{label}</span>
            {children}
            {error ? <span className="text-destructive">{error}</span> : null}
        </label>
    );
}

function RowRemove({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            title={label}
            onClick={onClick}
            className="mt-5 shrink-0"
        >
            <X className="size-3.5" />
        </Button>
    );
}

function Section({
    title,
    onAdd,
    addLabel,
    children
}: {
    title: string;
    onAdd?: () => void;
    addLabel: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{title}</h3>
                {onAdd ? (
                    <Button variant="ghost" size="sm" onClick={onAdd}>
                        <Plus className="size-3.5" /> {addLabel}
                    </Button>
                ) : null}
            </div>
            {children}
        </section>
    );
}

function Editor({
    id,
    initial,
    onDone
}: {
    id: string | null;
    initial: Draft;
    onDone: () => void;
}) {
    const t = useTranslations("servers");
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const issues = useMemo(() => issuesOf(t, draft), [t, draft]);
    const dirty = id === null || JSON.stringify(draft) !== JSON.stringify(initial);
    // An empty box is unfinished rather than wrong, so it is not called invalid.
    const shown = (path: string, value: string) => (value.trim() ? issues.get(path) : undefined);
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));
    const at = <K extends "services" | "files" | "sysctl" | "users" | "firewall">(
        key: K,
        index: number,
        patch: Partial<Draft[K][number]>
    ) =>
        set(
            key,
            draft[key].map((row, i) => (i === index ? { ...row, ...patch } : row)) as Draft[K]
        );
    const drop = <K extends "services" | "files" | "sysctl" | "users" | "firewall">(
        key: K,
        index: number
    ) => set(key, draft[key].filter((_, i) => i !== index) as Draft[K]);
    const e = "templates.editor" as const;

    async function save() {
        setSaving(true);
        setError(null);
        const result = await saveTemplateAction(id, inputOf(draft));
        setSaving(false);
        if (result.ok) onDone();
        else setError(result.error);
    }

    return (
        <div className="flex flex-col gap-4">
            <Field label={`${t(`${e}.name`)} *`} error={shown("name", draft.name)}>
                <Input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => set("name", event.target.value)}
                />
            </Field>
            <Field label={t(`${e}.description`)} error={issues.get("description")}>
                <Input
                    value={draft.description}
                    maxLength={500}
                    onChange={(event) => set("description", event.target.value)}
                />
            </Field>

            <Section title={t(`${e}.packages`)} addLabel={t(`${e}.add`)}>
                <Field
                    label={t(`${e}.packagesHint`)}
                    error={shown("spec.packages", draft.packages)}
                >
                    <Textarea
                        rows={3}
                        value={draft.packages}
                        onChange={(event) => set("packages", event.target.value)}
                        className="font-mono text-xs"
                    />
                </Field>
            </Section>

            <Section
                title={t(`${e}.services`)}
                addLabel={t(`${e}.add`)}
                onAdd={() =>
                    set("services", [...draft.services, { name: "", running: true, enabled: true }])
                }
            >
                {draft.services.map((svc, i) => (
                    <div key={i} className="flex flex-wrap items-start gap-2">
                        <Field
                            label={t(`${e}.service`)}
                            error={shown(`spec.services.${i}.name`, svc.name)}
                            className="flex-1"
                        >
                            <Input
                                value={svc.name}
                                onChange={(event) =>
                                    at("services", i, { name: event.target.value })
                                }
                            />
                        </Field>
                        <label className="mt-6 flex items-center gap-1.5 text-xs">
                            <Checkbox
                                checked={svc.running}
                                onChange={(event) =>
                                    at("services", i, { running: event.target.checked })
                                }
                            />
                            {t(`${e}.running`)}
                        </label>
                        <label className="mt-6 flex items-center gap-1.5 text-xs">
                            <Checkbox
                                checked={svc.enabled}
                                onChange={(event) =>
                                    at("services", i, { enabled: event.target.checked })
                                }
                            />
                            {t(`${e}.enabled`)}
                        </label>
                        <RowRemove
                            label={t(`${e}.removeRow`)}
                            onClick={() => drop("services", i)}
                        />
                    </div>
                ))}
            </Section>

            <Section
                title={t(`${e}.files`)}
                addLabel={t(`${e}.add`)}
                onAdd={() => set("files", [...draft.files, { path: "", mode: "644", content: "" }])}
            >
                {draft.files.map((file, i) => (
                    <div
                        key={i}
                        className="flex flex-col gap-2 rounded-md border border-border/50 p-2"
                    >
                        <div className="flex items-start gap-2">
                            <Field
                                label={t(`${e}.path`)}
                                error={shown(`spec.files.${i}.path`, file.path)}
                                className="flex-1"
                            >
                                <Input
                                    value={file.path}
                                    className="font-mono text-xs"
                                    onChange={(event) =>
                                        at("files", i, { path: event.target.value })
                                    }
                                />
                            </Field>
                            <Field
                                label={t(`${e}.mode`)}
                                error={shown(`spec.files.${i}.mode`, file.mode)}
                                className="w-20"
                            >
                                <Input
                                    value={file.mode}
                                    maxLength={4}
                                    onChange={(event) =>
                                        at("files", i, { mode: event.target.value })
                                    }
                                />
                            </Field>
                            <RowRemove
                                label={t(`${e}.removeRow`)}
                                onClick={() => drop("files", i)}
                            />
                        </div>
                        <Field
                            label={t(`${e}.content`)}
                            error={issues.get(`spec.files.${i}.content`)}
                        >
                            <Textarea
                                rows={4}
                                value={file.content}
                                className="font-mono text-xs"
                                onChange={(event) =>
                                    at("files", i, { content: event.target.value })
                                }
                            />
                        </Field>
                    </div>
                ))}
            </Section>

            <Section
                title={t(`${e}.sysctl`)}
                addLabel={t(`${e}.add`)}
                onAdd={() => set("sysctl", [...draft.sysctl, { key: "", value: "" }])}
            >
                {draft.sysctl.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2">
                        <Field
                            label={t(`${e}.key`)}
                            error={shown(`spec.sysctl.${i}.key`, entry.key)}
                            className="flex-1"
                        >
                            <Input
                                value={entry.key}
                                className="font-mono text-xs"
                                onChange={(event) => at("sysctl", i, { key: event.target.value })}
                            />
                        </Field>
                        <Field
                            label={t(`${e}.value`)}
                            error={shown(`spec.sysctl.${i}.value`, entry.value)}
                            className="w-32"
                        >
                            <Input
                                value={entry.value}
                                onChange={(event) => at("sysctl", i, { value: event.target.value })}
                            />
                        </Field>
                        <RowRemove label={t(`${e}.removeRow`)} onClick={() => drop("sysctl", i)} />
                    </div>
                ))}
            </Section>

            <Section
                title={t(`${e}.users`)}
                addLabel={t(`${e}.add`)}
                onAdd={() => set("users", [...draft.users, { name: "", groups: "" }])}
            >
                {draft.users.map((user, i) => (
                    <div key={i} className="flex items-start gap-2">
                        <Field
                            label={t(`${e}.user`)}
                            error={shown(`spec.users.${i}.name`, user.name)}
                            className="flex-1"
                        >
                            <Input
                                value={user.name}
                                onChange={(event) => at("users", i, { name: event.target.value })}
                            />
                        </Field>
                        <Field
                            label={`${t(`${e}.groups`)} (${t(`${e}.groupsHint`)})`}
                            error={shown(`spec.users.${i}.groups`, user.groups)}
                            className="flex-1"
                        >
                            <Input
                                value={user.groups}
                                onChange={(event) => at("users", i, { groups: event.target.value })}
                            />
                        </Field>
                        <RowRemove label={t(`${e}.removeRow`)} onClick={() => drop("users", i)} />
                    </div>
                ))}
            </Section>

            <Section
                title={t(`${e}.firewall`)}
                addLabel={t(`${e}.add`)}
                onAdd={() => set("firewall", [...draft.firewall, { port: "", protocol: "tcp" }])}
            >
                {draft.firewall.map((rule, i) => (
                    <div key={i} className="flex items-start gap-2">
                        <Field
                            label={t(`${e}.port`)}
                            error={
                                shown(`spec.firewall.${i}.port`, rule.port) ??
                                (rule.port ? issues.get(`spec.firewall.${i}.port`) : undefined)
                            }
                            className="w-28"
                        >
                            <Input
                                inputMode="numeric"
                                value={rule.port}
                                onChange={(event) =>
                                    at("firewall", i, {
                                        port: event.target.value.replace(/\D/g, "")
                                    })
                                }
                            />
                        </Field>
                        <Field label={t(`${e}.protocol`)} className="w-28">
                            <Select
                                value={rule.protocol}
                                onValueChange={(value) =>
                                    at("firewall", i, { protocol: value as "tcp" | "udp" })
                                }
                                options={[
                                    { value: "tcp", label: "TCP" },
                                    { value: "udp", label: "UDP" }
                                ]}
                            />
                        </Field>
                        <RowRemove
                            label={t(`${e}.removeRow`)}
                            onClick={() => drop("firewall", i)}
                        />
                    </div>
                ))}
            </Section>

            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {t(`templates.errors.${error}` as Parameters<T>[0])}
                </p>
            ) : null}
            <DialogFooter>
                <Button variant="ghost" onClick={onDone}>
                    {t(`${e}.cancel`)}
                </Button>
                <Button
                    disabled={!dirty || issues.size > 0 || saving}
                    aria-disabled={!dirty || issues.size > 0 || saving}
                    onClick={save}
                >
                    {t(`${e}.save`)}
                </Button>
            </DialogFooter>
        </div>
    );
}

export function TemplatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const t = useTranslations("servers");
    const [confirm, confirmDialog] = useConfirm();
    const [templates, setTemplates] = useState<TemplateView[] | null>(null);
    const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
    const [start, setStart] = useState<LibraryKey>("blank");
    const [error, setError] = useState<string | null>(null);

    async function load() {
        const result = await listTemplatesAction();
        if (result.ok) setTemplates(result.value);
        else setError(result.error);
    }

    useEffect(() => {
        if (open) void load();
        else setEditing(null);
    }, [open]);

    async function remove(template: TemplateView) {
        const ok = await confirm({
            title: t("templates.editor.confirmDelete.title", { name: template.name }),
            description: t("templates.editor.confirmDelete.body"),
            confirmLabel: t("templates.editor.confirmDelete.confirm"),
            danger: true
        });
        if (!ok) return;
        const previous = templates;
        setTemplates((current) => (current ?? []).filter((row) => row.id !== template.id));
        const result = await deleteTemplateAction(template.id);
        if (!result.ok) {
            setTemplates(previous);
            setError(result.error);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>
                        {editing
                            ? editing.draft.name || t("templates.editor.new")
                            : t("templates.manage")}
                    </DialogTitle>
                </DialogHeader>
                {editing ? (
                    <Editor
                        id={editing.id}
                        initial={editing.draft}
                        onDone={() => {
                            setEditing(null);
                            void load();
                        }}
                    />
                ) : (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-end gap-2">
                            <Field label={t("templates.editor.startFrom")} className="w-56">
                                <Select
                                    value={start}
                                    onValueChange={(value) => setStart(value as LibraryKey)}
                                    options={LIBRARY_KEYS.map((key) => ({
                                        value: key,
                                        label: t(`templates.editor.library.${key}`)
                                    }))}
                                />
                            </Field>
                            <Button
                                size="sm"
                                onClick={() =>
                                    setEditing({
                                        id: null,
                                        draft: draftOf(
                                            start === "blank"
                                                ? ""
                                                : t(`templates.editor.library.${start}`),
                                            start === "blank"
                                                ? ""
                                                : t(`templates.editor.libraryAbout.${start}`),
                                            librarySpec(start)
                                        )
                                    })
                                }
                            >
                                <Plus className="size-3.5" /> {t("templates.editor.new")}
                            </Button>
                        </div>
                        {start === "blank" ? null : (
                            <p className="text-xs text-muted-foreground">
                                {t(`templates.editor.libraryAbout.${start}`)}
                            </p>
                        )}
                        {error ? (
                            <p role="alert" className="text-sm text-destructive">
                                {t(`templates.errors.${error}` as Parameters<T>[0])}
                            </p>
                        ) : null}
                        {templates === null ? (
                            <Skeleton className="h-16 w-full" />
                        ) : templates.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {t("templates.editor.empty")}
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border/50">
                                {templates.map((template) => (
                                    <li key={template.id} className="flex items-center gap-2 py-2">
                                        <button
                                            type="button"
                                            className="min-w-0 flex-1 text-left"
                                            onClick={() =>
                                                setEditing({
                                                    id: template.id,
                                                    draft: draftOf(
                                                        template.name,
                                                        template.description,
                                                        template.spec
                                                    )
                                                })
                                            }
                                        >
                                            <span
                                                className="block truncate text-sm font-medium"
                                                title={template.name}
                                            >
                                                {template.name}
                                            </span>
                                            {template.description ? (
                                                <span
                                                    className="block truncate text-xs text-muted-foreground"
                                                    title={template.description}
                                                >
                                                    {template.description}
                                                </span>
                                            ) : null}
                                        </button>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {t("templates.editor.servers", {
                                                count: template.servers
                                            })}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={t("templates.editor.edit")}
                                            title={t("templates.editor.edit")}
                                            onClick={() =>
                                                setEditing({
                                                    id: template.id,
                                                    draft: draftOf(
                                                        template.name,
                                                        template.description,
                                                        template.spec
                                                    )
                                                })
                                            }
                                        >
                                            <Pencil className="size-3.5" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={t("templates.editor.delete")}
                                            title={t("templates.editor.delete")}
                                            onClick={() => remove(template)}
                                        >
                                            <Trash2 className="size-3.5" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
                {confirmDialog}
            </DialogContent>
        </Dialog>
    );
}
