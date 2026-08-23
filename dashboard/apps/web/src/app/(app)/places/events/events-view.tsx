"use client";

/**
 * What the cameras noticed, newest first.
 *
 * Read as a list of pictures rather than a table of rows: the question somebody
 * has here is always "what was that", and a timestamp with the word "motion"
 * beside it does not answer it. Filtering is by camera and by kind, because
 * those are the two ways a real question is asked - "the front door, this
 * morning" and "people, anywhere".
 *
 * Paged by keyset rather than by page number. This is the table that grows
 * without limit, and asking for page forty of it is a query nobody should write.
 *
 * `?event=<id>` is what an alert and a notification link to. It is read by id
 * and put at the top of whatever is on screen, because a link followed two days
 * later names a moment that is pages down a list ordered newest first.
 */

import Image from "next/image";
import * as actions from "../actions";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { EventView } from "@/lib/home/events";
import { DetectionBox } from "../detection-box";
import { KIND_LABEL } from "../detection-label";
import type { CameraView } from "@/lib/home/cameras";
import { Bell, Check, Loader2, Trash2 } from "lucide-react";
import { MediaPlayer } from "@/components/media-player";
import { useDisplayFormat } from "@/components/display-format";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Select,
    Skeleton,
    cn
} from "@polaris/ui";

const KINDS = [
    { value: "", label: "Everything" },
    { value: "person", label: "People" },
    { value: "face", label: "Known faces" },
    { value: "vehicle", label: "Vehicles" },
    { value: "animal", label: "Animals" },
    { value: "package", label: "Parcels" },
    { value: "motion", label: "Movement" }
];

/** The shape every tile is drawn at. The stills are not all this shape - a
 *  still keeps whatever the camera sends - so it is also what the box drawn over
 *  one has to be told, or it is placed against the tile instead of against the
 *  picture inside it. */
const TILE_SHAPE = 16 / 9;

/** How long the thing was there, for a detector that followed it. Rounded to
 *  seconds: nobody reads a duration in milliseconds, and anything under one is
 *  an instant rather than a stay. */
function lasted(event: EventView): string | null {
    if (!event.endedAt) return null;
    const seconds = Math.round(
        (new Date(event.endedAt).getTime() - new Date(event.at).getTime()) / 1000
    );
    return seconds >= 1 ? `${seconds}s` : null;
}

