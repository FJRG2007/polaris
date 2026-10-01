"use client";

/** Adding or changing one room or piece of equipment. */

import { useState } from "react";
import { FieldRow } from "../ui";
import { X } from "lucide-react";
import { useCalendarT } from "../i18n";
import { unwrap } from "../cached-read";
import { CALENDAR_COLORS } from "../../lib/schemas";
import * as roomActions from "../../actions/resources";
import { StatusNote, useIssueText } from "../public/kit";
import type { RoomView } from "../../lib/scheduling-wire";
import { roomInputSchema } from "../../lib/scheduling-schemas";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Textarea,
    cn
} from "@polaris/ui";

interface Draft {
    name: string;
    type: "room" | "equipment";
    capacity: string;
    building: string;
    floor: string;
    features: string[];
    color: string;
    description: string;
}

function draftOf(room: RoomView | null): Draft {
    return {
        name: room?.name ?? "",
        type: room?.resource.type ?? "room",
        capacity: room?.resource.capacity ? String(room.resource.capacity) : "",
        building: room?.resource.building ?? "",
        floor: room?.resource.floor ?? "",
        features: [...(room?.resource.features ?? [])],
        color: room?.color ?? CALENDAR_COLORS[0],
        description: room?.description ?? ""
    };
}

function inputOf(draft: Draft) {
    const capacity = draft.capacity.trim() === "" ? null : Number(draft.capacity);
    return { ...draft, capacity };
}

export function RoomDialog({
    room,
    onClose,
    onSaved
}: {
    room: RoomView | null;
    onClose: () => void;
    onSaved: (room: RoomView) => void;
}) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const [draft, setDraft] = useState<Draft>(() => draftOf(room));
    const [feature, setFeature] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const initial = JSON.stringify(draftOf(room));
    const parsed = roomInputSchema.safeParse(inputOf(draft));
    const dirty = JSON.stringify(draft) !== initial;
    const issueFor = (field: string) => {
        if (parsed.success) return null;
        const issues = parsed.error.issues.filter((issue) => issue.path[0] === field);
        return issues.length > 0 ? issueText(issues) : null;
    };
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));

    const addFeature = () => {
        const clean = feature.trim();
        if (!clean || draft.features.includes(clean) || draft.features.length >= 20) return;
        set("features", [...draft.features, clean]);
        setFeature("");
    };

    const save = async () => {
        if (!parsed.success || busy || !dirty) return;
        setBusy(true);
        setProblem(null);
        try {
            const answer = await unwrap(
                () =>
                    room
                        ? roomActions.updateRoomAction(room.id, parsed.data)
                        : roomActions.createRoomAction(parsed.data),
                t("rooms.failed")
            );
            onSaved(answer.room);
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const nameMissing = draft.name.trim() === "";
    const blocked = !parsed.success || !dirty || busy;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{room ? t("rooms.editTitle") : t("rooms.newTitle")}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <FieldRow
                        label={`${t("rooms.name")} *`}
                        htmlFor="room-name"
                        error={nameMissing ? null : issueFor("name")}
                    >
                        <Input
                            id="room-name"
                            value={draft.name}
                            onChange={(event) => set("name", event.target.value)}
                            autoFocus
                        />
                    </FieldRow>
                    <SegmentedControl
                        aria-label={t("rooms.type")}
                        value={draft.type}
                        onValueChange={(value) => set("type", value)}
                        options={[
                            { value: "room", label: t("rooms.typeRoom") },
                            { value: "equipment", label: t("rooms.typeEquipment") }
                        ]}
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <FieldRow
                            label={t("rooms.capacity")}
                            htmlFor="room-capacity"
                            error={issueFor("capacity")}
                        >
                            <Input
                                id="room-capacity"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={draft.capacity}
                                onChange={(event) => set("capacity", event.target.value)}
                            />
                        </FieldRow>
                        <FieldRow
                            label={t("rooms.building")}
                            htmlFor="room-building"
                            error={issueFor("building")}
                        >
                            <Input
                                id="room-building"
                                value={draft.building}
                                onChange={(event) => set("building", event.target.value)}
                            />
                        </FieldRow>
                        <FieldRow
                            label={t("rooms.floor")}
                            htmlFor="room-floor"
                            error={issueFor("floor")}
                        >
                            <Input
                                id="room-floor"
                                value={draft.floor}
                                onChange={(event) => set("floor", event.target.value)}
                            />
                        </FieldRow>
                    </div>
                    <FieldRow
                        label={t("rooms.features")}
                        htmlFor="room-feature"
                        hint={t("rooms.featuresHint")}
                    >
                        <div className="flex gap-2">
                            <Input
                                id="room-feature"
                                value={feature}
                                onChange={(event) => setFeature(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        addFeature();
                                    }
                                }}
                            />
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={addFeature}
                                disabled={feature.trim() === ""}
                            >
                                {t("rooms.addFeature")}
                            </Button>
                        </div>
                        {draft.features.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                                {draft.features.map((entry) => (
                                    <span
                                        key={entry}
                                        className="inline-flex items-center gap-1 rounded border border-border bg-field py-0.5 pl-2 pr-0.5 text-xs"
                                    >
                                        {entry}
                                        <button
                                            type="button"
                                            className="rounded p-0.5 text-foreground-subtle hover:text-foreground"
                                            aria-label={t("rooms.removeFeature", { name: entry })}
                                            title={t("rooms.removeFeature", { name: entry })}
                                            onClick={() =>
                                                set(
                                                    "features",
                                                    draft.features.filter(
                                                        (other) => other !== entry
                                                    )
                                                )
                                            }
                                        >
                                            <X className="size-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                    </FieldRow>
                    <FieldRow label={t("rooms.color")}>
                        <div
                            className="flex flex-wrap gap-1.5"
                            role="radiogroup"
                            aria-label={t("rooms.color")}
                        >
                            {CALENDAR_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    role="radio"
                                    aria-checked={draft.color === color}
                                    aria-label={color}
                                    title={color}
                                    onClick={() => set("color", color)}
                                    className={cn(
                                        "size-6 rounded-full border-2",
                                        draft.color === color
                                            ? "border-foreground"
                                            : "border-transparent"
                                    )}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </FieldRow>
                    <FieldRow
                        label={t("rooms.descriptionLabel")}
                        htmlFor="room-description"
                        error={issueFor("description")}
                    >
                        <Textarea
                            id="room-description"
                            rows={3}
                            value={draft.description}
                            onChange={(event) => set("description", event.target.value)}
                        />
                    </FieldRow>
                    {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("rooms.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={blocked} disabled={busy}>
                            {room ? t("rooms.save") : t("rooms.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
