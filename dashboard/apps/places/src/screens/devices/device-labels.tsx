"use client";

/**
 * The labels a device carries, in its dialog: the ones it has as chips, the
 * place's others to add, a new one made in place, and the place's labels renamed
 * or removed. A label names part of a room or the same thing across several, so
 * an automation can name "Ceiling" the way it names a room.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import { labelInputSchema } from "../../lib/schemas";
import type { LabelView } from "../../lib/room-kinds";
import { Badge, Button, Input, Select } from "@polaris/ui";
import { placesRefusalText } from "../../lib/refusal-text";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

const { runAction } = hostUi.runAction;

/** The most labels one device carries, as the server holds it. */
const PER_DEVICE = 20;

/** A place's labels, read again when another place is picked. Null while they
 *  are read; the error when they could not be. */
export function usePlaceLabels(placeId: string) {
    const [labels, setLabels] = useState<LabelView[] | null>(null);
    const [failed, setFailed] = useState("");
    useEffect(() => {
        setFailed("");
        if (!placeId) {
            setLabels([]);
            return;
        }
        let current = true;
        setLabels(null);
        void actions.listLabelsAction(placeId).then(
            (result) => {
                if (!current) return;
                if (result.error) setFailed(result.error);
                setLabels(result.labels ?? []);
            },
            () => {
                if (!current) return;
                setFailed("failed");
                setLabels([]);
            }
        );
        return () => {
            current = false;
        };
    }, [placeId]);
    return { labels, setLabels, failed };
}

export function DeviceLabelsField({
    placeId,
    labels,
    setLabels,
    failed,
    value,
    onChange,
    disabled
}: {
    placeId: string;
    labels: LabelView[] | null;
    setLabels: (update: (list: LabelView[] | null) => LabelView[] | null) => void;
    failed: string;
    /** The labels the device carries. */
    value: readonly string[];
    onChange: (ids: string[]) => void;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const [making, setMaking] = useState("");
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const typed = making.trim();
    const issueRaw = typed
        ? (labelInputSchema.shape.name.safeParse(typed).error?.issues[0]?.message ?? null)
        : null;
    const issue = issueRaw ? placesRefusalText(t, issueRaw) : null;
    const list = labels ?? [];
    const carried = value
        .map((id) => list.find((label) => label.id === id))
        .filter((label): label is LabelView => label !== undefined);
    const free = list.filter((label) => !value.includes(label.id));
    const full = value.length >= PER_DEVICE;

    const create = async () => {
        if (!typed || issue || busy) return;
        setBusy(true);
        setError("");
        const made = await runAction(
            () => actions.saveLabelAction(null, { placeId, name: typed }),
            setError
        );
        setBusy(false);
        if (!made) return;
        if (made.error || !made.label) {
            setError(made.error ?? "");
            return;
        }
        const label = made.label;
        setLabels((current) =>
            [...(current ?? []), label].sort((a, b) => a.name.localeCompare(b.name))
        );
        if (!full) onChange([...value, label.id]);
        setMaking("");
    };

    if (labels === null) {
        return (
            <p className="text-xs text-muted-foreground" aria-live="polite">
                {t("deviceDialog.loadingLabels")}
            </p>
        );
    }

    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                {t("deviceDialog.labels")}{" "}
                <span className="text-foreground-subtle">{t("deviceDialog.optional")}</span>
            </span>
            {failed && (
                <p role="alert" className="text-xs text-danger">
                    {t("deviceDialog.labelsFailed")}
                </p>
            )}
            {carried.length > 0 && (
                <div className="flex min-w-0 flex-wrap gap-1">
                    {carried.map((label) => (
                        <Badge key={label.id} className="min-w-0 max-w-full shrink py-0 pr-0">
                            <span className="min-w-0 truncate" title={label.name}>
                                {label.name}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-5 shrink-0 p-0"
                                aria-label={t("deviceDialog.removeLabel", { label: label.name })}
                                title={t("deviceDialog.removeLabel", { label: label.name })}
                                disabled={disabled}
                                onClick={() => onChange(value.filter((id) => id !== label.id))}
                            >
                                <X className="size-3.5" />
                            </Button>
                        </Badge>
                    ))}
                </div>
            )}
            {free.length > 0 && (
                <Select
                    value=""
                    disabled={disabled || full}
                    aria-label={t("deviceDialog.addLabel")}
                    placeholder={t("deviceDialog.addLabel")}
                    options={free.map((label) => ({ value: label.id, label: label.name }))}
                    onValueChange={(next) => next && onChange([...value, next])}
                />
            )}
            <div className="flex min-w-0 items-center gap-1">
                <Input
                    value={making}
                    maxLength={40}
                    disabled={disabled || busy}
                    aria-label={t("deviceDialog.newLabel")}
                    placeholder={t("deviceDialog.newLabelPlaceholder")}
                    className="min-w-0 flex-1"
                    onChange={(event) => setMaking(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            void create();
                        }
                    }}
                />
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-8 shrink-0 p-0"
                    aria-label={t("deviceDialog.createLabel")}
                    title={t("deviceDialog.createLabel")}
                    disabled={disabled || busy || !typed || issue !== null}
                    onClick={() => void create()}
                >
                    <Plus className="size-4" />
                </Button>
            </div>
            {issue && <span className="text-xs text-danger">{issue}</span>}
            {error && (
                <span role="alert" className="text-xs text-danger">
                    {error}
                </span>
            )}
            <span className="text-xs text-foreground-subtle">{t("deviceDialog.labelsHint")}</span>
            {list.length > 0 && (
                <div className="flex flex-col gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="self-start"
                        aria-expanded={editing}
                        disabled={disabled}
                        onClick={() => setEditing((open) => !open)}
                    >
                        <Pencil className="size-4" />
                        {editing ? t("deviceDialog.doneEditingLabels") : t("deviceDialog.editLabels")}
                    </Button>
                    {editing &&
                        list.map((label) => (
                            <LabelRow
                                key={label.id}
                                label={label}
                                disabled={disabled}
                                onRenamed={(renamed) =>
                                    setLabels((current) =>
                                        (current ?? []).map((each) =>
                                            each.id === renamed.id ? renamed : each
                                        )
                                    )
                                }
                                onDeleted={() => {
                                    setLabels((current) =>
                                        (current ?? []).filter((each) => each.id !== label.id)
                                    );
                                    if (value.includes(label.id))
                                        onChange(value.filter((id) => id !== label.id));
                                }}
                            />
                        ))}
                </div>
            )}
        </div>
    );
}

