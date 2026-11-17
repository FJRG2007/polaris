"use client";

/**
 * Custom tools, plugins and a repository's own tools, in Polar's Tools
 * settings. Every field is checked as it is typed against the schemas the
 * server saves with (`lib/polar/custom-tools/shared.ts`); a save or delete
 * shows at once and is put back if the server refuses it.
 */

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import {
    Button,
    Card,
    CardBody,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";
import * as actions from "./custom-tools-actions";
import * as shared from "@/lib/polar/custom-tools/shared";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { StoredPlugin, StoredTool } from "@/lib/polar/custom-tools/store";

interface Props {
    tools: StoredTool[];
    plugins: StoredPlugin[];
    readOnly: boolean;
}

interface ToolDraft {
    name: string;
    description: string;
    runtime: shared.ToolRuntime;
    permission: shared.ToolPermission;
    timeout: string;
    input: string;
    script: string;
}

const EMPTY_TOOL: ToolDraft = {
    name: "",
    description: "",
    runtime: "shell",
    permission: "ask",
    timeout: String(shared.TIMEOUT_DEFAULT),
    input: '{\n  "properties": {}\n}',
    script: ""
};

function draftOf(tool: StoredTool | null): ToolDraft {
    if (!tool) return EMPTY_TOOL;
    return {
        name: tool.name,
        description: tool.description,
        runtime: tool.runtime,
        permission: tool.permission,
        timeout: String(tool.timeoutSeconds),
        input: JSON.stringify({ properties: tool.input.properties, required: tool.input.required }, null, 2),
        script: tool.script
    };
}

/** The draft as the schema reads it, or the fields it refuses. */
function parseDraft(draft: ToolDraft, enabled: boolean) {
    let input: unknown = null;
    try {
        input = JSON.parse(draft.input);
    } catch {
        input = null;
    }
    return shared.customToolSchema.safeParse({
        name: draft.name,
        description: draft.description,
        runtime: draft.runtime,
        permission: draft.permission,
        timeoutSeconds: Number(draft.timeout),
        input,
        script: draft.script,
        enabled
    });
}

export function PolarCustomTools({ tools: initialTools, plugins: initialPlugins, readOnly }: Props) {
    const t = useTranslations("polar");
    const [tools, setTools] = useState(initialTools);
    const [plugins, setPlugins] = useState(initialPlugins);
    const [editing, setEditing] = useState<StoredTool | "new" | null>(null);
    const [editingPlugin, setEditingPlugin] = useState<StoredPlugin | "new" | null>(null);
    const [removing, setRemoving] = useState<{ kind: "tool" | "plugin"; id: string; name: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const toggle = (tool: StoredTool, enabled: boolean) => {
        const before = tools;
        setTools((current) => current.map((entry) => (entry.id === tool.id ? { ...entry, enabled } : entry)));
        startTransition(async () => {
            const { id, ...rest } = tool;
            const result = await actions.saveCustomTool(id, { ...rest, enabled });
            if (!result.ok) {
                setTools(before);
                setError(result.error);
            }
        });
    };

    const remove = (target: { kind: "tool" | "plugin"; id: string }) => {
        const beforeTools = tools;
        const beforePlugins = plugins;
        if (target.kind === "tool") setTools((current) => current.filter((entry) => entry.id !== target.id));
        else setPlugins((current) => current.filter((entry) => entry.id !== target.id));
        setRemoving(null);
        startTransition(async () => {
            const result =
                target.kind === "tool" ? await actions.deleteCustomTool(target.id) : await actions.deletePlugin(target.id);
            if (!result.ok) {
                setTools(beforeTools);
                setPlugins(beforePlugins);
                setError(result.error);
            }
        });
    };

    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3">
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold">{t("settings.customTools.title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("settings.customTools.intro")}</p>
                    </div>
                    {!readOnly && (
                        <Button size="sm" onClick={() => setEditing("new")}>
                            <Plus className="size-4 shrink-0" />
                            {t("settings.customTools.add")}
                        </Button>
                    )}
                </div>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {tools.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("settings.customTools.empty")}</p>
                ) : (
                    <Card>
                        <CardBody className="flex flex-col divide-y p-0">
                            {tools.map((tool) => (
                                <div key={tool.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate font-mono text-sm" title={shared.turnToolName(tool.name)}>
                                            {shared.turnToolName(tool.name)}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground" title={tool.description}>
                                            {t(`settings.customTools.permission.${tool.permission}`)} - {tool.description}
                                        </p>
                                    </div>
                                    <Switch
                                        checked={tool.enabled}
                                        disabled={readOnly}
                                        aria-label={t("settings.customTools.enabled")}
                                        onChange={(on) => toggle(tool, on)}
                                    />
                                    {!readOnly && (
                                        <>
                                            <Button size="icon" variant="ghost" aria-label={t("settings.customTools.edit")} onClick={() => setEditing(tool)}>
                                                <Pencil className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t("settings.customTools.remove")}
                                                onClick={() => setRemoving({ kind: "tool", id: tool.id, name: tool.name })}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            ))}
                        </CardBody>
                    </Card>
                )}
            </section>

            <ProjectTools readOnly={readOnly} />

            <section className="flex flex-col gap-3">
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold">{t("settings.customTools.plugins.title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("settings.customTools.plugins.intro")}</p>
                    </div>
                    {!readOnly && (
                        <Button size="sm" onClick={() => setEditingPlugin("new")}>
                            <Plus className="size-4 shrink-0" />
                            {t("settings.customTools.plugins.add")}
                        </Button>
                    )}
                </div>
                {plugins.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("settings.customTools.plugins.empty")}</p>
                ) : (
                    <Card>
                        <CardBody className="flex flex-col divide-y p-0">
                            {plugins.map((plugin) => (
                                <div key={plugin.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm" title={plugin.name}>
                                            {plugin.name}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {plugin.events.map((event) => t(`settings.customTools.events.${event.replace(".", "_")}` as never)).join(", ")}
                                            {" -> "}
                                            {plugin.action.kind === "webhook" ? plugin.action.url : shared.turnToolName(plugin.action.tool)}
                                        </p>
                                    </div>
                                    {!readOnly && (
                                        <>
                                            <Button size="icon" variant="ghost" aria-label={t("settings.customTools.edit")} onClick={() => setEditingPlugin(plugin)}>
                                                <Pencil className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t("settings.customTools.remove")}
                                                onClick={() => setRemoving({ kind: "plugin", id: plugin.id, name: plugin.name })}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            ))}
                        </CardBody>
                    </Card>
                )}
            </section>

            <ToolDialog
                editing={editing}
                onClose={() => setEditing(null)}
                onSaved={(saved) =>
                    setTools((current) =>
                        [...current.filter((entry) => entry.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name))
                    )
                }
            />
            <PluginDialog
                editing={editingPlugin}
                tools={tools}
                onClose={() => setEditingPlugin(null)}
                onSaved={(saved) =>
                    setPlugins((current) =>
                        current.some((entry) => entry.id === saved.id)
                            ? current.map((entry) => (entry.id === saved.id ? saved : entry))
                            : [...current, saved]
                    )
                }
            />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={t(removing?.kind === "plugin" ? "settings.customTools.plugins.kind" : "settings.customTools.kind")}
                description={t("settings.customTools.removeHint")}
                onConfirm={() => removing && remove(removing)}
            />
        </div>
    );
}

