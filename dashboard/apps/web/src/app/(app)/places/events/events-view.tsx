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
 */

import Image from "next/image";
import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { EventView } from "@/lib/home/events";
import { Bell, Check, Loader2 } from "lucide-react";
import type { CameraView } from "@/lib/home/cameras";
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, EmptyState, Select, Skeleton, cn } from "@polaris/ui";

const KINDS = [
    { value: "", label: "Everything" },
    { value: "person", label: "People" },
    { value: "face", label: "Known faces" },
    { value: "vehicle", label: "Vehicles" },
    { value: "animal", label: "Animals" },
    { value: "motion", label: "Movement" }
];

const KIND_LABEL: Record<string, string> = {
    motion: "Movement",
    person: "Somebody",
    vehicle: "A vehicle",
    animal: "An animal",
    face: "Recognized",
    tamper: "Camera tampered with",
    offline: "Camera went quiet"
};

export function EventsView({ canControl }: { canControl: boolean }) {
    const format = useDisplayFormat();
    const [events, setEvents] = useState<EventView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [kind, setKind] = useState("");
    const [loadingMore, setLoadingMore] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const list = await actions.listCamerasAction();
            if (!cancelled) setCameras(list.cameras ?? []);
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
            const result = await actions.listEventsAction({ cameraId: cameraId || null, kind: kind || null });
            if (cancelled) return;
            if (result.error) setError(result.error);
            setEvents(result.events ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [cameraId, kind]);

    const loadMore = async () => {
        if (!events?.length) return;
        setLoadingMore(true);
        const result = await runAction(
            () =>
                actions.listEventsAction({
                    cameraId: cameraId || null,
                    kind: kind || null,
                    before: events[events.length - 1]?.at ?? null
                }),
            setError
        );
        setLoadingMore(false);
        if (!result?.events) return;
        if (result.events.length === 0) setDone(true);
        setEvents((current) => [...(current ?? []), ...(result.events ?? [])]);
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
                (current ?? []).map((item) => (item.id === event.id ? { ...item, acked: false } : item))
            );
        }
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
                <Select value={kind} onValueChange={setKind} className="w-44" aria-label="What happened" options={KINDS} />
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
                                className={cn(
                                    "overflow-hidden rounded-lg border border-border bg-card",
                                    event.acked && "opacity-60"
                                )}
                            >
                                <div className="relative aspect-video bg-background">
                                    {event.stillKey ? (
                                        <Image
                                            src={`/api/home/events/${event.id}/still`}
                                            alt=""
                                            fill
                                            sizes="(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw"
                                            className="object-cover"
                                            unoptimized
                                        />
                                    ) : (
                                        <span className="flex size-full items-center justify-center text-[11px] text-foreground-subtle">
                                            No picture kept
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-start justify-between gap-2 border-t border-border px-3 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] text-foreground">
                                            {event.label ?? KIND_LABEL[event.kind] ?? event.kind}
                                        </p>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {event.cameraName} - {format.dateTime(event.at)}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {event.score !== null ? (
                                            <Badge variant="neutral" title="How sure the detector was">
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
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {!done ? (
                        <div className="flex justify-center">
                            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                                {loadingMore ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                Show older
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}

function FeedSkeleton() {
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((index) => (
                <div key={index} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="border-t border-border px-3 py-2">
                        <Skeleton className="h-3.5 w-32" />
                    </div>
                </div>
            ))}
        </div>
    );
}
