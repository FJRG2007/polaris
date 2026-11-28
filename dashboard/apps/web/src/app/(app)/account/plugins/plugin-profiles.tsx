"use client";

/**
 * A plugin's profiles on its page (manifest `profiles`), the way Stream Deck
 * keeps them: a picker (Automatic, or one profile by hand), the profile in use
 * and why, new / duplicate / rename / delete, and the rules that switch to the
 * profile in use by themselves. The settings drawn below change the profile in
 * use, as Stream Deck's editor changes the profile it shows.
 */

import { useState, type ReactNode } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import type { PluginsBridge } from "@/lib/device-plugins-client";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, settingType, Switch, useToast } from "@polaris/ui";
import { DEFAULT_PLUGIN_PROFILE, MAX_PLUGIN_PROFILES, pluginProgramKey, type PluginProfileRequest, type PluginProfileRules, type PluginProfilesView } from "@polaris/core/device-plugins";

type Words = ReturnType<typeof useTranslations<"account">>;

const AUTOMATIC = "auto";

function say(t: Words, key: string, values?: Record<string, string | number>): string {
    return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(`plugins.profiles.${key}`, values);
}

/** Why a profile name cannot be used, as a message key, or null when it can. */
export function profileNameProblem(name: string, taken: readonly string[]): "empty" | "long" | "taken" | null {
    const trimmed = name.trim();
    if (!trimmed) return "empty";
    if (trimmed.length > 40) return "long";
    const lower = trimmed.toLowerCase();
    if (lower === DEFAULT_PLUGIN_PROFILE || taken.some((other) => other.trim().toLowerCase() === lower)) return "taken";
    return null;
}

/** The sentence that says why the profile in use is the one in use. */
export function profileWhyKey(active: PluginProfilesView["active"]): { key: string; subject: string } {
    return { key: `why.${active.reason}`, subject: active.subject ?? "" };
}

interface NameAsk {
    readonly title: string;
    readonly confirm: string;
    readonly initial: string;
    /** Names already in use, the one being renamed left out. */
    readonly taken: readonly string[];
    readonly run: (name: string) => Promise<string | null>;
}

