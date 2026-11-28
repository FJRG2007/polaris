"use client";

/**
 * Custom actions for a device's buttons and knob presses (docs/device-plugins.md,
 * "Custom actions"): open a file, folder or website, run a program, press a
 * hotkey, run a Polaris entry, or several of those with pauses, with an
 * optional second state that the next press runs (Stream Deck's Open,
 * Website, Hotkey, Multi Action and Multi Action Switch). The desktop keeps
 * and checks them; this page only edits, and a new or changed one is
 * confirmed in the desktop before it first runs.
 */

import { useConfirm } from "@/components/confirm-dialog";
import type { PluginsBridge } from "@/lib/device-plugins-client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDown, ArrowUp, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { CodeEditor } from "@/components/json-view";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, settingType, Switch, useToast } from "@polaris/ui";
import {
    CUSTOM_ACTION_PREFIX,
    DEVICE_ACTION_KEYS,
    deviceActionSchema,
    LAUNCHER_ACTION_PREFIX,
    PLUGIN_ACTIONS,
    type DeviceAction,
    type DeviceActionStep,
    type DeviceActionsView
} from "@polaris/core/device-plugins";

type Words = ReturnType<typeof useTranslations>;
type Step = DeviceActionStep;
type Kind = Step["kind"];

const KINDS: readonly Kind[] = ["open", "website", "run", "hotkey", "launcher", "polaris", "delay"];

function say(t: Words, key: string, values?: Record<string, string | number>): string {
    return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(`plugins.actions.${key}`, values);
}

/* What the desktop last answered, shared by the editor and every action picker on the page. */
let view: DeviceActionsView | null = null;
const listeners = new Set<() => void>();
function publish(next: DeviceActionsView | null): void {
    view = next;
    for (const listener of listeners) listener();
}

async function ask(bridge: PluginsBridge, request: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    try {
        const answer = (await bridge.actions?.(request)) as { ok?: unknown; value?: unknown; error?: unknown } | null;
        return { ok: answer?.ok === true, value: answer?.value, error: typeof answer?.error === "string" ? answer.error : undefined };
    } catch {
        return { ok: false, error: "failed" };
    }
}

async function reload(bridge: PluginsBridge): Promise<void> {
    const answer = await ask(bridge, { kind: "list" });
    if (answer.ok && answer.value) publish(answer.value as DeviceActionsView);
}

/** The custom actions and launcher entries an `action` setting can pick, as select options. */
export function useDeviceActionOptions(): { value: string; label: string }[] {
    const current = useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => view,
        () => null
    );
    if (!current) return [];
    return [
        ...current.actions.map((action) => ({ value: `${CUSTOM_ACTION_PREFIX}${action.id}`, label: action.name })),
        ...current.launcher.map((item) => ({ value: `${LAUNCHER_ACTION_PREFIX}${item.entry}`, label: item.label }))
    ];
}

/** A new step of `kind` with nothing chosen yet. */
export function blankStep(kind: Kind): Step {
    switch (kind) {
        case "open":
            return { kind, path: "" };
        case "website":
            return { kind, url: "https://" };
        case "run":
            return { kind, file: "", args: [] };
        case "hotkey":
            return { kind, key: "m", ctrl: true, alt: false, shift: false, meta: false };
        case "launcher":
            return { kind, entry: "system:lock" };
        case "polaris":
            return { kind, action: "call.mic" };
        case "delay":
            return { kind, ms: 200 };
    }
}

/** Arguments typed one per line: each line is one argument, passed as is. */
export function argsFromText(text: string): string[] {
    return text.split(/\r?\n/).filter((line) => line.length > 0);
}

function newId(): string {
    return globalThis.crypto.randomUUID().toLowerCase();
}

/**
 * A program's arguments, one per line. The box keeps what is typed - a new
 * empty line included, so a second argument can be started - and hands on only
 * the lines that hold something.
 */