/** One of the place's labels, renamed in place or removed after a second press. */
function LabelRow({
    label,
    disabled,
    onRenamed,
    onDeleted
}: {
    label: LabelView;
    disabled?: boolean;
    onRenamed: (label: LabelView) => void;
    onDeleted: () => void;
}) {
    const t = usePlacesT();
    const [name, setName] = useState(label.name);
    const [sure, setSure] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const typed = name.trim();
    const issueRaw = typed
        ? (labelInputSchema.shape.name.safeParse(typed).error?.issues[0]?.message ?? null)
        : null;
    const issue = issueRaw ? placesRefusalText(t, issueRaw) : null;
    const changed = typed !== label.name;

    const rename = async () => {
        if (!typed || !changed || issue || busy) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => actions.saveLabelAction(label.id, { name: typed }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error || !result.label) {
            setError(result.error ?? "");
            return;
        }
        onRenamed(result.label);
    };
    const remove = async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        const result = await runAction(() => actions.deleteLabelAction(label.id), setError);
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            setSure(false);
            return;
        }
        onDeleted();
    };

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1">
                <Input
                    value={name}
                    maxLength={40}
                    disabled={disabled || busy}
                    aria-label={t("deviceDialog.renameLabel", { label: label.name })}
                    className="min-w-0 flex-1"
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            void rename();
                        }
                    }}
                />
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-8 shrink-0 p-0"
                    aria-label={t("deviceDialog.saveLabelName", { label: label.name })}
                    title={t("deviceDialog.saveLabelName", { label: label.name })}
                    disabled={disabled || busy || !typed || !changed || issue !== null}
                    onClick={() => void rename()}
                >
                    <Check className="size-4" />
                </Button>
                <Button
                    size="sm"
                    variant={sure ? "danger" : "ghost"}
                    className={sure ? "shrink-0" : "size-8 shrink-0 p-0"}
                    aria-label={t("deviceDialog.deleteLabel", { label: label.name })}
                    title={t("deviceDialog.deleteLabel", { label: label.name })}
                    disabled={disabled || busy}
                    onClick={() => (sure ? void remove() : setSure(true))}
                    onBlur={() => setSure(false)}
                >
                    <Trash2 className="size-4" />
                    {sure && t("deviceDialog.confirmDeleteLabel")}
                </Button>
            </div>
            {issue && <span className="text-xs text-danger">{issue}</span>}
            {error && (
                <span role="alert" className="text-xs text-danger">
                    {error}
                </span>
            )}
        </div>
    );
}
