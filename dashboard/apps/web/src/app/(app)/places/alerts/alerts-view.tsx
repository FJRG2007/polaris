"use client";

/**
 * Who gets told, and about what.
 *
 * An alert arrives as a message in a conversation rather than as a badge on the
 * bell, and the list says so plainly, because it changes what people expect: it
 * appears the way a message appears, it can be muted the way a conversation is
 * muted, and it leaves a thread rather than a counter.
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
import { Bell, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDeleteDialog, EmptyState, Skeleton, Switch } from "@polaris/ui";

const KIND_LABEL: Record<string, string> = {
    motion: "movement",
    person: "somebody",
    face: "a known face",
    vehicle: "a vehicle",
    animal: "an animal",
    tamper: "tampering"
};

export function AlertsView({ canManage }: { canManage: boolean }) {
    const [rules, setRules] = useState<AlertRuleView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
    const [known, setKnown] = useState<{ id: string; name: string }[]>([]);
    const [editing, setEditing] = useState<AlertRuleView | null>(null);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<AlertRuleView | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [list, cams, recipients, faces] = await Promise.all([
                actions.listAlertsAction(),
                actions.listCamerasAction(),
                canManage ? actions.listRecipientsAction() : Promise.resolve({ people: [] }),
                actions.listPeopleAction()
            ]);
            if (cancelled) return;
            if (list.error) setError(list.error);
            setRules(list.rules ?? []);
            setCameras(cams.cameras ?? []);
            setPeople(recipients.people ?? []);
            setKnown((faces.people ?? []).map((person) => ({ id: person.id, name: person.name })));
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
        setRules((current) => (current ?? []).map((item) => (item.id === rule.id ? { ...item, enabled } : item)));
        const result = await runAction(() => actions.saveAlertAction(rule.id, { ...rule, enabled }), setError);
        if (result?.error) {
            setError(result.error);
            setRules((current) =>
                (current ?? []).map((item) => (item.id === rule.id ? { ...item, enabled: !enabled } : item))
            );
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
        const when = rule.hours ? `, between ${rule.hours.from}:00 and ${rule.hours.to}:00` : "";
        return `When ${what}${who} is seen on ${where}${when}`;
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
                    description="An alert arrives as a message in a conversation with the people you choose, so it appears wherever they are rather than waiting on a badge."
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {rules.map((rule) => (
                        <li key={rule.id} className="flex items-start justify-between gap-3 px-3 py-2">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-[13px] text-foreground" title={rule.name}>{rule.name}</span>
                                    {rule.channelId ? null : <Badge variant="neutral">Never fired</Badge>}
                                </div>
                                <p className="truncate text-[11px] text-foreground-subtle">{describe(rule)}</p>
                                <p className="truncate text-[11px] text-foreground-subtle">
                                    Tells{" "}
                                    {rule.recipients
                                        .map((id) => people.find((person) => person.id === id)?.name ?? "somebody")
                                        .join(", ")}
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
                    ))}
                </ul>
            )}

            {editing || adding ? (
                <AlertDialog
                    rule={editing}
                    cameras={cameras}
                    people={people}
                    known={known}
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
