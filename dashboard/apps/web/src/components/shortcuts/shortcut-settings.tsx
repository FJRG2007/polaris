"use client";

/**
 * The one screen where shortcuts are seen and moved, drawn the same in every
 * app: the account page lists every app, and each app's `?` opens it on that
 * app alone.
 *
 * Boxes per group with a row per action, as the diagram editor's help draws
 * them, and on each row the keys it answers to now. A key can be removed, a new
 * one recorded - press "add", then the keys - and a moved action put back. A
 * recorded key is checked as it is pressed: one the browser keeps or that moves
 * focus is refused, and one another action already answers to here names that
 * action. Every change is saved at once and put back, with a toast, if the
 * server refuses it.
 *
 * Changes go to the account unless "This device only" is on; then they are
 * kept in this browser, over the account's - a laptop's keyboard is not the
 * desktop's. A row moved on this device says so.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { Plus, RotateCcw, Search } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
    Button,
    Input,
    Select,
    ShortcutSheet,
    Switch,
    currentShortcutOverrides,
    setAccountShortcuts,
    useShortcutBindings,
    useShortcutText,
    useToast,
    writeDeviceShortcuts,
    type ShortcutSheetGroup
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { saveShortcutsAction } from "@/app/(app)/shortcut-actions";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type T = NamespaceTranslator<"shortcuts">;

/** What an action is called, from the catalog by its id. */
export function shortcutLabel(t: T, id: string): string {
    const key = `actions.${id}` as NamespaceKey<"shortcuts">;
    return t.has(key) ? t(key) : id;
}

function groupTitle(t: T, group: string): string {
    const key = `groups.${group}` as NamespaceKey<"shortcuts">;
    return t.has(key) ? t(key) : group;
}

function appTitle(t: T, app: string): string {
    const key = `apps.${app}` as NamespaceKey<"shortcuts">;
    return t.has(key) ? t(key) : app;
}

const ICON = "size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground";

/** A layer's changes with one action set, or back to "no change" when the keys
 *  are what the layer under it already gives. */
function setIn(
    layer: core.ShortcutOverrides,
    under: readonly string[],
    id: string,
    bindings: readonly string[]
): core.ShortcutOverrides {
    if (core.sameBindings(bindings, under)) return core.withoutOverride(layer, id);
    return { ...layer, [id]: bindings.flatMap((binding) => core.normalizeBinding(binding) ?? []) };
}

