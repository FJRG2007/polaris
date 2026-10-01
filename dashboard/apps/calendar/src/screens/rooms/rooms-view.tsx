"use client";

/**
 * The rooms and equipment people invite to events. Everybody with the Calendar
 * sees the list; whoever changes instance settings adds, edits and removes.
 */

import { useState } from "react";
import { useCalendarT } from "../i18n";
import { roomPlace } from "./room-picker";
import { StatusNote } from "../public/kit";
import { RoomDialog } from "./room-dialog";
import { hostUi } from "@polaris/app-host/client";
import * as roomActions from "../../actions/resources";
import type { RoomView } from "../../lib/scheduling-wire";
import { Button, EmptyState, Skeleton } from "@polaris/ui";
import { Boxes, DoorOpen, Pencil, Plus, Trash2, Users } from "lucide-react";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";

type Listing = { rooms: RoomView[]; canManage: boolean };

export function RoomsView() {
    const t = useCalendarT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [editing, setEditing] = useState<RoomView | "new" | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const read = useCachedRead<Listing>(cacheKey("rooms"), async () => {
        const answer = await unwrap(() => roomActions.listRoomsAction(), t("rooms.failed"));
        return { rooms: answer.rooms, canManage: answer.canManage };
    });
    const listing = read.data;

    const saved = (room: RoomView) => {
        if (!listing) return;
        const others = listing.rooms.filter((entry) => entry.id !== room.id);
        read.replace({ ...listing, rooms: [...others, room].sort((a, b) => a.name.localeCompare(b.name)) });
        dropCached("rooms-for");
        setEditing(null);
    };

    const remove = async (room: RoomView) => {
        if (!listing) return;
        const ok = await confirm({ title: t("rooms.removeTitle", { name: room.name }), description: t("rooms.removeBody"), confirmLabel: t("rooms.remove"), danger: true });
        if (!ok) return;
        setProblem(null);
        read.replace({ ...listing, rooms: listing.rooms.filter((entry) => entry.id !== room.id) });
        try {
            await unwrap(() => roomActions.removeRoomAction(room.id), t("rooms.failed"));
            dropCached("rooms-for");
        } catch (caught) {
            read.replace(listing);
            setProblem(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] text-muted-foreground">{listing && !listing.canManage ? t("rooms.readOnly") : t("rooms.intro")}</p>
                {listing?.canManage ? (
                    <Button size="sm" onClick={() => setEditing("new")}>
                        <Plus />
                        {t("rooms.new")}
                    </Button>
                ) : null}
            </div>
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {read.error ? <StatusNote tone="danger">{read.error}</StatusNote> : null}
            {read.loading ? (
                <div className="flex flex-col gap-1.5">
                    {[0, 1, 2].map((index) => (
                        <Skeleton key={index} className="h-14 w-full" />
                    ))}
                </div>
            ) : listing && listing.rooms.length === 0 ? (
                <EmptyState
                    icon={<DoorOpen />}
                    title={t("rooms.noneTitle")}
                    description={listing.canManage ? t("rooms.noneManage") : t("rooms.noneBody")}
                    action={
                        listing.canManage ? (
                            <Button size="sm" onClick={() => setEditing("new")}>
                                <Plus />
                                {t("rooms.new")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {listing?.rooms.map((room) => (
                        <li key={room.id} className="group flex items-center gap-3 px-3 py-2.5">
                            <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: room.color }} />
                            {room.resource.type === "room" ? <DoorOpen className="size-4 text-foreground-subtle" /> : <Boxes className="size-4 text-foreground-subtle" />}
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-medium" title={room.name}>
                                    {room.name}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-2 text-xs text-foreground-subtle">
                                    <span>{room.resource.type === "room" ? t("rooms.typeRoom") : t("rooms.typeEquipment")}</span>
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
                            {listing?.canManage ? (
                                <div className="flex shrink-0 items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                                    <Button size="icon-sm" variant="ghost" aria-label={t("rooms.edit", { name: room.name })} title={t("rooms.edit", { name: room.name })} onClick={() => setEditing(room)}>
                                        <Pencil />
                                    </Button>
                                    <Button size="icon-sm" variant="ghost" aria-label={t("rooms.removeNamed", { name: room.name })} title={t("rooms.removeNamed", { name: room.name })} onClick={() => void remove(room)}>
                                        <Trash2 />
                                    </Button>
                                </div>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
            {editing ? <RoomDialog room={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={saved} /> : null}
            {confirmElement}
        </div>
    );
}
