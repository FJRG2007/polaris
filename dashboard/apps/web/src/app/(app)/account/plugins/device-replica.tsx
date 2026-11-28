"use client";

/**
 * A device's knobs and buttons drawn where they sit on the device, with the
 * actions beside it, the way Stream Deck and controller vendors edit a
 * controller: drag an action onto a knob's turn or press or onto a button,
 * drag one control onto another to swap them, or select a control and assign
 * from its picker or the list - drag is never the only way. The layout comes
 * from the manifest's groups (`dials`, `buttons`), so any plugin that declares
 * them gets it. Saving is the settings section's own: this only says what
 * changed.
 */

import { useDeviceActionOptions } from "./plugin-actions";
import { cn, Input, Select, settingType } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
    PLUGIN_ACTIONS,
    pluginGroupAnchor,
    pluginSettingAnchor,
    pluginText,
    type PluginManifest,
    type PluginSetting,
    type PluginSettingGroup,
    type PluginSettingValue
} from "@polaris/core/device-plugins";

type Words = ReturnType<typeof useTranslations<"account">>;
type Values = Record<string, PluginSettingValue>;
type Option = { value: string; label: string };

/** The picker's list: `call.leave` reads as hang up, so it is offered once, as `call.hangup`. */
export const PICKABLE_ACTIONS = PLUGIN_ACTIONS.filter((action) => action !== "call.leave");

const NONE = "none";

function say(t: Words, key: string, values?: Record<string, string | number>): string {
    return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(`plugins.${key}`, values);
}

/** What an `action` setting's value is shown as in its picker: `call.leave` as hang up, nothing as "none". */
export function actionPickValue(value: PluginSettingValue): string {
    return typeof value === "string" ? (value === "call.leave" ? "call.hangup" : value) : NONE;
}

/** The value an `action` setting keeps for what its picker shows. */
export function actionStoreValue(picked: string): string | null {
    return picked === NONE ? null : picked;
}

/** Every action an `action` setting may pick, with the one it holds kept even when nothing knows it any more. */
export function actionOptions(t: Words, extra: readonly Option[], value: PluginSettingValue): Option[] {
    const known: Option[] = [
        { value: NONE, label: say(t, "action.none") },
        ...PICKABLE_ACTIONS.map((action) => ({ value: action, label: say(t, `action.${action.slice("call.".length)}`) })),
        ...extra
    ];
    const held = actionPickValue(value);
    // A custom action deleted since, or one this page has not heard of yet: shown, not silently swapped.
    return known.some((option) => option.value === held) ? known : [...known, { value: held, label: say(t, "action.missing") }];
}

type ChoiceSetting = Extract<PluginSetting, { kind: "choice" }>;
type ActionSetting = Extract<PluginSetting, { kind: "action" }>;
/** A control's part that holds a setting: a knob's turn or press, or a button. */
export type ReplicaSlot = ChoiceSetting | ActionSetting;

export interface ReplicaKnob {
    readonly turn: ChoiceSetting | null;
    readonly press: ActionSetting | null;
}

export interface ReplicaLayout {
    readonly dials: PluginSettingGroup | null;
    readonly buttonsGroup: PluginSettingGroup | null;
    readonly knobs: readonly ReplicaKnob[];
    readonly buttons: readonly ActionSetting[];
}

/**
 * The device as the manifest declares it: each `dials` group's choices are
 * the knobs' turns and its actions their presses, paired in order (knob 1
 * turns with the first choice and is pressed with the first action), and a
 * `buttons` group's actions are the buttons. Null when it declares neither,
 * so the page keeps its rows.
 */
export function replicaLayout(manifest: Pick<PluginManifest, "settings" | "groups">): ReplicaLayout | null {
    const dials = manifest.groups.find((group) => group.look === "dials") ?? null;
    const buttonsGroup = manifest.groups.find((group) => group.look === "buttons") ?? null;
    if (!dials && !buttonsGroup) return null;
    const inGroup = (group: PluginSettingGroup | null) => (group ? manifest.settings.filter((setting) => setting.group === group.key) : []);
    const turns = inGroup(dials).filter((setting): setting is ChoiceSetting => setting.kind === "choice");
    const presses = inGroup(dials).filter((setting): setting is ActionSetting => setting.kind === "action");
    const knobs = Array.from({ length: Math.max(turns.length, presses.length) }, (_, index) => ({ turn: turns[index] ?? null, press: presses[index] ?? null }));
    const buttons = inGroup(buttonsGroup).filter((setting): setting is ActionSetting => setting.kind === "action");
    return { dials, buttonsGroup, knobs, buttons };
}

