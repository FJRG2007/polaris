"use client";

/**
 * Who gets told, and about what.
 *
 * An alert arrives as a message in a conversation rather than as a badge on the
 * bell, and the list says so plainly, because it changes what people expect: it
 * appears the way a message appears, it can be muted the way a conversation is
 * muted, and it leaves a thread rather than a counter. A rule can ask for the
 * bell as well, and that is a per-rule choice rather than the default, because
 * everything a camera sees is already written down in Events.
 *
 * Deliberately few knobs. What was seen, optionally who, optionally which
 * camera, optionally between which hours - anything more expressive is a rules
 * engine, and a rules engine is a thing people configure once and then cannot
 * read six months later.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { AlertDialog } from "./alert-dialog";
import type { CameraView } from "@/lib/home/cameras";
import type { AlertRuleView } from "@/lib/home/alerts";
import { focusAfterMove } from "@/lib/list-selection";
import { Bell, Pencil, Plus, Trash2 } from "lucide-react";
import {
    cn,
    Badge,
    Button,
    Switch,
    Skeleton,
    EmptyState,
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog
} from "@polaris/ui";

const KIND_LABEL: Record<string, string> = {
    motion: "movement",
    person: "somebody",
    face: "a known face",
    vehicle: "a vehicle",
    animal: "an animal",
    package: "a box or bag is left",
    tamper: "tampering"
};

export function AlertsView({ canManage }: { canManage: boolean }) {
    const [rules, setRules] = useState<AlertRuleView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
    const [known, setKnown] = useState<{ id: string; name: string }[]>([]);
    /** The watched areas drawn anywhere in this place, so a rule can name one. */
    const [areas, setAreas] = useState<string[]>([]);
    const [editing, setEditing] = useState<AlertRuleView | null>(null);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<AlertRuleView | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The rule the keyboard is on. A rule is changed one at a time, so there is
    // nothing here a multi-selection would be for.
    const [focused, setFocused] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [list, cams, recipients, faces, drawn] = await Promise.all([
                actions.listAlertsAction(),
                actions.listCamerasAction(),
                canManage ? actions.listRecipientsAction() : Promise.resolve({ people: [] }),
                actions.listPeopleAction(),
                actions.listPlaceZoneNamesAction()
            ]);
            if (cancelled) return;
            if (list.error) setError(list.error);
            setRules(list.rules ?? []);
            setCameras(cams.cameras ?? []);
            setPeople(recipients.people ?? []);
            setKnown((faces.people ?? []).map((person) => ({ id: person.id, name: person.name })));
            setAreas(drawn.zones ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [canManage]);

    const saved = (rule: AlertRuleView) => {
        setRules((current) => [...(current ?? []).filter((item) => item.id !== rule.id), rule]);
        setEditing(null);
        setAdding(false);
    };

    const remove = async (rule: AlertRuleView) => {
        const result = await runAction(() => actions.deleteAlertAction(rule.id), setError);
        setRemoving(null);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setRules((current) => (current ?? []).filter((item) => item.id !== rule.id));
    };

    const toggle = async (rule: AlertRuleView, enabled: boolean) => {
        setRules((current) =>
            (current ?? []).map((item) => (item.id === rule.id ? { ...item, enabled } : item))
        );
        const result = await runAction(
            () => actions.saveAlertAction(rule.id, { ...rule, enabled }),
            setError
        );
        if (result?.error) {
            setError(result.error);
            setRules((current) =>
                (current ?? []).map((item) =>
                    item.id === rule.id ? { ...item, enabled: !enabled } : item
                )
            );
        }
    };

    /**
     * F2 and Enter open the rule (its name is the first field in that dialog),
     * Delete removes it, the arrows walk the list. The same keys as the clips
     * list, the camera table and Drive.
     */
    const onKeyDown = (event: React.KeyboardEvent) => {
        const list = rules ?? [];
        const index = list.findIndex((rule) => rule.id === focused);
        const current = list[index];
        if ((event.key === "F2" || event.key === "Enter") && current && canManage) {
            event.preventDefault();
            setEditing(current);
        } else if (event.key === "Delete" && current && canManage) {
            event.preventDefault();
            setRemoving(current);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const landed = focusAfterMove(
                list.map((item) => item.id),
                focused,
                event.key === "ArrowDown" ? 1 : -1
            );
            if (landed) setFocused(landed);
        }
    };

    if (rules === null) return <Skeleton className="h-40 w-full" />;

    /** What a rule does, in one line somebody can check at a glance. */
    const describe = (rule: AlertRuleView): string => {
        const what = rule.kinds.map((kind) => KIND_LABEL[kind] ?? kind).join(" or ");
        const who = rule.label ? ` (${rule.label})` : "";
        const where = rule.cameraId
            ? (cameras.find((camera) => camera.id === rule.cameraId)?.name ?? "one camera")
            : "any camera here";
        const inside = rule.zones.length > 0 ? `, in ${rule.zones.join(" or ")}` : "";
        const when = rule.hours ? `, between ${rule.hours.from}:00 and ${rule.hours.to}:00` : "";
        return `When ${what}${who} is seen on ${where}${inside}${when}`;
    };

    return (
        <div className="flex flex-col gap-4">
            {canManage ? (
                <Button size="sm" className="self-start" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" />
                    Add an alert
                </Button>
            ) : null}

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {rules.length === 0 ? (
                <EmptyState
                    icon={<Bell />}
                    title="No alerts yet"
                    description="Everything the cameras see is kept in Events. An alert is for the few things worth being told about: it arrives as a message in a conversation with the people you choose."
                />
            ) : (
                <ul
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    aria-label="Alerts"
                    className="flex flex-col divide-y divide-border rounded-lg border border-border"
                >
                    {rules.map((rule) => (
                        <ContextMenu key={rule.id}>
                            <ContextMenuTrigger asChild>
                                <li
                                    onClick={() => setFocused(rule.id)}
                                    onContextMenu={() => setFocused(rule.id)}
                                    onDoubleClick={() => canManage && setEditing(rule)}
                                    className={cn(
                                        "flex items-start justify-between gap-3 px-3 py-2",
                                        focused === rule.id && "bg-primary/10"
                                    )}
                                >
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className="truncate text-[13px] text-foreground"
                                                title={rule.name}
                                            >
                                                {rule.name}
                                            </span>
                                            {rule.channelId ? null : (
                                                <Badge variant="neutral">Never fired</Badge>
                                            )}
                                        </div>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {describe(rule)}
                                        </p>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            Tells{" "}
                                            {rule.recipients
                                                .map(
                                                    (id) =>
                                                        people.find((person) => person.id === id)
                                                            ?.name ?? "somebody"
                                                )
                                                .join(", ")}
                                            {rule.notify
                                                ? ", in a message and on the bell"
                                                : ", in a message"}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {canManage ? (
                                            <>
                                                <Switch
                                                    checked={rule.enabled}
                                                    aria-label={`Turn ${rule.name} ${rule.enabled ? "off" : "on"}`}
                                                    onChange={(value) => void toggle(rule, value)}
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Change ${rule.name}`}
                                                    title="Change"
                                                    onClick={() => setEditing(rule)}
                                                >
                                                    <Pencil className="size-4 shrink-0" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Remove ${rule.name}`}
                                                    title="Remove"
                                                    onClick={() => setRemoving(rule)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </Button>
                                            </>
                                        ) : null}
                                    </div>
                                </li>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                                <ContextMenuLabel>{rule.name}</ContextMenuLabel>
                                {canManage ? (
                                    <>
                                        <ContextMenuItem onSelect={() => setEditing(rule)}>
                                            <Pencil className="size-4 shrink-0" />
                                            Rename and change
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() => void toggle(rule, !rule.enabled)}
                                        >
                                            <Bell className="size-4 shrink-0" />
                                            {rule.enabled ? "Turn off" : "Turn on"}
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            variant="danger"
                                            onSelect={() => setRemoving(rule)}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                            Remove
                                        </ContextMenuItem>
                                    </>
                                ) : (
                                    <ContextMenuItem disabled>
                                        Nothing to change here
                                    </ContextMenuItem>
                                )}
                            </ContextMenuContent>
                        </ContextMenu>
                    ))}
                </ul>
            )}

            {editing || adding ? (
                <AlertDialog
                    rule={editing}
                    cameras={cameras}
                    people={people}
                    known={known}
                    areas={areas}
                    onClose={() => {
                        setEditing(null);
                        setAdding(false);
                    }}
                    onSaved={saved}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="alert"
                    requireTyping={false}
                    description="Nobody is told about this again. The conversation it wrote into stays - what it holds actually happened."
                    confirmLabel="Remove"
                    onConfirm={() => void remove(removing)}
                />
            ) : null}
        </div>
    );
}