function ArgsField({ args, label, onChange }: { args: readonly string[]; label: string; onChange: (args: string[]) => void }) {
    const [text, setText] = useState(() => args.join("\n"));
    // Another step loaded into this slot: show its arguments, not what was typed before.
    useEffect(() => {
        setText((typed) => (argsFromText(typed).join("\n") === args.join("\n") ? typed : args.join("\n")));
    }, [args]);
    return (
        <CodeEditor
            value={text}
            language={null}
            label={label}
            placeholder={label}
            onChange={(next) => {
                setText(next);
                onChange(argsFromText(next));
            }}
        />
    );
}

function StepEditor({ bridge, step, onChange, launcher, hotkeys }: { bridge: PluginsBridge; step: Step; onChange: (step: Step) => void; launcher: DeviceActionsView["launcher"]; hotkeys: string | null }) {
    const t = useTranslations("account");
    const pick = async (what: "file" | "folder" | "program") => {
        const answer = await ask(bridge, { kind: "pick", what });
        return typeof answer.value === "string" ? answer.value : null;
    };
    switch (step.kind) {
        case "open":
            return (
                <div className="flex min-w-0 flex-wrap gap-2">
                    <Input className="min-w-0 flex-1" value={step.path} placeholder={say(t, "field.path")} aria-label={say(t, "field.path")} onChange={(event) => onChange({ ...step, path: event.target.value })} />
                    <Button variant="secondary" onClick={async () => { const path = await pick("file"); if (path) onChange({ ...step, path }); }}>{say(t, "pickFile")}</Button>
                    <Button variant="secondary" onClick={async () => { const path = await pick("folder"); if (path) onChange({ ...step, path }); }}>{say(t, "pickFolder")}</Button>
                </div>
            );
        case "website":
            return <Input value={step.url} aria-label={say(t, "field.url")} onChange={(event) => onChange({ ...step, url: event.target.value })} />;
        case "run":
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 gap-2">
                        <Input className="min-w-0 flex-1" value={step.file} placeholder={say(t, "field.program")} aria-label={say(t, "field.program")} onChange={(event) => onChange({ ...step, file: event.target.value })} />
                        <Button variant="secondary" onClick={async () => { const file = await pick("program"); if (file) onChange({ ...step, file }); }}>{say(t, "pickProgram")}</Button>
                    </div>
                    <ArgsField args={step.args} label={say(t, "field.args")} onChange={(args) => onChange({ ...step, args })} />
                </div>
            );
        case "hotkey":
            return (
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                    {(["ctrl", "alt", "shift", "meta"] as const).map((modifier) => (
                        <label key={modifier} className={cn("flex items-center gap-2", settingType.body)}>
                            <Switch checked={step[modifier]} onChange={(checked) => onChange({ ...step, [modifier]: checked })} aria-label={say(t, `modifier.${modifier}`)} />
                            {say(t, `modifier.${modifier}`)}
                        </label>
                    ))}
                    <Select value={step.key} onValueChange={(key) => onChange({ ...step, key })} aria-label={say(t, "field.key")} className="w-40" options={DEVICE_ACTION_KEYS.map((key) => ({ value: key, label: key.length === 1 ? key.toUpperCase() : key }))} />
                    {hotkeys ? <p className={cn("w-full", settingType.hint)}>{say(t, "hotkeysUnsupported")}</p> : null}
                </div>
            );
        case "launcher":
            return <Select value={step.entry} onValueChange={(entry) => onChange({ ...step, entry })} aria-label={say(t, "kind.launcher")} className="w-full" options={launcher.map((item) => ({ value: item.entry, label: item.label }))} />;
        case "polaris":
            return (
                <Select
                    value={step.action}
                    onValueChange={(action) => onChange({ ...step, action: action as (typeof PLUGIN_ACTIONS)[number] })}
                    aria-label={say(t, "kind.polaris")}
                    className="w-full"
                    options={PLUGIN_ACTIONS.filter((action) => action !== "call.leave").map((action) => ({ value: action, label: (t as unknown as (key: string) => string)(`plugins.action.${action.slice("call.".length)}`) }))}
                />
            );
        case "delay":
            return <Input type="number" min={0} max={10_000} step={50} value={String(step.ms)} aria-label={say(t, "field.ms")} onChange={(event) => onChange({ ...step, ms: Math.max(0, Math.min(10_000, Math.round(Number(event.target.value) || 0))) })} />;
    }
}