/** What is being dragged: an action from the list, or what a control holds. */
export type ReplicaDrag = { readonly from: "library"; readonly kind: "choice" | "action"; readonly value: string } | { readonly from: "slot"; readonly key: string };

function fits(slot: ReplicaSlot, kind: "choice" | "action", value: string): boolean {
    if (slot.kind !== kind) return false;
    return slot.kind === "action" || slot.options.some((option) => option.value === value);
}

/**
 * The settings a drop changes, or null when it cannot land there: an action
 * from the list replaces what the control held; a control dropped on another
 * of its kind swaps the two.
 */
export function replicaDrop(drag: ReplicaDrag, target: ReplicaSlot, slots: ReadonlyMap<string, ReplicaSlot>, values: Values): Values | null {
    if (drag.from === "library") {
        if (!fits(target, drag.kind, drag.value)) return null;
        return { [target.key]: target.kind === "action" ? actionStoreValue(drag.value) : drag.value };
    }
    const source = slots.get(drag.key);
    if (!source || source.key === target.key || source.kind !== target.kind) return null;
    const mine = values[source.key] ?? null;
    const theirs = values[target.key] ?? null;
    if (source.kind === "choice" && target.kind === "choice") {
        const a = typeof mine === "string" ? mine : source.default;
        const b = typeof theirs === "string" ? theirs : target.default;
        if (!fits(target, "choice", a) || !fits(source, "choice", b)) return null;
        return { [source.key]: b, [target.key]: a };
    }
    return { [source.key]: theirs, [target.key]: mine };
}

const DRAG_TYPE = "application/x-polaris-device-action";

interface ReplicaProps {
    readonly manifest: PluginManifest;
    readonly layout: ReplicaLayout;
    readonly values: Values;
    readonly locale: string;
    /** Several settings at once, saved together (a swap is two). */
    readonly onChange: (patch: Values) => void;
    /** The setting's own picker, as the settings section draws it. */
    readonly control: (setting: ReplicaSlot) => ReactNode;
}