export function EventsView({ canControl }: { canControl: boolean }) {
    const format = useDisplayFormat();
    /** The moment a link asked for, if any. */
    const asked = useSearchParams().get("event");
    const [events, setEvents] = useState<EventView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [people, setPeople] = useState<{ id: string; name: string; subjectId: string }[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [kind, setKind] = useState("");
    const [label, setLabel] = useState("");
    const [zone, setZone] = useState("");
    /** The watched areas anybody has drawn in this place, for the filter. Empty
     *  when nobody has drawn one, and then the filter is not offered at all. */
    const [zones, setZones] = useState<string[]>([]);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [moment, setMoment] = useState<{
        event: EventView;
        clipId: string;
        offsetSeconds: number;
    } | null>(null);
    const [noFootage, setNoFootage] = useState<string | null>(null);
    /** Each still's own shape, by event, learned as the pictures arrive. */
    const [shapes, setShapes] = useState<Record<string, number>>({});
    const [clearing, setClearing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [list, known, areas] = await Promise.all([
                actions.listCamerasAction(),
                actions.listPeopleAction(),
                actions.listPlaceZoneNamesAction()
            ]);
            if (cancelled) return;
            setCameras(list.cameras ?? []);
            setZones(areas.zones ?? []);
            setPeople(
                (known.people ?? []).map((person) => ({
                    id: person.id,
                    name: person.name,
                    subjectId: person.subjectId
                }))
            );
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setEvents(null);
        setDone(false);
        void (async () => {
            const result = await actions.listEventsAction({
                cameraId: cameraId || null,
                kind: kind || null,
                label: label || null,
                zone: zone || null,
                from: from || null,
                to: to || null
            });
            if (cancelled) return;
            if (result.error) setError(result.error);
            let list = result.events ?? [];
            // Followed from a message or a notification, and the tile it names
            // is only on this page while it is recent. Read on its own and put
            // first, so a link always lands on the thing it promised.
            if (asked && !list.some((item) => item.id === asked)) {
                const one = await actions.getEventAction(asked);
                if (cancelled) return;
                if (one.event) list = [one.event, ...list];
            }
            setEvents(list);
        })();
        return () => {
            cancelled = true;
        };
    }, [asked, cameraId, kind, label, zone, from, to]);

    const loadMore = async () => {
        if (!events?.length) return;
        setLoadingMore(true);
        const result = await runAction(
            () =>
                actions.listEventsAction({
                    cameraId: cameraId || null,
                    kind: kind || null,
                    label: label || null,
                    zone: zone || null,
                    from: from || null,
                    to: to || null,
                    before: events[events.length - 1]?.at ?? null
                }),
            setError
        );
        setLoadingMore(false);
        if (!result?.events) return;
        if (result.events.length === 0) setDone(true);
        setEvents((current) => [...(current ?? []), ...(result.events ?? [])]);
    };

    const remove = async (event: EventView) => {
        // Gone from the screen at once: a false positive is something somebody is
        // clearing off a list, and a list that pauses on each one is a list they
        // stop clearing. Put back if the server refuses.
        setEvents((current) => (current ?? []).filter((item) => item.id !== event.id));
        const result = await runAction(() => actions.deleteEventAction(event.id), setError);
        if (result?.error) {
            setError(result.error);
            setEvents((current) =>
                [event, ...(current ?? [])].sort((a, b) => b.at.localeCompare(a.at))
            );
        }
    };

    const clearShown = async () => {
        setClearing(false);
        const result = await runAction(
            () =>
                actions.clearEventsAction({
                    cameraId: cameraId || null,
                    kind: kind || null,
                    label: label || null,
                    zone: zone || null,
                    from: from || null,
                    to: to || null
                }),
            setError
        );
        if (result?.error) {
            setError(result.error);
            return;
        }
        setEvents([]);
    };

    const acknowledge = async (event: EventView) => {
        setEvents((current) =>
            (current ?? []).map((item) => (item.id === event.id ? { ...item, acked: true } : item))
        );
        const result = await runAction(() => actions.acknowledgeEventAction(event.id), setError);
        // Put it back the way it was if the server refused, rather than leaving
        // the screen claiming something that did not happen.
        if (result?.error) {
            setError(result.error);
            setEvents((current) =>
                (current ?? []).map((item) =>
                    item.id === event.id ? { ...item, acked: false } : item
                )
            );
        }
    };

    /**
     * What to call the person in an event.
     *
     * The event holds the subject the recognizer sent, which is fixed for life;
     * the name beside it is whatever they are called today. Resolving it here
     * rather than storing it twice is what makes correcting a name correct the
     * whole log instead of only what happens next.
     */
    const nameFor = (subject: string | null): string | null => {
        if (!subject) return null;
        return people.find((person) => person.subjectId === subject)?.name ?? subject;
    };

    /** Puts the moment a link named where somebody can see it, once. */
    const showAsked = useCallback((node: HTMLLIElement | null) => {
        node?.scrollIntoView({ block: "center" });
    }, []);

    const openMoment = async (event: EventView) => {
        setNoFootage(null);
        const result = await runAction(() => actions.momentAction(event.id), setError);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!result.moment) {
            // Said rather than opening an empty player: "nothing was kept" is an
            // answer, and it points at the setting that would have kept it.
            setNoFootage(event.id);
            return;
        }
        setMoment({ event, ...result.moment });
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
                <Select
                    value={cameraId}
                    onValueChange={setCameraId}
                    className="w-52"
                    aria-label="Camera"
                    options={[
                        { value: "", label: "Every camera" },
                        ...cameras.map((camera) => ({ value: camera.id, label: camera.name }))
                    ]}
                />
                <Select
                    value={kind}
                    onValueChange={setKind}
                    className="w-44"
                    aria-label="What happened"
                    options={KINDS}
                />
                {people.length > 0 ? (
                    <Select
                        value={label}
                        onValueChange={setLabel}
                        className="w-44"
                        aria-label="Who"
                        options={[
                            { value: "", label: "Anybody" },
                            // Filtered on the subject the recognizer wrote into
                            // the event, shown under whatever they are called
                            // now: a name corrected here still finds everything
                            // recorded before the correction.
                            ...people.map((person) => ({
                                value: person.subjectId,
                                label: person.name
                            }))
                        ]}
                    />
                ) : null}
                {zones.length > 0 ? (
                    <Select
                        value={zone}
                        onValueChange={setZone}
                        className="w-44"
                        aria-label="Where"
                        options={[
                            { value: "", label: "Anywhere" },
                            ...zones.map((name) => ({ value: name, label: name }))
                        ]}
                    />
                ) : null}
                <input
                    type="datetime-local"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    aria-label="From"
                    className="h-9 rounded-md border border-border bg-field px-2 text-[13px] text-foreground"
                />
                <input
                    type="datetime-local"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    aria-label="To"
                    className="h-9 rounded-md border border-border bg-field px-2 text-[13px] text-foreground"
                />
                {cameraId || kind || label || zone || from || to ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setCameraId("");
                            setKind("");
                            setLabel("");
                            setZone("");
                            setFrom("");
                            setTo("");
                        }}
                    >
                        Clear filters
                    </Button>
                ) : null}
                {canControl && (events?.length ?? 0) > 0 ? (
                    <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
                        <Trash2 className="size-4 shrink-0" />
                        Delete these
                    </Button>
                ) : null}
            </div>

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {events === null ? (
                <FeedSkeleton />
            ) : events.length === 0 ? (
                <EmptyState
                    icon={<Bell />}
                    title="Nothing yet"
                    description="When a camera notices something, it turns up here with the picture it took."
                />
            ) : (
                <>
                    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {events.map((event) => (
                            <li
                                key={event.id}
                                ref={event.id === asked ? showAsked : undefined}
                                className={cn(
                                    "overflow-hidden rounded-lg border bg-card",
                                    event.id === asked ? "border-primary" : "border-border",
                                    event.acked && "opacity-60"
                                )}
                            >
                                <button
                                    type="button"
                                    style={{ aspectRatio: TILE_SHAPE }}
                                    className="relative block w-full cursor-zoom-in bg-background"
                                    onClick={() => void openMoment(event)}
                                    aria-label={`See ${event.cameraName} at ${format.dateTime(event.at)}`}
                                >
                                    {event.stillKey ? (
                                        // Drawn whole rather than cropped to
                                        // fill: the box below is in fractions of
                                        // the frame, and a box over a cropped
                                        // picture points at the wrong part of it.
                                        // Its own shape is read off it as it
                                        // loads, because that is what says where
                                        // in the tile the picture ended up.
                                        <Image
                                            src={`/api/home/events/${event.id}/still`}
                                            alt=""
                                            fill
                                            sizes="(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw"
                                            className="object-contain"
                                            onLoad={(loaded) => {
                                                const { naturalWidth, naturalHeight } =
                                                    loaded.currentTarget;
                                                if (naturalWidth <= 0 || naturalHeight <= 0) return;
                                                setShapes((current) =>
                                                    current[event.id]
                                                        ? current
                                                        : {
                                                              ...current,
                                                              [event.id]:
                                                                  naturalWidth / naturalHeight
                                                          }
                                                );
                                            }}
                                            unoptimized
                                        />
                                    ) : (
                                        <span className="flex size-full items-center justify-center text-[11px] text-foreground-subtle">
                                            No picture kept
                                        </span>
                                    )}
                                    {event.stillKey ? (
                                        <DetectionBox
                                            box={event.box}
                                            label={
                                                nameFor(event.label) ??
                                                KIND_LABEL[event.kind] ??
                                                null
                                            }
                                            picture={shapes[event.id] ?? null}
                                            tile={TILE_SHAPE}
                                        />
                                    ) : null}
                                    {noFootage === event.id ? (
                                        <span className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-[11px] text-white">
                                            No footage of this moment was kept
                                        </span>
                                    ) : null}
                                </button>
                                <div className="flex items-start justify-between gap-2 border-t border-border px-3 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] text-foreground">
                                            {nameFor(event.label) ??
                                                KIND_LABEL[event.kind] ??
                                                event.kind}
                                        </p>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {[
                                                event.cameraName,
                                                format.dateTime(event.at),
                                                event.zones.length > 0
                                                    ? event.zones.join(", ")
                                                    : null,
                                                lasted(event)
                                            ]
                                                .filter(Boolean)
                                                .join(" - ")}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {event.score !== null ? (
                                            <Badge
                                                variant="neutral"
                                                title="How sure the detector was"
                                            >
                                                {event.score}
                                            </Badge>
                                        ) : null}
                                        {canControl && !event.acked ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Mark as seen"
                                                title="Mark as seen"
                                                onClick={() => acknowledge(event)}
                                            >
                                                <Check className="size-4 shrink-0" />
                                            </Button>
                                        ) : null}
                                        {canControl ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Delete this detection"
                                                title="Delete - it was nothing"
                                                onClick={() => void remove(event)}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {!done ? (
                        <div className="flex justify-center">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={loadMore}
                                disabled={loadingMore}
                            >
                                {loadingMore ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                ) : null}
                                Show older
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
            {clearing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setClearing(false)}
                    name="these detections"
                    kind="detections"
                    requireTyping={false}
                    title="Delete the detections on screen?"
                    question="Everything the current filters match is removed, along with its pictures. Footage is not touched."
                    confirmLabel="Delete them"
                    onConfirm={() => void clearShown()}
                />
            ) : null}

            {moment ? (
                <MomentDialog
                    title={`${moment.event.label ?? KIND_LABEL[moment.event.kind] ?? moment.event.kind} - ${moment.event.cameraName}, ${format.dateTime(moment.event.at)}`}
                    clipId={moment.clipId}
                    offsetSeconds={moment.offsetSeconds}
                    onClose={() => setMoment(null)}
                />
            ) : null}
        </div>
    );
}

/**
 * The footage of one moment.
 *
 * Seeked with a media fragment on the URL rather than by setting currentTime
 * after load: the range request that produces is what makes a jump into the
 * middle of a segment instant instead of a download of everything before it.
 */
function MomentDialog({
    title,
    clipId,
    offsetSeconds,
    onClose
}: {
    title: string;
    clipId: string;
    offsetSeconds: number;
    onClose: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                {/* The fragment is what opens it at the moment the event
                    happened rather than at the start of the clip. */}
                <MediaPlayer
                    kind="video"
                    autoPlay
                    src={`/api/home/clips/${clipId}/video#t=${offsetSeconds}`}
                    // Without the fragment: what is saved is the clip, not the
                    // moment somebody was sent to inside it.
                    download={`/api/home/clips/${clipId}/video`}
                    className="overflow-hidden rounded-md border border-border bg-black"
                />
            </DialogContent>
        </Dialog>
    );
}

function FeedSkeleton() {
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((index) => (
                <div
                    key={index}
                    className="overflow-hidden rounded-lg border border-border bg-card"
                >
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="border-t border-border px-3 py-2">
                        <Skeleton className="h-3.5 w-32" />
                    </div>
                </div>
            ))}
        </div>
    );
}
