"use client";

/**
 * Camera sets: groups of a place's cameras picked by hand, so privacy can be
 * switched on all of them at once from the wall, a deck key or an automation.
 *
 * One dialog with two states: the list of sets, and the form for one of them.
 * The form is checked against the same schema the action uses, as it is typed.
 */

import { useState } from "react";
import * as actions from "../actions";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { CameraView } from "../../lib/cameras";
import {
    cameraSetInputSchema,
    normalizeCameraSetInput,
    type CameraSetView
} from "../../lib/privacy-kinds";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import { placesRefusalText } from "../../lib/refusal-text";

const { runAction } = hostUi.runAction;

interface Draft {
    readonly id: string | null;
    readonly name: string;
    readonly cameraIds: readonly string[];
}

export function CameraSetsDialog({
    open,
    placeId,
    cameras,
    sets,
    onClose,
    onChange
}: {
    open: boolean;
    placeId: string;
    cameras: readonly CameraView[];
    sets: readonly CameraSetView[];
    onClose: () => void;
    onChange: (sets: CameraSetView[]) => void;
}) {
    const t = usePlacesT();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [opened, setOpened] = useState<Draft | null>(null);
    const [removing, setRemoving] = useState<CameraSetView | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const edit = (next: Draft) => {
        setDraft(next);
        setOpened(next);
        setError(null);
    };

    const input = draft
        ? normalizeCameraSetInput({ placeId, name: draft.name, cameraIds: [...draft.cameraIds] })
        : null;
    const checked = input ? cameraSetInputSchema.safeParse(input) : null;
    // A blank name or no camera yet is unfinished, not wrong: the button waits.
    const nameIssue =
        draft && draft.name.trim()
            ? cameraSetInputSchema.shape.name.safeParse(input?.name).error?.issues[0]?.message
            : undefined;
    const changed =
        draft !== null &&
        (draft.id === null ||
            (opened !== null &&
                isDirty(
                    { name: opened.name.trim(), cameraIds: [...opened.cameraIds].sort() },
                    { name: draft.name.trim(), cameraIds: [...draft.cameraIds].sort() }
                )));
    const canSave = Boolean(checked?.success) && changed && !busy;

    const save = async () => {
        if (!draft || !canSave) return;
        setBusy(true);
        setError(null);
        const result = await runAction(
            () => actions.saveCameraSetAction(draft.id, input),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error || !result.set) {
            setError(result.error ?? t("cameraSets.notSaved"));
            return;
        }
        const saved = result.set;
        const rest = sets.filter((each) => each.id !== saved.id);
        onChange([...rest, saved].sort((left, right) => left.name.localeCompare(right.name)));
        setDraft(null);
    };

    // Gone from the list at once, and back if the server refused.
    const remove = async () => {
        if (!removing) return;
        const gone = removing;
        const before = [...sets];
        setRemoving(null);
        onChange(sets.filter((each) => each.id !== gone.id));
        const result = await runAction(() => actions.deleteCameraSetAction(gone.id), setError);
        if (!result || result.error) {
            onChange(before);
            if (result?.error) setError(result.error);
        }
    };

    const toggle = (id: string, on: boolean) =>
        setDraft((current) =>
            current
                ? {
                      ...current,
                      cameraIds: on
                          ? [...current.cameraIds, id]
                          : current.cameraIds.filter((each) => each !== id)
                  }
                : current
        );

    return (
        <>
            <Dialog
                open={open && removing === null}
                onOpenChange={(next) => (next ? undefined : onClose())}
            >
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t("cameraSets.title")}</DialogTitle>
                        <DialogDescription>{t("cameraSets.intro")}</DialogDescription>
                    </DialogHeader>

                    {draft === null ? (
                        <div className="flex flex-col gap-2">
                            {sets.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {t("cameraSets.empty")}
                                </p>
                            ) : (
                                <ul className="flex flex-col divide-y divide-border">
                                    {sets.map((set) => {
                                        const count = set.cameraIds.filter((id) =>
                                            cameras.some((camera) => camera.id === id)
                                        ).length;
                                        return (
                                            <li
                                                key={set.id}
                                                className="flex min-w-0 items-center gap-2 py-2"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <p
                                                        className="truncate text-sm"
                                                        title={set.name}
                                                    >
                                                        {set.name}
                                                    </p>
                                                    <p className="text-xs text-foreground-subtle">
                                                        {t("cameraSets.count", { count })}
                                                    </p>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("cameraSets.edit", {
                                                        name: set.name
                                                    })}
                                                    title={t("cameraSets.edit", { name: set.name })}
                                                    onClick={() =>
                                                        edit({
                                                            id: set.id,
                                                            name: set.name,
                                                            cameraIds: set.cameraIds
                                                        })
                                                    }
                                                >
                                                    <Pencil className="size-4 shrink-0" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("cameraSets.remove", {
                                                        name: set.name
                                                    })}
                                                    title={t("cameraSets.remove", {
                                                        name: set.name
                                                    })}
                                                    onClick={() => setRemoving(set)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </Button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            {error ? (
                                <p role="alert" className="text-xs text-danger">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-xs text-muted-foreground">
                                    {t("cameraSets.name")} <span className="text-danger">*</span>
                                </span>
                                <Input
                                    value={draft.name}
                                    maxLength={60}
                                    aria-label={t("cameraSets.name")}
                                    placeholder={t("cameraSets.namePlaceholder")}
                                    onChange={(event) =>
                                        setDraft({ ...draft, name: event.target.value })
                                    }
                                />
                                {nameIssue ? (
                                    <span className="text-xs text-danger">
                                        {placesRefusalText(t, nameIssue)}
                                    </span>
                                ) : null}
                            </label>
                            <fieldset className="flex min-w-0 flex-col gap-1.5">
                                <legend className="mb-1.5 text-xs text-muted-foreground">
                                    {t("cameraSets.cameras")} <span className="text-danger">*</span>
                                </legend>
                                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                                    {cameras.map((camera) => (
                                        <label
                                            key={camera.id}
                                            className="flex min-w-0 items-center gap-2 py-1 text-sm"
                                        >
                                            <Checkbox
                                                checked={draft.cameraIds.includes(camera.id)}
                                                onChange={(event) =>
                                                    toggle(camera.id, event.target.checked)
                                                }
                                            />
                                            <span className="truncate" title={camera.name}>
                                                {camera.name}
                                            </span>
                                            {camera.zone ? (
                                                <span className="shrink-0 text-xs text-foreground-subtle">
                                                    {camera.zone}
                                                </span>
                                            ) : null}
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                            {error ? (
                                <p role="alert" className="text-xs text-danger">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    )}

                    <DialogFooter>
                        {draft === null ? (
                            <>
                                <Button variant="ghost" onClick={onClose}>
                                    {t("cameraSets.close")}
                                </Button>
                                <Button
                                    disabled={cameras.length === 0}
                                    title={
                                        cameras.length === 0 ? t("cameraSets.noCameras") : undefined
                                    }
                                    onClick={() => edit({ id: null, name: "", cameraIds: [] })}
                                >
                                    <Plus className="size-4 shrink-0" />
                                    {t("cameraSets.add")}
                                </Button>
                            </>
                        ) : (
                            <>
                                <Button variant="ghost" onClick={() => setDraft(null)}>
                                    {t("cameraSets.back")}
                                </Button>
                                <Button
                                    aria-disabled={!canSave}
                                    disabled={!canSave}
                                    onClick={() => void save()}
                                >
                                    {t("cameraSets.save")}
                                </Button>
                            </>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => (next ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="set"
                requireTyping={false}
                title={t("cameraSets.removeTitle")}
                question={t("cameraSets.removeQuestion", { name: removing?.name ?? "" })}
                description={t("cameraSets.removeBody")}
                confirmLabel={t("cameraSets.removeConfirm")}
                onConfirm={() => void remove()}
            />
        </>
    );
}