/** The device with its controls in place, the actions to drag onto them, and the selected control's pickers. */
export function DeviceReplica({ manifest, layout, values, locale, onChange, control }: ReplicaProps) {
    const t = useTranslations("account");
    const extra = useDeviceActionOptions();
    const slots = useMemo(() => {
        const all = new Map<string, ReplicaSlot>();
        for (const knob of layout.knobs) {
            if (knob.turn) all.set(knob.turn.key, knob.turn);
            if (knob.press) all.set(knob.press.key, knob.press);
        }
        for (const button of layout.buttons) all.set(button.key, button);
        return all;
    }, [layout]);
    // A search result that names one control (`#setting-<key>`) opens with it selected, so its pickers are the ones shown.
    const [selected, setSelected] = useState<string | null>(() => {
        const id = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
        return [...slots.keys()].find((key) => pluginSettingAnchor(key) === id) ?? slots.keys().next().value ?? null;
    });
    const [drag, setDrag] = useState<ReplicaDrag | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const [find, setFind] = useState("");

    const current = selected ? (slots.get(selected) ?? null) : null;
    const labelOf = (setting: ReplicaSlot) => pluginText(setting.label, locale);
    const valueLabel = (setting: ReplicaSlot): string => {
        const value = values[setting.key] ?? null;
        if (setting.kind === "choice") {
            const held = typeof value === "string" ? value : setting.default;
            const option = setting.options.find((item) => item.value === held);
            return option ? pluginText(option.label, locale) : held;
        }
        const held = actionPickValue(value);
        return actionOptions(t, extra, value).find((option) => option.value === held)?.label ?? held;
    };

    const turnOptions = layout.knobs.find((knob) => knob.turn)?.turn?.options ?? [];
    const query = find.trim().toLowerCase();
    const matches = (label: string) => !query || label.toLowerCase().includes(query);
    const shelves: { key: string; title: string; kind: "choice" | "action"; items: Option[] }[] = [
        { key: "volume", title: say(t, "replica.volume"), kind: "choice" as const, items: turnOptions.map((option) => ({ value: option.value, label: pluginText(option.label, locale) })) },
        { key: "call", title: say(t, "replica.call"), kind: "action" as const, items: actionOptions(t, [], null).filter((option) => option.value === NONE || (PICKABLE_ACTIONS as readonly string[]).includes(option.value)) },
        { key: "more", title: say(t, "replica.more"), kind: "action" as const, items: extra }
    ]
        .map((shelf) => ({ ...shelf, items: shelf.items.filter((item) => matches(item.label)) }))
        .filter((shelf) => shelf.items.length > 0);

    const land = (target: ReplicaSlot, what: ReplicaDrag | null) => {
        if (!what) return false;
        const patch = replicaDrop(what, target, slots, values);
        if (!patch) return false;
        onChange(patch);
        setSelected(target.key);
        return true;
    };
    const targetProps = (slot: ReplicaSlot) => {
        const can = drag !== null && replicaDrop(drag, slot, slots, values) !== null;
        return {
            can,
            onDragOver: (event: DragEvent) => {
                if (!can) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = drag?.from === "slot" ? "move" : "copy";
                setOver(slot.key);
            },
            onDragLeave: () => setOver((key) => (key === slot.key ? null : key)),
            onDrop: (event: DragEvent) => {
                event.preventDefault();
                land(slot, drag);
                setDrag(null);
                setOver(null);
            }
        };
    };
    const startDrag = (what: ReplicaDrag) => (event: DragEvent) => {
        event.dataTransfer.effectAllowed = what.from === "slot" ? "move" : "copy";
        // Firefox starts a drag only once something is set.
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(what));
        setDrag(what);
    };
    const endDrag = () => {
        setDrag(null);
        setOver(null);
    };

    const slotButton = (slot: ReplicaSlot, shape: "ring" | "cap" | "key", caption: string) => {
        const target = targetProps(slot);
        const value = values[slot.key] ?? null;
        const lit = slot.kind === "action" ? value !== null && value !== NONE : true;
        return (
            <button
                key={slot.key}
                id={pluginSettingAnchor(slot.key)}
                type="button"
                draggable
                aria-pressed={selected === slot.key}
                aria-label={say(t, "replica.holds", { name: labelOf(slot), value: valueLabel(slot) })}
                title={say(t, "replica.holds", { name: labelOf(slot), value: valueLabel(slot) })}
                onClick={() => setSelected(slot.key)}
                onDragStart={startDrag({ from: "slot", key: slot.key })}
                onDragEnd={endDrag}
                onDragOver={target.onDragOver}
                onDragLeave={target.onDragLeave}
                onDrop={target.onDrop}
                className={cn(
                    "flex min-w-0 scroll-mt-24 cursor-grab flex-col items-center justify-center gap-0.5 border-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    shape === "ring" && "aspect-square w-full max-w-24 rounded-full bg-background p-2",
                    shape === "cap" && "w-full max-w-24 rounded-full px-2 py-1",
                    shape === "key" && "aspect-[4/3] w-full max-w-24 rounded-lg p-2",
                    shape !== "ring" && (lit ? "border-primary bg-primary/15" : "border-border bg-background"),
                    shape === "ring" && "border-border",
                    selected === slot.key && "border-foreground",
                    target.can && "border-dashed border-primary",
                    over === slot.key && "bg-primary/25"
                )}
            >
                <span className={cn(settingType.small, "max-w-full truncate text-foreground-subtle")} title={caption}>{caption}</span>
                <span className={cn(settingType.small, "max-w-full truncate font-medium")}>{valueLabel(slot)}</span>
            </button>
        );
    };

    const swapWith = current ? [...slots.values()].filter((other) => replicaDrop({ from: "slot", key: current.key }, other, slots, values) !== null) : [];
    const libraryTarget = current;

    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={manifest.name}>
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div className="flex min-w-0 flex-col gap-4">
                    <div className="mx-auto flex w-full min-w-0 max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-border bg-muted p-4 sm:p-6">
                        <div aria-hidden className="aspect-[480/272] w-3/5 max-w-64 rounded-md border-2 border-border bg-foreground/85" />
                        {layout.knobs.length > 0 && layout.dials ? (
                            <div id={pluginGroupAnchor(layout.dials.key)} role="region" aria-label={pluginText(layout.dials.label, locale)} className="grid w-full min-w-0 scroll-mt-24 grid-cols-4 gap-2 sm:gap-4">
                                {layout.knobs.map((knob, index) => (
                                    <div key={index} className="flex min-w-0 flex-col items-center gap-2">
                                        {knob.turn ? slotButton(knob.turn, "ring", labelOf(knob.turn)) : null}
                                        {knob.press ? slotButton(knob.press, "cap", say(t, "replica.press")) : null}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        {layout.buttons.length > 0 && layout.buttonsGroup ? (
                            <div id={pluginGroupAnchor(layout.buttonsGroup.key)} role="region" aria-label={pluginText(layout.buttonsGroup.label, locale)} className="grid w-full min-w-0 scroll-mt-24 grid-cols-4 gap-2 sm:gap-4">
                                {layout.buttons.map((button) => (
                                    <div key={button.key} className="flex min-w-0 justify-center">
                                        {slotButton(button, "key", labelOf(button))}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    {current ? (
                        <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3" aria-live="polite">
                            <div className="min-w-0">
                                <p className={cn(settingType.title, "truncate font-medium")} title={labelOf(current)}>
                                    {labelOf(current)}
                                </p>
                                {current.hint ? <p className={settingType.hint}>{pluginText(current.hint, locale)}</p> : null}
                            </div>
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                                <div className="min-w-0 flex-1 basis-48">{control(current)}</div>
                                {swapWith.length > 0 ? (
                                    <Select
                                        value=""
                                        placeholder={say(t, "replica.swap")}
                                        aria-label={say(t, "replica.swap")}
                                        className="w-full sm:w-48"
                                        onValueChange={(key) => {
                                            const other = slots.get(key);
                                            if (other) land(other, { from: "slot", key: current.key });
                                        }}
                                        options={swapWith.map((other) => ({ value: other.key, label: labelOf(other) }))}
                                    />
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </div>
                <aside className="flex min-w-0 flex-col gap-2" aria-label={say(t, "replica.library")}>
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-medium">{say(t, "replica.library")}</h3>
                        <p className={settingType.hint}>{say(t, "replica.libraryHint")}</p>
                    </div>
                    <Input value={find} onChange={(event) => setFind(event.target.value)} placeholder={say(t, "replica.find")} aria-label={say(t, "replica.find")} />
                    <div className="flex max-h-96 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                        {shelves.length === 0 ? <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "replica.noMatch")}</p> : null}
                        {shelves.map((shelf) => (
                            <div key={shelf.key} className="flex min-w-0 flex-col gap-1">
                                <p className={cn(settingType.small, "text-foreground-subtle")}>{shelf.title}</p>
                                <ul className="flex min-w-0 flex-col gap-1">
                                    {shelf.items.map((item) => {
                                        const usable = libraryTarget !== null && fits(libraryTarget, shelf.kind, item.value);
                                        return (
                                            <li key={item.value} className="min-w-0">
                                                <button
                                                    type="button"
                                                    draggable
                                                    aria-disabled={!usable}
                                                    title={item.label}
                                                    onClick={() => {
                                                        if (usable && libraryTarget) land(libraryTarget, { from: "library", kind: shelf.kind, value: item.value });
                                                    }}
                                                    onDragStart={startDrag({ from: "library", kind: shelf.kind, value: item.value })}
                                                    onDragEnd={endDrag}
                                                    className={cn(
                                                        settingType.body,
                                                        "w-full min-w-0 cursor-grab truncate rounded-md border border-border bg-background px-2 py-1.5 text-start outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                                                        !usable && "text-muted-foreground"
                                                    )}
                                                >
                                                    {item.label}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ))}
                    </div>
                </aside>
            </div>
        </section>
    );
}
