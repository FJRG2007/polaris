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
import { AlertDialog } from "./alert-dialog";
import type { CameraView } from "../../lib/cameras";
import type { AlertRuleView } from "../../lib/alerts";
import { focusAfterMove } from "../../lib/list-selection";
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
import { hostUi } from "@polaris/app-host/client";
import { usePlacesT } from "../use-places-t";
import type { PlacesKey } from "../../../messages";

const { runAction } = hostUi.runAction;

/** The kinds a rule can name, each read as `alerts.said.<kind>` in a sentence. */
const SAID = new Set(["motion", "person", "face", "vehicle", "animal", "package", "tamper", "offline"]);

export function AlertsView({ canManage }: { canManage: boolean }) {
    const t = usePlacesT();
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

    /** Whether the faces and the drawn areas - read only by the dialog - have
     *  arrived. */
    const [extras, setExtras] = useState(false);

    // Two reads side by side: what a row is written from (the rules, the camera
    // names, who is told), and what only the dialog offers. The list used to
    // wait for the dialog's half too.
    useEffect(() => {
        let cancelled = false;
        void Promise.all([
            actions.listAlertsAction(),
            actions.listCamerasAction(),
            canManage ? actions.listRecipientsAction() : Promise.resolve({ people: [] })
        ]).then(
            ([list, cams, recipients]) => {
                if (cancelled) return;
                if (list.error) setError(list.error);
                setCameras(cams.cameras ?? []);
                setPeople(recipients.people ?? []);
                setRules(list.rules ?? []);
            },
            () => {
                if (!cancelled)
                    setError(t("alerts.readFailed"));
            }
        );
        void Promise.all([actions.listPeopleAction(), actions.listPlaceZoneNamesAction()]).then(
            ([faces, drawn]) => {
                if (cancelled) return;
                setKnown(
                    (faces.people ?? []).map((person) => ({ id: person.id, name: person.name }))
                );
                setAreas(drawn.zones ?? []);
                setExtras(true);
            },
            () => {
                if (cancelled) return;
                setError(
                    t("alerts.extrasFailed")
                );
            }
        );
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

    /** What a rule does, in one line somebody can check at a glance. */
    const describe = (rule: AlertRuleView): string => {
        const or = t("alerts.or");
        const what = rule.kinds
            .map((kind) => (SAID.has(kind) ? t(`alerts.said.${kind}` as PlacesKey) : kind))
            .join(or);
        const where = rule.cameraId
            ? (cameras.find((camera) => camera.id === rule.cameraId)?.name ?? t("alerts.oneCamera"))
            : t("alerts.anyCameraHere");
        return t("alerts.describe", {
            what,
            who: rule.label ?? "",
            hasWho: rule.label ? "yes" : "no",
            where,
            inside: rule.zones.join(or),
            hasInside: rule.zones.length > 0 ? "yes" : "no",
            hasHours: rule.hours ? "yes" : "no",
            from: rule.hours ? `${rule.hours.from}:00` : "",
            to: rule.hours ? `${rule.hours.to}:00` : ""
        });
    };

    return (
        <div className="flex flex-col gap-4">
            {canManage ? (
                <Button size="sm" className="self-start" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" />
                    {t("alerts.addTitle")}
                </Button>
            ) : null}

            {error ? <p className="text-[0.75rem] text-danger">{error}</p> : null}

            {rules === null ? (
                <Skeleton className="h-40 w-full" />
            ) : rules.length === 0 ? (
                <EmptyState
                    icon={<Bell />}
                    title={t("alerts.emptyTitle")}
                    description={t("alerts.emptyBody")}
                />
            ) : (
                <ul
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    aria-label={t("pages.alerts.title")}
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
                                                className="truncate text-[0.8125rem] text-foreground"
                                                title={rule.name}
                                            >
                                                {rule.name}
                                            </span>
                                            {rule.channelId ? null : (
                                                <Badge variant="neutral">{t("alerts.neverFired")}</Badge>
                                            )}
                                        </div>
                                        <p className="truncate text-[0.6875rem] text-foreground-subtle">
                                            {describe(rule)}
                                        </p>
                                        <p className="truncate text-[0.6875rem] text-foreground-subtle">
                                            {t("alerts.tells", {
                                                names: rule.recipients
                                                    .map(
                                                        (id) =>
                                                            people.find((person) => person.id === id)
                                                                ?.name ?? t("alerts.somebody")
                                                    )
                                                    .join(", "),
                                                bell: rule.notify ? "yes" : "no"
                                            })}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {canManage ? (
                                            <>
                                                <Switch
                                                    checked={rule.enabled}
                                                    aria-label={t(rule.enabled ? "alerts.turnOffName" : "alerts.turnOnName", { name: rule.name })}
                                                    onChange={(value) => void toggle(rule, value)}
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("cameras.changeName", { name: rule.name })}
                                                    title={t("cameras.change")}
                                                    onClick={() => setEditing(rule)}
                                                >
                                                    <Pencil className="size-4 shrink-0" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("cameras.removeName", { name: rule.name })}
                                                    title={t("cameras.remove")}
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
                                            {t("cameras.renameAndChange")}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() => void toggle(rule, !rule.enabled)}
                                        >
                                            <Bell className="size-4 shrink-0" />
                                            {rule.enabled ? t("alerts.turnOff") : t("alerts.turnOn")}
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            variant="danger"
                                            onSelect={() => setRemoving(rule)}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                            {t("cameras.remove")}
                                        </ContextMenuItem>
                                    </>
                                ) : (
                                    <ContextMenuItem disabled>
                                        {t("cameras.nothingToChange")}
                                    </ContextMenuItem>
                                )}
                            </ContextMenuContent>
                        </ContextMenu>
                    ))}
                </ul>
            )}

            {/* Opened before the dialog's own lists arrive, it appears when they
                do rather than offering no faces and no areas to choose from. */}
            {rules !== null && extras && (editing || adding) ? (
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
                    title={t("alerts.removeTitle")}
                    question={t.rich("alerts.removeQuestion", {
                        name: removing.name,
                        em: (chunks) => <span className="font-medium text-foreground">{chunks}</span>
                    })}
                    requireTyping={false}
                    description={t("alerts.removeBody")}
                    confirmLabel={t("cameras.remove")}
                    onConfirm={() => void remove(removing)}
                />
            ) : null}
        </div>
    );
}