function ToolDialog({
    editing,
    onClose,
    onSaved
}: {
    editing: StoredTool | "new" | null;
    onClose: () => void;
    onSaved: (tool: StoredTool) => void;
}) {
    const t = useTranslations("polar");
    const current = editing === "new" ? null : editing;
    const [draft, setDraft] = useState<ToolDraft>(draftOf(current));
    const [opened, setOpened] = useState(editing);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    if (opened !== editing) {
        setOpened(editing);
        setDraft(draftOf(current));
        setError(null);
    }
    const parsed = useMemo(() => parseDraft(draft, current?.enabled ?? true), [draft, current]);
    const issues = new Set(parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0] ?? "")));
    const unchanged = JSON.stringify(draft) === JSON.stringify(draftOf(current));
    const set = <K extends keyof ToolDraft>(key: K, value: ToolDraft[K]) => setDraft((before) => ({ ...before, [key]: value }));
    const save = () => {
        if (!parsed.success) return;
        startTransition(async () => {
            const result = await actions.saveCustomTool(current?.id ?? null, parsed.data);
            if (!result.ok) return setError(result.error);
            onSaved(result.value);
            onClose();
        });
    };
    const flag = (key: string, filled: boolean) => (filled && issues.has(key) ? t(`settings.customTools.invalid.${key}` as never) : null);
    return (
        <Dialog open={editing !== null} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t(current ? "settings.customTools.editTitle" : "settings.customTools.addTitle")}</DialogTitle>
                    <DialogDescription>{t("settings.customTools.sandboxHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <Field label={`${t("settings.customTools.fields.name")} *`} error={flag("name", draft.name !== "")}>
                        <Input value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="run_tests" />
                    </Field>
                    <Field label={`${t("settings.customTools.fields.description")} *`} error={flag("description", draft.description !== "")}>
                        <Input value={draft.description} onChange={(event) => set("description", event.target.value)} />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-3">
                        <Field label={t("settings.customTools.fields.runtime")}>
                            <Select
                                value={draft.runtime}
                                options={shared.RUNTIMES.map((value) => ({ value, label: t(`settings.customTools.runtime.${value}`) }))}
                                onValueChange={(value) => set("runtime", value as shared.ToolRuntime)}
                            />
                        </Field>
                        <Field label={t("settings.customTools.fields.permission")}>
                            <Select
                                value={draft.permission}
                                options={shared.TOOL_PERMISSIONS.map((value) => ({ value, label: t(`settings.customTools.permission.${value}`) }))}
                                onValueChange={(value) => set("permission", value as shared.ToolPermission)}
                            />
                        </Field>
                        <Field label={t("settings.customTools.fields.timeout")} error={flag("timeoutSeconds", draft.timeout !== "")}>
                            <Input inputMode="numeric" value={draft.timeout} onChange={(event) => set("timeout", event.target.value)} />
                        </Field>
                    </div>
                    <Field label={t("settings.customTools.fields.input")} error={flag("input", true)}>
                        <Textarea className="font-mono text-xs" rows={5} value={draft.input} onChange={(event) => set("input", event.target.value)} />
                    </Field>
                    <Field label={`${t("settings.customTools.fields.script")} *`} error={flag("script", draft.script !== "")}>
                        <Textarea className="font-mono text-xs" rows={8} value={draft.script} onChange={(event) => set("script", event.target.value)} />
                    </Field>
                    <p className="text-xs text-muted-foreground">{t("settings.customTools.scriptHint")}</p>
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {t("settings.customTools.cancel")}
                    </Button>
                    <Button onClick={save} aria-disabled={!parsed.success || unchanged || pending} disabled={!parsed.success || unchanged || pending}>
                        {t("settings.customTools.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PluginDialog({
    editing,
    tools,
    onClose,
    onSaved
}: {
    editing: StoredPlugin | "new" | null;
    tools: StoredTool[];
    onClose: () => void;
    onSaved: (plugin: StoredPlugin) => void;
}) {
    const t = useTranslations("polar");
    const current = editing === "new" ? null : editing;
    const initial = (): shared.PluginInput =>
        current ?? { name: "", events: [], action: { kind: "webhook", url: "" }, enabled: true };
    const [draft, setDraft] = useState<shared.PluginInput>(initial);
    const [opened, setOpened] = useState(editing);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    if (opened !== editing) {
        setOpened(editing);
        setDraft(initial());
        setError(null);
    }
    const parsed = shared.pluginSchema.safeParse(draft);
    const unchanged = JSON.stringify(draft) === JSON.stringify(initial());
    const runnable = tools.filter((tool) => tool.permission === "allow");
    const save = () => {
        if (!parsed.success) return;
        startTransition(async () => {
            const result = await actions.savePlugin(current?.id ?? null, parsed.data);
            if (!result.ok) return setError(result.error);
            onSaved(result.value);
            onClose();
        });
    };
    const action = draft.action;
    const urlBad = action.kind === "webhook" && action.url !== "" && !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === "action");
    return (
        <Dialog open={editing !== null} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t(current ? "settings.customTools.plugins.editTitle" : "settings.customTools.plugins.addTitle")}</DialogTitle>
                    <DialogDescription>{t("settings.customTools.plugins.hint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <Field label={`${t("settings.customTools.fields.name")} *`}>
                        <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                    </Field>
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm font-medium">{t("settings.customTools.plugins.events")} *</legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {shared.PLUGIN_EVENTS.map((event) => (
                                <label key={event} className="flex min-w-0 items-center gap-2 text-sm">
                                    <Checkbox
                                        checked={draft.events.includes(event)}
                                        onChange={(change) =>
                                            setDraft({
                                                ...draft,
                                                events: change.target.checked ? [...draft.events, event] : draft.events.filter((entry) => entry !== event)
                                            })
                                        }
                                    />
                                    <span className="truncate">{t(`settings.customTools.events.${event.replace(".", "_")}` as never)}</span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <Field label={t("settings.customTools.plugins.action")}>
                        <Select
                            value={action.kind}
                            options={[
                                { value: "webhook", label: t("settings.customTools.plugins.webhook") },
                                { value: "tool", label: t("settings.customTools.plugins.tool") }
                            ]}
                            onValueChange={(kind) =>
                                setDraft({
                                    ...draft,
                                    action: kind === "tool" ? { kind: "tool", tool: runnable[0]?.name ?? "" } : { kind: "webhook", url: "" }
                                })
                            }
                        />
                    </Field>
                    {action.kind === "webhook" ? (
                        <Field label={`${t("settings.customTools.plugins.url")} *`} error={urlBad ? t("settings.customTools.invalid.url") : null}>
                            <Input
                                value={action.url}
                                placeholder="https://"
                                onChange={(event) => setDraft({ ...draft, action: { kind: "webhook", url: event.target.value } })}
                            />
                        </Field>
                    ) : runnable.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("settings.customTools.plugins.noRunnable")}</p>
                    ) : (
                        <Field label={t("settings.customTools.plugins.tool")}>
                            <Select
                                value={action.tool}
                                options={runnable.map((tool) => ({ value: tool.name, label: shared.turnToolName(tool.name) }))}
                                onValueChange={(tool) => setDraft({ ...draft, action: { kind: "tool", tool } })}
                            />
                        </Field>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {t("settings.customTools.cancel")}
                    </Button>
                    <Button onClick={save} aria-disabled={!parsed.success || unchanged || pending} disabled={!parsed.success || unchanged || pending}>
                        {t("settings.customTools.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ProjectTools({ readOnly }: { readOnly: boolean }) {
    const t = useTranslations("polar");
    const [review, setReview] = useState<actions.ProjectToolsView | null | "none">(null);
    const [noNode, setNoNode] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const load = () =>
        startTransition(async () => {
            setError(null);
            const [result, skipped] = await Promise.all([actions.reviewProjectTools(), actions.sessionToolsSkipped()]);
            setNoNode(skipped.ok && skipped.value);
            if (!result.ok) return setError(result.error);
            setReview(result.value ?? "none");
        });
    const approve = (view: actions.ProjectToolsView) => {
        setReview({ ...view, approved: true });
        startTransition(async () => {
            const result = await actions.approveProjectTools(view.sessionId, view.digest);
            if (!result.ok) {
                setReview(view);
                setError(result.error);
            }
        });
    };
    return (
        <section className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold">{t("settings.customTools.project.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("settings.customTools.project.intro")}</p>
                </div>
                <Button size="sm" variant="outline" onClick={load} disabled={pending}>
                    {t("settings.customTools.project.review")}
                </Button>
            </div>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {noNode && (
                <p role="status" className="text-sm text-destructive">
                    {t("settings.customTools.project.noNode")}
                </p>
            )}
            {review === "none" && <p className="text-sm text-muted-foreground">{t("settings.customTools.project.none")}</p>}
            {review && review !== "none" && (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        {review.tools.map((tool) => (
                            <details key={tool.path} className="min-w-0">
                                <summary className="cursor-pointer truncate text-sm">
                                    <span className="font-mono">{shared.turnToolName(tool.name)}</span> - {tool.description}
                                </summary>
                                <p className="mt-1 truncate text-xs text-muted-foreground" title={tool.path}>
                                    {tool.path}
                                </p>
                                <pre className="mt-1 max-h-60 overflow-auto overscroll-contain rounded bg-muted p-2 text-xs">{tool.script}</pre>
                            </details>
                        ))}
                        {review.modules.map((module) => (
                            <details key={module.path} className="min-w-0">
                                <summary className="cursor-pointer truncate text-sm">
                                    <span className="font-mono">{module.path}</span> -{" "}
                                    <span className={module.status === "ready" ? "" : "text-muted-foreground"}>
                                        {t(`settings.customTools.project.module.${module.status}`)}
                                    </span>
                                </summary>
                                <pre className="mt-1 max-h-60 overflow-auto overscroll-contain rounded bg-muted p-2 text-xs">{module.source}</pre>
                            </details>
                        ))}
                        {review.refused.length > 0 && (
                            <p className="text-xs text-destructive">
                                {t("settings.customTools.project.refused", { files: review.refused.join(", ") })}
                            </p>
                        )}
                        {review.approved ? (
                            <p className="text-sm">{t("settings.customTools.project.approved")}</p>
                        ) : (
                            !readOnly &&
                            (review.tools.length > 0 || review.modules.length > 0) && (
                                <div className="flex justify-end">
                                    <Button size="sm" onClick={() => approve(review)} disabled={pending}>
                                        {t("settings.customTools.project.approve")}
                                    </Button>
                                </div>
                            )
                        )}
                    </CardBody>
                </Card>
            )}
        </section>
    );
}

function Field({ label, error = null, children }: { label: string; error?: string | null; children: React.ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="font-medium">{label}</span>
            {children}
            {error && <span className="text-xs text-destructive">{error}</span>}
        </label>
    );
}