function StepsEditor({ bridge, steps, onChange, launcher, hotkeys }: { bridge: PluginsBridge; steps: Step[]; onChange: (steps: Step[]) => void; launcher: DeviceActionsView["launcher"]; hotkeys: string | null }) {
    const t = useTranslations("account");
    const set = (index: number, step: Step) => onChange(steps.map((item, at) => (at === index ? step : item)));
    const move = (index: number, by: number) => {
        const next = [...steps];
        const [item] = next.splice(index, 1);
        next.splice(index + by, 0, item!);
        onChange(next);
    };
    return (
        <ol className="flex flex-col gap-3">
            {steps.map((step, index) => (
                <li key={index} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Select value={step.kind} onValueChange={(kind) => set(index, blankStep(kind as Kind))} aria-label={say(t, "field.kind")} className="min-w-0 flex-1" options={KINDS.map((kind) => ({ value: kind, label: say(t, `kind.${kind}`) }))} />
                        <Button variant="ghost" size="icon" aria-label={say(t, "up")} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-4 shrink-0" /></Button>
                        <Button variant="ghost" size="icon" aria-label={say(t, "down")} disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-4 shrink-0" /></Button>
                        <Button variant="ghost" size="icon" aria-label={say(t, "removeStep")} disabled={steps.length === 1} onClick={() => onChange(steps.filter((_, at) => at !== index))}><X className="size-4 shrink-0" /></Button>
                    </div>
                    <StepEditor bridge={bridge} step={step} onChange={(next) => set(index, next)} launcher={launcher} hotkeys={hotkeys} />
                </li>
            ))}
        </ol>
    );
}

type Draft = { id: string; name: string; steps: Step[]; off: Step[] | null };

