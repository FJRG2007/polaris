"use client";

/**
 * Drawing on a camera.
 *
 * The only way this ever gets configured by somebody who is not reading a
 * reference is by drawing it on the picture, so that is what this is: the
 * camera's own frame, and an outline traced over it with the pointer. Click to
 * drop a corner, drag one to move it, and the shape closes itself.
 *
 * Everything is in frame-relative units the moment it leaves the pointer, so the
 * outline drawn on a 640-wide preview is the outline the worker tests a
 * 1920-wide frame against. The conversion happens once, here, against the
 * element's own box - never against a remembered size, because the dialog is
 * resizable and the picture is not always the shape the camera claims.
 *
 * Which is why the box the pointer is measured against is given the camera's own
 * shape the moment its frame loads. A 4:3 doorbell drawn on a 16:9 box sits in
 * the middle of it with a bar down each side, and a corner traced on the left
 * edge of what is visible would be stored as an eighth of the way in - an
 * outline that looks right here and covers the wrong part of the frame on the
 * machine watching. Sixteen by nine is only the shape used until the picture
 * says otherwise.
 */

import * as actions from "../actions";
import * as zoning from "@polaris/core";
import { useEffect, useRef, useState } from "react";
import { Eraser, Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import { OBJECT_CLASSES, type ObjectClass } from "../../lib/detection";
import { usePlacesT } from "../use-places-t";
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Switch,
    cn
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";

const { runAction } = hostUi.runAction;

/** What the form for one area holds. Strings for anything typed, so a
 *  half-deleted number is a half-deleted number rather than NaN. */
interface Draft {
    id: string | null;
    name: string;
    kind: zoning.ZoneKind;
    points: zoning.ZonePoint[];
    objects: ObjectClass[];
    inertia: string;
    loiterSeconds: string;
    enabled: boolean;
}

/** The colours areas are drawn in, so two next to each other can be told apart.
 *  Ignore areas are always the same red whatever their position in the list -
 *  "this one is off" is the thing being said, and it should not be a different
 *  colour on each camera. */
const WATCH_COLORS = ["#8b5cf6", "#22d3ee", "#f59e0b", "#34d399", "#f472b6", "#60a5fa"];
const IGNORE_COLOR = "#f43f5e";

/** The shape of the drawing box before the camera's frame has said what shape it
 *  is, and the shape it keeps for a camera that never sends one. */
const DEFAULT_SHAPE = 16 / 9;

function colorFor(zone: { kind: zoning.ZoneKind }, index: number): string {
    return zone.kind === "ignore"
        ? IGNORE_COLOR
        : (WATCH_COLORS[index % WATCH_COLORS.length] ?? WATCH_COLORS[0]!);
}

function emptyDraft(): Draft {
    return {
        id: null,
        name: "",
        kind: "watch",
        points: [],
        objects: [],
        inertia: "3",
        loiterSeconds: "0",
        enabled: true
    };
}

function draftOf(zone: zoning.Zone): Draft {
    return {
        id: zone.id,
        name: zone.name,
        kind: zone.kind,
        points: [...zone.points],
        objects: zone.objects.filter((entry): entry is ObjectClass =>
            (OBJECT_CLASSES as readonly string[]).includes(entry)
        ),
        inertia: String(zone.inertia),
        loiterSeconds: String(zone.loiterSeconds),
        enabled: zone.enabled
    };
}

export function ZonesDialog({
    camera,
    onClose
}: {
    camera: { id: string; name: string };
    onClose: () => void;
}) {
    const t = usePlacesT();
    const [zones, setZones] = useState<zoning.Zone[]>([]);
    const [draft, setDraft] = useState<Draft>(emptyDraft);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which corner is being dragged, if any. */
    const [dragging, setDragging] = useState<number | null>(null);
    /** A camera that is off, asleep, or not yet handed to the relay has no frame
     *  to show. Drawing still works and still means the same thing, so this says
     *  so rather than leaving a broken picture. */
    const [noPicture, setNoPicture] = useState(false);
    /** The camera's own shape, read off the frame once it has loaded. */
    const [shape, setShape] = useState<number | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let live = true;
        void actions.listCameraZonesAction(camera.id).then((result) => {
            if (!live) return;
            if (result.error) setError(result.error);
            setZones(result.zones ?? []);
            setLoading(false);
        });
        return () => {
            live = false;
        };
    }, [camera.id]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));

    /** Where a pointer event landed, as a fraction of the picture. Read off the
     *  element rather than a stored size: the dialog is fluid and the frame is
     *  whatever shape the camera sent. */
    const pointAt = (event: React.PointerEvent): zoning.ZonePoint | null => {
        const box = frameRef.current?.getBoundingClientRect();
        if (!box || box.width === 0 || box.height === 0) return null;
        const x = (event.clientX - box.left) / box.width;
        const y = (event.clientY - box.top) / box.height;
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    };

    const addPoint = (event: React.PointerEvent) => {
        if (dragging !== null) return;
        const point = pointAt(event);
        if (!point) return;
        if (draft.points.length >= zoning.MAX_ZONE_POINTS) return;
        set("points", [...draft.points, point]);
    };

    const movePoint = (event: React.PointerEvent) => {
        if (dragging === null) return;
        const point = pointAt(event);
        if (!point) return;
        set(
            "points",
            draft.points.map((existing, index) => (index === dragging ? point : existing))
        );
    };

    const enough = draft.points.length >= zoning.MIN_ZONE_POINTS;
    const incomplete = !draft.name.trim() || !enough;

    const save = async () => {
        setBusy(true);
        const result = await runAction(
            () =>
                actions.saveCameraZoneAction(camera.id, draft.id, {
                    name: draft.name,
                    kind: draft.kind,
                    points: draft.points.map((point) => [point.x, point.y]),
                    objects: draft.objects,
                    inertia: Number(draft.inertia) || 3,
                    loiterSeconds: Number(draft.loiterSeconds) || 0,
                    enabled: draft.enabled
                }),
            setError
        );
        setBusy(false);
        if (!result?.zone) return;
        const saved = result.zone;
        setZones((current) => {
            const without = current.filter((zone) => zone.id !== saved.id);
            return [...without, saved];
        });
        setDraft(emptyDraft());
    };

    const remove = async (zone: zoning.Zone) => {
        setBusy(true);
        const result = await runAction(
            () => actions.deleteCameraZoneAction(camera.id, zone.id),
            setError
        );
        setBusy(false);
        if (result?.error) return;
        setZones((current) => current.filter((entry) => entry.id !== zone.id));
        if (draft.id === zone.id) setDraft(emptyDraft());
    };

    /** The areas drawn behind the one being edited, so a new outline is placed
     *  against the ones already there rather than on a bare picture. */
    const others = zones.filter((zone) => zone.id !== draft.id);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="w-[min(64rem,95vw)] max-w-[min(64rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>{t("zones.title", { name: camera.name })}</DialogTitle>
                    <DialogDescription>
                        {t("zones.intro")}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
                    <div className="flex flex-col gap-2">
                        <div
                            ref={frameRef}
                            onPointerDown={addPoint}
                            onPointerMove={movePoint}
                            onPointerUp={() => setDragging(null)}
                            onPointerLeave={() => setDragging(null)}
                            style={{
                                aspectRatio: shape ?? DEFAULT_SHAPE,
                                // A tall camera - a doorbell on its side - must
                                // not push the rest of the dialog off the
                                // screen. Bounded by width so the box keeps the
                                // picture's shape exactly, which is the whole
                                // point of taking it.
                                maxWidth: `calc(70vh * ${shape ?? DEFAULT_SHAPE})`
                            }}
                            className="relative mx-auto w-full cursor-crosshair overflow-hidden rounded-md bg-surface-sunken"
                        >
                            {/* The camera's own frame. A camera that is asleep answers 503 and
                                the picture simply does not arrive, which is the right outcome:
                                an area can still be drawn on the empty box, and the numbers
                                mean the same thing. */}
                            {noPicture ? (
                                <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[0.75rem] text-foreground-subtle">
                                    {t("zones.noPicture")}
                                </span>
                            ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={`/api/home/cameras/${camera.id}/snapshot?w=960`}
                                    alt=""
                                    draggable={false}
                                    onError={() => setNoPicture(true)}
                                    onLoad={(event) => {
                                        const { naturalWidth, naturalHeight } = event.currentTarget;
                                        if (naturalWidth > 0 && naturalHeight > 0) {
                                            setShape(naturalWidth / naturalHeight);
                                        }
                                    }}
                                    className="pointer-events-none size-full select-none object-contain"
                                />
                            )}
                            <svg
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                                className="pointer-events-none absolute inset-0 size-full"
                            >
                                {others.map((zone, index) => (
                                    <polygon
                                        key={zone.id}
                                        points={zoning.polygonPoints(zone.points, 100, 100)}
                                        fill={colorFor(zone, index)}
                                        fillOpacity={zone.enabled ? 0.12 : 0.04}
                                        stroke={colorFor(zone, index)}
                                        strokeOpacity={zone.enabled ? 0.5 : 0.2}
                                        strokeWidth={0.4}
                                    />
                                ))}
                                {draft.points.length > 1 ? (
                                    <polygon
                                        points={zoning.polygonPoints(draft.points, 100, 100)}
                                        fill={
                                            draft.kind === "ignore" ? IGNORE_COLOR : WATCH_COLORS[0]
                                        }
                                        fillOpacity={0.25}
                                        stroke={
                                            draft.kind === "ignore" ? IGNORE_COLOR : WATCH_COLORS[0]
                                        }
                                        strokeWidth={0.5}
                                    />
                                ) : null}
                            </svg>
                            {/* The corners are their own elements rather than SVG circles: they
                                have to be grabbed, and a hit target on a stretched viewBox is
                                the wrong shape at both ends of the picture. */}
                            {draft.points.map((point, index) => (
                                <button
                                    key={`${index}-${point.x}-${point.y}`}
                                    type="button"
                                    aria-label={t("zones.corner", { number: index + 1 })}
                                    onPointerDown={(event) => {
                                        event.stopPropagation();
                                        setDragging(index);
                                    }}
                                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                                    className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-white bg-primary shadow"
                                />
                            ))}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={draft.points.length === 0}
                                onClick={() => set("points", draft.points.slice(0, -1))}
                            >
                                <Undo2 className="size-4 shrink-0" />
                                {t("zones.undo")}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={draft.points.length === 0}
                                onClick={() => set("points", [])}
                            >
                                <Eraser className="size-4 shrink-0" />
                                {t("zones.startOver")}
                            </Button>
                            <span className="text-[0.75rem] text-foreground-subtle">
                                {enough
                                    ? t("zones.corners", { count: draft.points.length })
                                    : t("zones.needMore", { count: zoning.MIN_ZONE_POINTS - draft.points.length })}
                            </span>
                        </div>
                    </div>

                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                            <p className="text-[0.75rem] font-medium text-muted-foreground">
                                {t("cameras.areas")}
                            </p>
                            {loading ? (
                                <p className="text-[0.8125rem] text-foreground-subtle">
                                    {t("zones.reading")}
                                </p>
                            ) : zones.length === 0 ? (
                                <p className="text-[0.8125rem] text-foreground-subtle">
                                    {t("zones.none")}
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {zones.map((zone, index) => (
                                        <li key={zone.id} className="flex items-center gap-2">
                                            <span
                                                aria-hidden
                                                className="size-2.5 shrink-0 rounded-full"
                                                style={{ backgroundColor: colorFor(zone, index) }}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setDraft(draftOf(zone))}
                                                className={cn(
                                                    "min-w-0 flex-1 truncate text-left text-[0.8125rem]",
                                                    draft.id === zone.id &&
                                                        "font-medium text-primary"
                                                )}
                                            >
                                                {zone.name}
                                            </button>
                                            {zone.kind === "ignore" ? (
                                                <Badge variant="neutral">{t("zones.ignored")}</Badge>
                                            ) : null}
                                            {!zone.enabled ? (
                                                <Badge variant="neutral">{t("zones.off")}</Badge>
                                            ) : null}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("cameras.removeName", { name: zone.name })}
                                                title={t("cameras.remove")}
                                                disabled={busy}
                                                onClick={() => void remove(zone)}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="flex flex-col gap-3 border-t border-border pt-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-[0.75rem] font-medium text-muted-foreground">
                                    {t("placeDialog.name")} <span aria-hidden>*</span>
                                </span>
                                <Input
                                    value={draft.name}
                                    onChange={(event) => set("name", event.target.value)}
                                    placeholder={t("zones.namePlaceholder")}
                                />
                            </label>

                            <SegmentedControl
                                value={draft.kind}
                                onValueChange={(value) => set("kind", value as zoning.ZoneKind)}
                                options={zoning.ZONE_KINDS.map((kind) => ({
                                    value: kind,
                                    label: t(`zones.kinds.${kind}.label`)
                                }))}
                            />
                            <p className="text-[0.75rem] text-foreground-subtle">
                                {t(`zones.kinds.${draft.kind}.summary`)}
                            </p>

                            <div className="flex flex-col gap-1">
                                <span className="text-[0.75rem] font-medium text-muted-foreground">
                                    {t("zones.counts")}
                                </span>
                                <div className="flex flex-wrap gap-3">
                                    {OBJECT_CLASSES.map((item) => (
                                        <label
                                            key={item}
                                            className="flex items-center gap-2 text-[0.8125rem]"
                                        >
                                            <Checkbox
                                                checked={draft.objects.includes(item)}
                                                onChange={(event) =>
                                                    set(
                                                        "objects",
                                                        event.target.checked
                                                            ? [...draft.objects, item]
                                                            : draft.objects.filter(
                                                                  (value) => value !== item
                                                              )
                                                    )
                                                }
                                            />
                                            {t(`objects.${item}`)}
                                        </label>
                                    ))}
                                </div>
                                <p className="text-[0.75rem] text-foreground-subtle">
                                    {draft.objects.length === 0
                                        ? t("zones.everything")
                                        : t("zones.rest")}
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <label className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-[0.75rem] font-medium text-muted-foreground">
                                        {t("zones.inertia")}
                                    </span>
                                    <Input
                                        value={draft.inertia}
                                        onChange={(event) => set("inertia", event.target.value)}
                                        inputMode="numeric"
                                    />
                                </label>
                                <label className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-[0.75rem] font-medium text-muted-foreground">
                                        {t("zones.loiter")}
                                    </span>
                                    <Input
                                        value={draft.loiterSeconds}
                                        onChange={(event) =>
                                            set("loiterSeconds", event.target.value)
                                        }
                                        inputMode="numeric"
                                    />
                                </label>
                            </div>

                            <label className="flex items-center justify-between gap-3">
                                <span className="text-[0.8125rem]">{t("zones.inUse")}</span>
                                <Switch
                                    checked={draft.enabled}
                                    onChange={(checked) => set("enabled", checked)}
                                />
                            </label>
                        </div>
                    </div>
                </div>

                {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}

                <DialogFooter>
                    {draft.id ? (
                        <Button
                            variant="ghost"
                            onClick={() => setDraft(emptyDraft())}
                            disabled={busy}
                        >
                            {t("zones.new")}
                        </Button>
                    ) : null}
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        {t("zones.done")}
                    </Button>
                    <Button
                        onClick={() => void save()}
                        disabled={busy || incomplete}
                        aria-disabled={incomplete}
                    >
                        {busy ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                            <Plus className="size-4 shrink-0" />
                        )}
                        {draft.id ? t("zones.save") : t("zones.add")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
