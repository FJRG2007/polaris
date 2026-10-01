"use client";

/**
 * Choosing a room or a piece of equipment for an event: filtered by what it
 * holds and where it is, and marked free or taken for the event's time. The
 * one picked is invited like a person, as a ROOM or RESOURCE attendee, and
 * answers for itself when the event is saved.
 *
 * Plugs into the event editor as `calendarSlots.RoomPicker`.
 */

import Link from "next/link";
import { ToggleChip } from "../ui";
import { useCalendarT } from "../i18n";
import { useMemo, useState } from "react";
import { StatusNote } from "../public/kit";
import type { RoomPickerSlotProps } from "../slots";
import * as roomActions from "../../actions/resources";
import { Boxes, DoorOpen, Search, Users } from "lucide-react";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";
import type { RoomAvailability } from "../../lib/scheduling-wire";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";

const ANY = "*";

/** Where a room is, as one line. */
export function roomPlace(room: RoomAvailability | { resource: RoomAvailability["resource"] }): string {
    return [room.resource.building, room.resource.floor].filter(Boolean).join(", ");
}

export function RoomPicker({ open, onOpenChange, start, end, onPick }: RoomPickerSlotProps) {
    const t = useCalendarT();
    const [query, setQuery] = useState("");
    const [capacity, setCapacity] = useState("");
    const [building, setBuilding] = useState(ANY);
    const [floor, setFloor] = useState(ANY);
    const [features, setFeatures] = useState<string[]>([]);
    const [onlyFree, setOnlyFree] = useState(true);

    const read = useCachedRead<RoomAvailability[]>(
        open ? cacheKey("rooms-for", start, end) : null,
        async () => (await unwrap(() => roomActions.roomsForAction({ start, end }), t("rooms.failed"))).rooms,
        { freshMs: 10_000 }
    );
    const rooms = read.data ?? [];
    const buildings = useMemo(() => [...new Set(rooms.map((room) => room.resource.building).filter(Boolean))].sort(), [rooms]);
    const floors = useMemo(
        () => [...new Set(rooms.filter((room) => building === ANY || room.resource.building === building).map((room) => room.resource.floor).filter(Boolean))].sort(),
        [rooms, building]
    );
    const allFeatures = useMemo(() => [...new Set(rooms.flatMap((room) => room.resource.features))].sort(), [rooms]);

    const seats = Number.parseInt(capacity, 10);
    const words = query.trim().toLowerCase();
    const shown = rooms.filter(
        (room) =>
            (!onlyFree || room.free) &&
            (!words || `${room.name} ${roomPlace(room)}`.toLowerCase().includes(words)) &&
            (!Number.isFinite(seats) || (room.resource.capacity ?? 0) >= seats) &&
            (building === ANY || room.resource.building === building) &&
            (floor === ANY || room.resource.floor === floor) &&
            features.every((feature) => room.resource.features.includes(feature))
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("rooms.pickTitle")}</DialogTitle>
                    <DialogDescription>{t("rooms.pickDescription")}</DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="relative sm:col-span-2">
                        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("rooms.search")} aria-label={t("rooms.search")} className="pl-8" />
                    </div>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={capacity}
                        onChange={(event) => setCapacity(event.target.value)}
                        placeholder={t("rooms.minCapacity")}
                        aria-label={t("rooms.minCapacity")}
                    />
                    <Select
                        value={building}
                        onValueChange={(value) => {
                            setBuilding(value);
                            setFloor(ANY);
                        }}
                        aria-label={t("rooms.building")}
                        options={[{ value: ANY, label: t("rooms.anyBuilding") }, ...buildings.map((name) => ({ value: name, label: name }))]}
                    />
                    <Select
                        value={floor}
                        onValueChange={setFloor}
                        aria-label={t("rooms.floor")}
                        options={[{ value: ANY, label: t("rooms.anyFloor") }, ...floors.map((name) => ({ value: name, label: name }))]}
                    />
                    <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                        <Switch checked={onlyFree} onChange={setOnlyFree} aria-label={t("rooms.onlyFree")} />
                        {t("rooms.onlyFree")}
                    </label>
                </div>
                {allFeatures.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("rooms.features")}>
                        {allFeatures.map((feature) => (
                            <ToggleChip
                                key={feature}
                                pressed={features.includes(feature)}
                                onPressedChange={(pressed) => setFeatures((list) => (pressed ? [...list, feature] : list.filter((entry) => entry !== feature)))}
                            >
                                {feature}
                            </ToggleChip>
                        ))}
                    </div>
                ) : null}

                {read.error ? <StatusNote tone="danger">{read.error}</StatusNote> : null}
                <div className="flex max-h-[45vh] flex-col gap-1 overflow-y-auto">
                    {read.loading ? (
                        [0, 1, 2].map((index) => <Skeleton key={index} className="h-12 w-full" />)
                    ) : rooms.length === 0 ? (
                        <EmptyState
                            bare
                            icon={<DoorOpen />}
                            title={t("rooms.noneTitle")}
                            description={t("rooms.noneBody")}
                            action={
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/calendar/rooms">{t("rooms.openList")}</Link>
                                </Button>
                            }
                        />
                    ) : shown.length === 0 ? (
                        <p className="py-6 text-center text-[13px] text-muted-foreground">{t("rooms.noMatch")}</p>
                    ) : (
                        shown.map((room) => (
                            <div key={room.id} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
                                {room.resource.type === "room" ? <DoorOpen className="size-4 text-foreground-subtle" /> : <Boxes className="size-4 text-foreground-subtle" />}
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-medium" title={room.name}>
                                        {room.name}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-foreground-subtle">
                                        {room.resource.capacity ? (
                                            <span className="inline-flex items-center gap-1">
                                                <Users className="size-3" />
                                                {room.resource.capacity}
                                            </span>
                                        ) : null}
                                        {roomPlace(room) ? <span className="truncate">{roomPlace(room)}</span> : null}
                                        {room.resource.features.length > 0 ? <span className="truncate">{room.resource.features.join(", ")}</span> : null}
                                    </div>
                                </div>
                                <span
                                    className={cn(
                                        "shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium",
                                        room.free ? "border-success-edge bg-success-soft text-success-ink" : "border-danger-edge bg-danger-soft text-danger-ink"
                                    )}
                                >
                                    {room.free ? t("rooms.free") : t("rooms.taken")}
                                </span>
                                <Button size="sm" variant="outline" onClick={() => onPick({ email: room.email, name: room.name, type: room.resource.type === "room" ? "ROOM" : "RESOURCE" })}>
                                    {t("rooms.choose")}
                                </Button>
                            </div>
                        ))
                    )}
                </div>
                {!onlyFree && shown.some((room) => !room.free) ? <p className="text-xs text-foreground-subtle">{t("rooms.takenHint")}</p> : null}
            </DialogContent>
        </Dialog>
    );
}