function ActionDialog({ bridge, draft, onClose, launcher, hotkeys }: { bridge: PluginsBridge; draft: Draft | null; onClose: () => void; launcher: DeviceActionsView["launcher"]; hotkeys: string | null }) {
    const t = useTranslations("account");
    const toast = useToast();
    const [edit, setEdit] = useState<Draft | null>(draft);
    const [saving, setSaving] = useState(false);
    useEffect(() => setEdit(draft), [draft]);
    const parsed = edit ? deviceActionSchema.safeParse({ id: edit.id, name: edit.name, steps: edit.steps, ...(edit.off ? { off: edit.off } : {}) }) : null;
    const problem = parsed && !parsed.success ? (parsed.error.issues[0]?.path.join(".") ?? "") : null;
    const save = async () => {
        if (!parsed?.success) return;
        setSaving(true);
        const answer = await ask(bridge, { kind: "save", action: parsed.data });
        setSaving(false);
        if (!answer.ok) return toast.show({ title: say(t, "failed") });
        await reload(bridge);
        onClose();
    };
    return (
        <Dialog open={edit !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{say(t, "dialog.title")}</DialogTitle>
                    <DialogDescription>{say(t, "dialog.hint")}</DialogDescription>
                </DialogHeader>
                {edit ? (
                    <div className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain">
                        <Input value={edit.name} maxLength={60} placeholder={say(t, "field.name")} aria-label={say(t, "field.name")} onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
                        <StepsEditor bridge={bridge} steps={edit.steps} onChange={(steps) => setEdit({ ...edit, steps })} launcher={launcher} hotkeys={hotkeys} />
                        <Button variant="secondary" className="self-start" onClick={() => setEdit({ ...edit, steps: [...edit.steps, blankStep("delay")] })}>
                            <Plus className="size-4 shrink-0" />
                            {say(t, "addStep")}
                        </Button>
                        <label className={cn("flex items-center gap-2", settingType.body)}>
                            <Switch checked={edit.off !== null} onChange={(checked) => setEdit({ ...edit, off: checked ? [blankStep("hotkey")] : null })} aria-label={say(t, "twoStates")} />
                            {say(t, "twoStates")}
                        </label>
                        {edit.off ? (
                            <div className="flex flex-col gap-2">
                                <p className={settingType.hint}>{say(t, "secondState")}</p>
                                <StepsEditor bridge={bridge} steps={edit.off} onChange={(off) => setEdit({ ...edit, off })} launcher={launcher} hotkeys={hotkeys} />
                                <Button variant="secondary" className="self-start" onClick={() => setEdit({ ...edit, off: [...(edit.off ?? []), blankStep("delay")] })}>
                                    <Plus className="size-4 shrink-0" />
                                    {say(t, "addStep")}
                                </Button>
                            </div>
                        ) : null}
                        {problem !== null ? <p className={settingType.error}>{say(t, "incomplete")}</p> : null}
                    </div>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>{say(t, "cancel")}</Button>
                    <Button onClick={save} disabled={!parsed?.success || saving} aria-disabled={!parsed?.success}>{say(t, "save")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The list of custom actions on this computer, with New, Edit, Try and Delete. */
export function PluginActions({ bridge }: { bridge: PluginsBridge }) {
    const t = useTranslations("account");
    const toast = useToast();
    const [confirm, confirmElement] = useConfirm();
    const [draft, setDraft] = useState<Draft | null>(null);
    const current = useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => view,
        () => null
    );
    useEffect(() => {
        void reload(bridge);
    }, [bridge]);
    if (!bridge.actions) return null;
    const launcher = current?.launcher ?? [];
    const hotkeys = current?.hotkeys ?? null;
    const open = (action: DeviceAction | null) =>
        setDraft(action ? { id: action.id, name: action.name, steps: action.steps, off: action.off ?? null } : { id: newId(), name: "", steps: [blankStep("open")], off: null });
    const run = async (id: string) => {
        const answer = await ask(bridge, { kind: "run", id });
        const outcome = typeof answer.value === "string" ? answer.value : "failed";
        if (outcome === "ran") toast.show({ title: say(t, "ran") });
        else if (outcome !== "declined" && outcome !== "busy") toast.show({ title: say(t, "runFailed") });
        await reload(bridge);
    };
    const remove = async (action: DeviceAction) => {
        if (!(await confirm({ title: say(t, "remove.title", { name: action.name }), description: say(t, "remove.hint"), confirmLabel: say(t, "remove.confirm"), danger: true }))) return;
        const previous = view;
        if (previous) publish({ ...previous, actions: previous.actions.filter((item) => item.id !== action.id) });
        const answer = await ask(bridge, { kind: "remove", id: action.id });
        if (!answer.ok) {
            publish(previous);
            toast.show({ title: say(t, "failed") });
        }
    };
    return (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="plugin-actions-title">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <h3 id="plugin-actions-title" className="font-medium">{say(t, "title")}</h3>
                    <p className={settingType.hint}>{say(t, "hint")}</p>
                </div>
                <Button variant="secondary" onClick={() => open(null)}><Plus className="size-4 shrink-0" />{say(t, "new")}</Button>
            </div>
            {current === null ? null : current.actions.length === 0 ? (
                <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "empty")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {current.actions.map((action) => (
                        <li key={action.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <p className={cn("truncate font-medium", settingType.body)} title={action.name}>{action.name}</p>
                                <p className={cn("truncate text-muted-foreground", settingType.small)}>
                                    {say(t, "summary", { count: action.steps.length })}
                                    {action.off ? ` - ${say(t, action.on ? "stateSecond" : "stateFirst")}` : ""}
                                    {action.confirmed ? "" : ` - ${say(t, "unconfirmed")}`}
                                </p>
                            </div>
                            <Button variant="ghost" size="icon" aria-label={say(t, "try")} onClick={() => void run(action.id)}><Play className="size-4 shrink-0" /></Button>
                            <Button variant="ghost" size="icon" aria-label={say(t, "edit")} onClick={() => open(action)}><Pencil className="size-4 shrink-0" /></Button>
                            <Button variant="ghost" size="icon" aria-label={say(t, "remove.confirm")} onClick={() => void remove(action)}><Trash2 className="size-4 shrink-0" /></Button>
                        </li>
                    ))}
                </ul>
            )}
            <ActionDialog bridge={bridge} draft={draft} onClose={() => setDraft(null)} launcher={launcher} hotkeys={hotkeys} />
            {confirmElement}
        </section>
    );
}