export function ShortcutSettings({
    app,
    showAppFilter = false
}: {
    /** Only this app's actions, and the ones that work everywhere. */
    app?: core.ShortcutApp;
    /** Offer a choice of app above the list - the account page, which lists all. */
    showAppFilter?: boolean;
}) {
    const t = useTranslations("shortcuts");
    const toast = useToast();
    const [confirm, confirmNode] = useConfirm();
    const resolved = useShortcutBindings();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<string>(app ?? "all");
    const [deviceOnly, setDeviceOnly] = useState(false);
    const [recording, setRecording] = useState<string | null>(null);
    const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
    // The account's changes the server last accepted: a refused save returns
    // here, never to an optimistic set that was not saved either.
    const confirmed = useRef<core.ShortcutOverrides | null>(null);
    const latest = useRef<core.ShortcutOverrides | null>(null);
    const text = useShortcutText();

    const { account, device } = currentShortcutOverrides();
    const conflicts = useMemo(() => core.shortcutConflicts(resolved), [resolved]);

    function saveAccount(next: core.ShortcutOverrides) {
        confirmed.current ??= currentShortcutOverrides().account;
        latest.current = next;
        setAccountShortcuts(next);
        void saveShortcutsAction(next)
            .catch(() => ({ error: t("errors.notSaved"), overrides: undefined }))
            .then((answer) => {
                // Only undone while nothing newer replaced it: a later change is
                // saved whole and reports for itself.
                if (latest.current !== next) return;
                if (answer.error || !answer.overrides) {
                    setAccountShortcuts(confirmed.current ?? core.NO_SHORTCUT_OVERRIDES);
                    toast.show({ title: answer.error ?? t("errors.notSaved") });
                    return;
                }
                confirmed.current = answer.overrides;
                setAccountShortcuts(answer.overrides);
            });
    }

    function saveDevice(next: core.ShortcutOverrides) {
        if (!writeDeviceShortcuts(next)) toast.show({ title: t("errors.deviceNotSaved") });
    }

    function clashMessage(clash: core.ShortcutConflict, id: string): string {
        return t("errors.clash", {
            keys: text(clash.binding),
            action: shortcutLabel(t, clash.ids.find((other) => other !== id) ?? id).toLowerCase()
        });
    }

    /** Keep both layers as they will be stored, or say why not. The account's
     *  keys are saved and read back on their own and this device's over them,
     *  so a change may bring a clash into neither - one already there is not
     *  this change's to refuse. */
    function commit(
        id: string,
        nextAccount: core.ShortcutOverrides,
        nextDevice: core.ShortcutOverrides
    ): boolean {
        const clashes = (onAccount: core.ShortcutOverrides, onDevice: core.ShortcutOverrides) => [
            ...core.shortcutConflicts(core.resolveShortcuts(onAccount)),
            ...core.shortcutConflicts(core.resolveShortcuts(onAccount, onDevice))
        ];
        const signature = (clash: core.ShortcutConflict) => `${clash.binding} ${clash.ids.join(" ")}`;
        const before = new Set(clashes(account, device).map(signature));
        const brought = clashes(nextAccount, nextDevice).filter((clash) => !before.has(signature(clash)));
        const clash = brought.find((entry) => entry.ids.includes(id)) ?? brought[0];
        if (clash) {
            setProblem({ id, message: clashMessage(clash, id) });
            return false;
        }
        setProblem(null);
        if (nextDevice !== device) saveDevice(nextDevice);
        if (nextAccount !== account) saveAccount(nextAccount);
        return true;
    }

    /** Set an action's movable keys, in the layer this change belongs to: this
     *  device when it already moved the action or "this device only" is on. */
    function change(id: string, bindings: readonly string[]): boolean {
        const definition = core.shortcutDefinition(id);
        if (!definition) return false;
        const accountKeys = account[id] ?? definition.defaults;
        if (deviceOnly || id in device) return commit(id, account, setIn(device, accountKeys, id, bindings));
        return commit(id, setIn(account, definition.defaults, id, bindings), device);
    }

    function reset(id: string) {
        commit(id, core.withoutOverride(account, id), core.withoutOverride(device, id));
    }

    async function resetAll() {
        const sure = await confirm({
            title: t("resetAllConfirm"),
            description: t("resetAllHint"),
            confirmLabel: t("resetAll"),
            danger: true
        });
        if (!sure) return;
        saveDevice(core.NO_SHORTCUT_OVERRIDES);
        if (Object.keys(account).length > 0) saveAccount(core.NO_SHORTCUT_OVERRIDES);
        setProblem(null);
    }

    /** Take the keys just pressed for an action, or say why not. */
    function take(id: string, event: KeyboardEvent<HTMLButtonElement>) {
        // Tab still moves on, so nobody is trapped in the recorder.
        if (event.key === "Tab") {
            setRecording(null);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            setRecording(null);
            setProblem(null);
            return;
        }
        const binding = core.bindingOfEvent(event.nativeEvent);
        if (!binding) return;
        if (!core.isBindable(binding)) {
            setProblem({ id, message: t("errors.reserved", { keys: text(binding) }) });
            return;
        }
        const current = resolved.get(id) ?? [];
        if (current.includes(binding)) {
            setRecording(null);
            setProblem(null);
            return;
        }
        if (current.length >= core.MAX_BINDINGS_PER_SHORTCUT) {
            setProblem({ id, message: t("errors.tooMany", { count: core.MAX_BINDINGS_PER_SHORTCUT }) });
            return;
        }
        const clash = core.conflictsFor(resolved, id, binding)[0];
        if (clash) {
            setProblem({
                id,
                message: t("errors.clash", {
                    keys: text(binding),
                    action: shortcutLabel(t, clash).toLowerCase()
                })
            });
            return;
        }
        if (change(id, [...current, binding])) setRecording(null);
    }

    const needle = query.trim().toLowerCase();
    const shownApps = core.SHORTCUT_APPS.filter((name) =>
        filter === "all" ? true : name === filter || (app !== undefined && name === "general")
    );
    const groups: (ShortcutSheetGroup & { app: string })[] = [];
    for (const name of shownApps) {
        const definitions = core.SHORTCUTS.filter((definition) => definition.app === name);
        const byGroup = new Map<string, core.ShortcutDefinition[]>();
        for (const definition of definitions) {
            const keys = core.keysOf(resolved, definition.id);
            const haystack = [
                shortcutLabel(t, definition.id),
                appTitle(t, name),
                groupTitle(t, definition.group),
                ...keys.map(text)
            ]
                .join(" ")
                .toLowerCase();
            if (needle && !haystack.includes(needle)) continue;
            byGroup.set(definition.group, [...(byGroup.get(definition.group) ?? []), definition]);
        }
        for (const [group, members] of byGroup) {
            groups.push({
                id: `${name}:${group}`,
                app: name,
                title:
                    filter === "all" && !app
                        ? `${appTitle(t, name)} - ${groupTitle(t, group)}`
                        : groupTitle(t, group),
                rows: members.map((definition) => {
                    const id = definition.id;
                    const label = shortcutLabel(t, id);
                    const movable = resolved.get(id) ?? [];
                    const moved = id in device || id in account;
                    const listening = recording === id;
                    const wrong = problem?.id === id ? problem.message : "";
                    const clash = conflicts.find((entry) => entry.ids.includes(id));
                    return {
                        id,
                        label,
                        bindings: movable,
                        fixed: definition.fixed,
                        fixedLabel: t("fixedHint"),
                        onRemove: core.isRebindable(definition)
                            ? (binding: string) => ({
                                  label: t("remove", { keys: text(binding), action: label }),
                                  run: () =>
                                      change(
                                          id,
                                          movable.filter((other) => other !== binding)
                                      )
                              })
                            : undefined,
                        note: (
                            <>
                                {id in device ? (
                                    <span className="block text-[12px] text-muted-foreground">
                                        {t("onDevice")}
                                    </span>
                                ) : null}
                                {wrong ? (
                                    <span role="alert" className="block text-[12px] text-danger">
                                        {wrong}
                                    </span>
                                ) : clash ? (
                                    <span className="block text-[12px] text-danger">
                                        {clashMessage(clash, id)}
                                    </span>
                                ) : null}
                            </>
                        ),
                        end: core.isRebindable(definition) ? (
                            <span className="flex items-center gap-0.5">
                                <Button
                                    variant={listening ? "secondary" : "ghost"}
                                    size="sm"
                                    className={listening ? "h-7 px-2 text-xs" : ICON}
                                    aria-label={
                                        listening
                                            ? t("pressFor", { action: label })
                                            : t("add", { action: label })
                                    }
                                    title={listening ? t("pressFor", { action: label }) : t("add", { action: label })}
                                    onClick={() => {
                                        setProblem(null);
                                        setRecording(listening ? null : id);
                                    }}
                                    onKeyDown={listening ? (event) => take(id, event) : undefined}
                                    onBlur={() => {
                                        if (listening) setRecording(null);
                                    }}
                                >
                                    {listening ? t("press") : <Plus className="size-3.5" aria-hidden="true" />}
                                </Button>
                                {moved ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className={ICON}
                                        aria-label={t("reset", { action: label })}
                                        title={t("reset", { action: label })}
                                        onClick={() => reset(id)}
                                    >
                                        <RotateCcw className="size-3.5" aria-hidden="true" />
                                    </Button>
                                ) : null}
                            </span>
                        ) : undefined
                    };
                })
            });
        }
    }

    const anyMoved = Object.keys(account).length > 0 || Object.keys(device).length > 0;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-52">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("search")}
                        aria-label={t("search")}
                        className="pl-8"
                    />
                </div>
                {showAppFilter ? (
                    <Select
                        value={filter}
                        onValueChange={setFilter}
                        className="w-40"
                        options={[
                            { value: "all", label: t("allApps") },
                            ...core.SHORTCUT_APPS.filter((name) =>
                                core.SHORTCUTS.some((definition) => definition.app === name)
                            ).map((name) => ({ value: name, label: appTitle(t, name) }))
                        ]}
                    />
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 text-[13px]">
                    <Switch
                        checked={deviceOnly}
                        onChange={setDeviceOnly}
                        aria-label={t("deviceOnly")}
                    />
                    <span className="min-w-0">
                        <span className="block">{t("deviceOnly")}</span>
                        <span className="block text-[12px] text-muted-foreground">{t("deviceOnlyHint")}</span>
                    </span>
                </label>
                <Button variant="ghost" size="sm" disabled={!anyMoved} onClick={() => void resetAll()}>
                    {t("resetAll")}
                </Button>
            </div>
            {groups.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {t("noMatch", { query: query.trim() })}
                </p>
            ) : (
                <ShortcutSheet groups={groups} or={t("or")} none={t("none")} />
            )}
            {filter === "all" || filter === "chat" ? (
                <p className="text-[12px] text-muted-foreground">
                    <Link href="/account/devices" className="underline-offset-2 hover:underline">
                        {t("voiceLink")}
                    </Link>
                </p>
            ) : null}
            {confirmNode}
        </div>
    );
}