function NameDialog({ ask, onClose }: { ask: NameAsk | null; onClose: () => void }) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [opened, setOpened] = useState<NameAsk | null>(null);
    if (ask !== opened) {
        setOpened(ask);
        setName(ask?.initial ?? "");
        setFailed(null);
        setBusy(false);
    }
    const problem = ask ? profileNameProblem(name, ask.taken) : null;
    // An empty field is unfinished, not wrong: only a name that is too long or taken says so.
    const shown = problem && problem !== "empty" ? say(t, `name.${problem}`) : failed;
    const unchanged = ask !== null && name.trim() === ask.initial.trim() && ask.initial !== "";
    const submit = () => {
        if (!ask || problem || busy || unchanged) return;
        setBusy(true);
        void ask.run(name.trim()).then((error) => {
            setBusy(false);
            if (error) setFailed(error);
            else onClose();
        });
    };
    return (
        <Dialog open={ask !== null} onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{ask?.title}</DialogTitle>
                    <DialogDescription>{say(t, "name.hint")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <label className={cn(settingType.body, "font-medium")} htmlFor="plugin-profile-name">
                        {say(t, "name.label")} <span aria-hidden="true">*</span>
                    </label>
                    <Input
                        id="plugin-profile-name"
                        autoFocus
                        value={name}
                        maxLength={60}
                        aria-invalid={shown ? true : undefined}
                        onChange={(event) => {
                            setName(event.target.value);
                            setFailed(null);
                        }}
                    />
                    {shown ? (
                        <p role="alert" className={cn(settingType.hint, "text-destructive")}>
                            {shown}
                        </p>
                    ) : null}
                    <DialogFooter className="mt-2">
                        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={Boolean(problem) || unchanged || busy} disabled={busy}>
                            {ask?.confirm}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RuleRow({ label, hint, children }: { label: string; hint?: string | null; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 flex-1 basis-48">
                <p className={cn(settingType.body, "font-medium")}>{label}</p>
                {hint ? <p className={settingType.hint}>{hint}</p> : null}
            </div>
            {children}
        </div>
    );
}

function AppsRule({ apps, disabled, onChange }: { apps: readonly string[]; disabled: string | null; onChange: (apps: string[]) => void }) {
    const t = useTranslations("account");
    const [typed, setTyped] = useState("");
    const key = pluginProgramKey(typed);
    const add = () => {
        if (!key || apps.includes(key) || apps.length >= 16) return;
        onChange([...apps, key]);
        setTyped("");
    };
    return (
        <div className="flex min-w-0 flex-col gap-2 py-2">
            <p className={cn(settingType.body, "font-medium")}>{say(t, "rules.apps")}</p>
            <p className={settingType.hint}>{disabled ?? say(t, "rules.appsHint")}</p>
            {apps.length > 0 ? (
                <ul className="flex min-w-0 flex-wrap gap-2">
                    {apps.map((app) => (
                        <li key={app} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2 py-1">
                            <span className={cn(settingType.body, "min-w-0 truncate")} title={app}>
                                {app}
                            </span>
                            <button
                                type="button"
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                aria-label={say(t, "rules.remove", { app })}
                                onClick={() => onChange(apps.filter((item) => item !== app))}
                            >
                                <X className="size-3.5 shrink-0" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <form
                className="flex min-w-0 flex-wrap gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    add();
                }}
            >
                <Input
                    className="min-w-0 flex-1 basis-48"
                    value={typed}
                    maxLength={260}
                    disabled={disabled !== null}
                    placeholder={say(t, "rules.appsPlaceholder")}
                    aria-label={say(t, "rules.apps")}
                    onChange={(event) => setTyped(event.target.value)}
                />
                <Button type="submit" variant="secondary" disabled={disabled !== null} aria-disabled={!key || apps.includes(key) || apps.length >= 16}>
                    {say(t, "rules.add")}
                </Button>
            </form>
        </div>
    );
}

export function PluginProfiles({ bridge, id, profiles }: { bridge: PluginsBridge; id: string; profiles: PluginProfilesView }) {
    const t = useTranslations("account");
    const toast = useToast();
    const [confirm, confirmElement] = useConfirm();
    const [ask, setAsk] = useState<NameAsk | null>(null);
    // A pick or a rule shows at once; the app's next snapshot replaces it, a refusal puts it back.
    const [optimistic, setOptimistic] = useState<{ readonly manual?: string | null; readonly rules?: PluginProfileRules } | null>(null);
    const [seen, setSeen] = useState(profiles);
    if (seen !== profiles) {
        setSeen(profiles);
        setOptimistic(null);
    }

    const send = (request: PluginProfileRequest): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> =>
        (bridge.profile?.(id, request) ?? Promise.resolve(null))
            .then((answer) => {
                const read = answer as { ok?: unknown; id?: unknown; error?: unknown } | null;
                if (read && read.ok === true) return { ok: true as const, id: typeof read.id === "string" ? read.id : null };
                return { ok: false as const, error: typeof read?.error === "string" ? read.error : "failed" };
            })
            .catch(() => ({ ok: false as const, error: "failed" }));
    const failure = (error: string) => say(t, error === "name-taken" ? "name.taken" : error === "full" ? "full" : "failed");

    const manual = optimistic && "manual" in optimistic ? (optimistic.manual ?? null) : profiles.manual;
    const activeId = manual ?? profiles.active.id;
    const active = profiles.list.find((item) => item.id === activeId) ?? null;
    const activeName = active?.name ?? say(t, "default");
    const rules = optimistic?.rules ?? active?.rules ?? null;
    const names = profiles.list.map((item) => item.name);
    const why = manual ? { key: "why.manual", subject: "" } : profileWhyKey(profiles.active);
    const full = profiles.list.length >= MAX_PLUGIN_PROFILES;

    const pick = (value: string) => {
        const next = value === AUTOMATIC ? null : value;
        if (next === profiles.manual) return;
        setOptimistic({ manual: next });
        void send({ op: "pick", profile: next }).then((answer) => {
            if (answer.ok) return;
            setOptimistic(null);
            toast.show({ title: failure(answer.error) });
        });
    };

    const setRules = (next: PluginProfileRules) => {
        if (!active) return;
        setOptimistic((before) => ({ ...before, rules: next }));
        void send({ op: "rules", profile: active.id, rules: next }).then((answer) => {
            if (answer.ok) return;
            setOptimistic(null);
            toast.show({ title: failure(answer.error) });
        });
    };

    // A new or duplicated profile is picked straight away, so the settings below are its own.
    const create = (from: string | undefined) =>
        setAsk({
            title: say(t, from === undefined ? "newTitle" : "duplicateTitle"),
            confirm: say(t, from === undefined ? "create" : "duplicate"),
            initial: from === undefined ? "" : say(t, "copyOf", { name: activeName }).slice(0, 40),
            taken: names,
            run: async (name) => {
                const answer = await send({ op: "create", name, ...(from === undefined ? {} : { from }) });
                if (!answer.ok) return failure(answer.error);
                if (answer.id) void send({ op: "pick", profile: answer.id });
                return null;
            }
        });

    const rename = () => {
        if (!active) return;
        setAsk({
            title: say(t, "renameTitle"),
            confirm: say(t, "rename"),
            initial: active.name,
            taken: names.filter((name) => name !== active.name),
            run: async (name) => {
                const answer = await send({ op: "rename", profile: active.id, name });
                return answer.ok ? null : failure(answer.error);
            }
        });
    };

    const remove = () => {
        if (!active) return;
        void (async () => {
            const ok = await confirm({ title: say(t, "deleteTitle", { name: active.name }), description: say(t, "deleteBody"), confirmLabel: say(t, "delete"), danger: true });
            if (!ok) return;
            const answer = await send({ op: "delete", profile: active.id });
            if (!answer.ok) toast.show({ title: failure(answer.error) });
        })();
    };

    const options = [
        { value: AUTOMATIC, label: say(t, "automatic") },
        { value: DEFAULT_PLUGIN_PROFILE, label: say(t, "default") },
        ...profiles.list.map((item) => ({ value: item.id, label: item.name }))
    ];
    const notHere = say(t, "rules.windowsOnly");

    return (
        <section aria-label={say(t, "title")} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1 basis-48">
                    <p className={cn(settingType.body, "font-medium")}>{say(t, "title")}</p>
                    <p className={cn(settingType.hint, "break-words")} aria-live="polite">
                        {say(t, "inUse", { name: activeName })} {say(t, why.key, { subject: why.subject })}
                    </p>
                </div>
                <Select value={manual ?? AUTOMATIC} onValueChange={pick} aria-label={say(t, "pick")} className="w-full sm:w-56" options={options} />
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={full} title={full ? say(t, "full") : undefined} onClick={() => create(undefined)}>
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    {say(t, "new")}
                </Button>
                <Button size="sm" variant="secondary" disabled={full} title={full ? say(t, "full") : undefined} onClick={() => create(activeId)}>
                    <Copy className="size-4 shrink-0" aria-hidden="true" />
                    {say(t, "duplicate")}
                </Button>
                <Button size="sm" variant="ghost" disabled={!active} title={active ? undefined : say(t, "defaultFixed")} onClick={rename}>
                    <Pencil className="size-4 shrink-0" aria-hidden="true" />
                    {say(t, "rename")}
                </Button>
                <Button size="sm" variant="ghost" disabled={!active} title={active ? undefined : say(t, "defaultFixed")} onClick={remove}>
                    <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                    {say(t, "delete")}
                </Button>
            </div>
            <p className={settingType.hint}>{say(t, "editsInUse", { name: activeName })}</p>
            {active && rules ? (
                <div className="flex min-w-0 flex-col border-t border-border pt-2">
                    <p className={cn(settingType.body, "font-medium")}>{say(t, "rules.title", { name: active.name })}</p>
                    <p className={settingType.hint}>{say(t, "rules.order")}</p>
                    <RuleRow label={say(t, "rules.call")}>
                        <Switch checked={rules.call} onChange={(call) => setRules({ ...rules, call })} aria-label={say(t, "rules.call")} />
                    </RuleRow>
                    <RuleRow label={say(t, "rules.meeting")} hint={profiles.reads.meeting ? say(t, "rules.meetingHint") : notHere}>
                        <Switch checked={rules.meeting} disabled={!profiles.reads.meeting} onChange={(meeting) => setRules({ ...rules, meeting })} aria-label={say(t, "rules.meeting")} />
                    </RuleRow>
                    <RuleRow label={say(t, "rules.game")}>
                        <Switch checked={rules.game} onChange={(game) => setRules({ ...rules, game })} aria-label={say(t, "rules.game")} />
                    </RuleRow>
                    <AppsRule apps={rules.apps} disabled={profiles.reads.front ? null : notHere} onChange={(apps) => setRules({ ...rules, apps })} />
                </div>
            ) : (
                <p className={settingType.hint}>{say(t, "defaultRules")}</p>
            )}
            <NameDialog ask={ask} onClose={() => setAsk(null)} />
            {confirmElement}
        </section>
    );
}
