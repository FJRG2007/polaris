"use client";

/**
 * The rooms and floors of a place, kept in one dialog: make, rename and remove
 * a floor, make, rename and remove a room, and say which floor a room is on.
 *
 * Every change shows at once and is put back, with the reason, when the server
 * refuses it. Removing either asks first, in the design's own dialog: a floor
 * leaves its rooms on none, a room leaves its devices in none.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import type { FloorView, RoomView } from "../../lib/room-kinds";
import { floorInputSchema, normalizeRoomInput, roomInputSchema } from "../../lib/schemas";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import { placesRefusalText } from "../../lib/refusal-text";

const { runAction } = hostUi.runAction;

/** The id a row carries until the server has made it. */
const TEMP_PREFIX = "new-";
const isTemp = (id: string) => id.startsWith(TEMP_PREFIX);

/** A name with a floor beside it: one line where there is room, the floor
 *  under the name on a phone. */
const ROW_WITH_FLOOR = "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center";
const FLOOR_SELECT = "min-w-0 flex-1 sm:w-40 sm:flex-none";
const ICON_BUTTON = "size-11 shrink-0 p-0 sm:size-8";
const TEXT_BUTTON = "h-11 shrink-0 sm:h-7";

/** The floors a room can be put on: none, or one the server has made. */
function floorOptions(floors: readonly FloorView[], none: string) {
    return [
        { value: "", label: none },
        ...floors.filter((each) => !isTemp(each.id)).map((each) => ({ value: each.id, label: each.name }))
    ];
}

/** What a name field says is wrong with what is in it, in the reader's words;
 *  nothing for an empty one, which is unfinished rather than wrong. */
function useNameIssue(value: string, schema: typeof floorInputSchema | typeof roomInputSchema) {
    const t = usePlacesT();
    if (!value.trim()) return null;
    const issue = schema.shape.name.safeParse(value.trim()).error?.issues[0]?.message;
    return issue ? placesRefusalText(t, issue) : null;
}

/**
 * One row of the list: a name that is edited where it is, an optional floor
 * beside it, a button that saves once something differs, and one that removes.
 */
function NameRow({
    name,
    floorId,
    floors,
    schema,
    label,
    pending = false,
    onSave,
    onRemove
}: {
    name: string;
    /** The room's floor; absent for a floor's own row. */
    floorId?: string;
    floors?: readonly FloorView[];
    schema: typeof floorInputSchema | typeof roomInputSchema;
    label: string;
    /** Still being made: shown, but nothing to do with it until it is saved. */
    pending?: boolean;
    onSave: (next: { name: string; floorId: string }) => void;
    onRemove: () => void;
}) {
    const t = usePlacesT();
    const [draft, setDraft] = useState(name);
    const [floor, setFloor] = useState(floorId ?? "");
    useEffect(() => setDraft(name), [name]);
    useEffect(() => setFloor(floorId ?? ""), [floorId]);
    const issue = useNameIssue(draft, schema);
    const dirty = draft.trim() !== name || floor !== (floorId ?? "");
    const ready = !pending && dirty && draft.trim().length > 0 && !issue;
    const save = () => {
        if (ready) onSave({ name: draft.trim(), floorId: floor });
    };
    return (
        <li className="flex min-w-0 flex-col gap-1">
            <div className={floors ? ROW_WITH_FLOOR : "flex min-w-0 items-center gap-2"}>
                <Input
                    value={draft}
                    maxLength={60}
                    aria-label={label}
                    className="min-w-0 flex-1"
                    disabled={pending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") save();
                    }}
                />
                <div className="flex min-w-0 items-center gap-2">
                    {floors && (
                        <Select
                            value={floor}
                            onValueChange={setFloor}
                            aria-label={t("roomsDialog.floorOf", { room: name })}
                            className={FLOOR_SELECT}
                            disabled={pending}
                            options={floorOptions(floors, t("roomsDialog.noFloor"))}
                        />
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        className={ICON_BUTTON}
                        aria-label={t("roomsDialog.saveName", { name })}
                        title={t("roomsDialog.saveName", { name })}
                        aria-disabled={!ready}
                        disabled={!ready}
                        onClick={save}
                    >
                        <Check className="size-4 shrink-0" />
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className={ICON_BUTTON}
                        aria-label={t("roomsDialog.removeName", { name })}
                        title={t("roomsDialog.removeName", { name })}
                        aria-disabled={pending}
                        disabled={pending}
                        onClick={onRemove}
                    >
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                </div>
            </div>
            {issue && <span className="text-xs text-danger">{issue}</span>}
        </li>
    );
}

type Removing = { kind: "floor"; floor: FloorView } | { kind: "room"; room: RoomView } | null;

export function RoomsDialog({
    open,
    placeId,
    onClose,
    onChanged
}: {
    open: boolean;
    placeId: string;
    onClose: () => void;
    /** After any change that stuck, for screens that show a device's room. */
    onChanged?: () => void;
}) {
    const t = usePlacesT();
    const [rooms, setRooms] = useState<RoomView[] | null>(null);
    const [floors, setFloors] = useState<FloorView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [newFloor, setNewFloor] = useState("");
    const [newRoom, setNewRoom] = useState("");
    const [newRoomFloor, setNewRoomFloor] = useState("");
    const [removing, setRemoving] = useState<Removing>(null);
    const [busy, setBusy] = useState(false);
    const [uses, setUses] = useState<Record<string, number>>({});
    const floorIssue = useNameIssue(newFloor, floorInputSchema);
    const roomIssue = useNameIssue(newRoom, roomInputSchema);

    useEffect(() => {
        if (!open) return;
        let current = true;
        setError(null);
        void actions.placeUsesAction(placeId).then(
            (result) => {
                if (current) setUses(result.uses ?? {});
            },
            () => undefined
        );
        void Promise.all([actions.listRoomsAction(placeId), actions.listFloorsAction(placeId)]).then(
            ([roomResult, floorResult]) => {
                if (!current) return;
                setRooms(roomResult.rooms ?? []);
                setFloors(floorResult.floors ?? []);
                const failed = roomResult.error ?? floorResult.error;
                if (failed) setError(failed);
            },
            () => {
                if (!current) return;
                setRooms([]);
                setFloors([]);
                setError(t("roomsDialog.unreadable"));
            }
        );
        return () => {
            current = false;
        };
    }, [open, placeId, t]);

    const byName = <T extends { name: string }>(list: T[]) =>
        [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    /** Apply a change now, ask the server, and undo that change alone if it
     *  refuses, so another change still in flight is not undone with it. */
    async function attempt<T>(
        apply: () => void,
        rollback: () => void,
        call: () => Promise<T & { error?: string }>,
        settle?: (result: T) => void
    ): Promise<void> {
        setError(null);
        apply();
        const result = await runAction(call, setError);
        if (!result || result.error) {
            rollback();
            if (result?.error) setError(result.error);
            return;
        }
        settle?.(result);
        onChanged?.();
    }

    const floorName = (id: string) => floors?.find((floor) => floor.id === id)?.name ?? "";

    const renameFloorTo = (floor: FloorView, name: string) => {
        setFloors((list) => byName((list ?? []).map((each) => (each.id === floor.id ? { ...each, name } : each))));
        setRooms((list) => (list ?? []).map((room) => (room.floorId === floor.id ? { ...room, floor: name } : room)));
    };

    const saveFloor = (floor: FloorView, name: string) => {
        void attempt(
            () => renameFloorTo(floor, name),
            () => renameFloorTo(floor, floor.name),
            () => actions.saveFloorAction(floor.id, { name })
        );
    };

    const saveRoom = (room: RoomView, next: { name: string; floorId: string }) => {
        const replace = (by: RoomView) =>
            setRooms((list) => byName((list ?? []).map((each) => (each.id === room.id ? by : each))));
        void attempt(
            () => replace({ ...room, name: next.name, floorId: next.floorId, floor: floorName(next.floorId) }),
            () => replace(room),
            () =>
                actions.saveRoomAction(
                    room.id,
                    normalizeRoomInput({ name: next.name, floor: floorName(next.floorId), floorId: next.floorId })
                ),
            (result: { room?: RoomView }) => {
                const saved = result.room;
                if (saved) setRooms((list) => (list ?? []).map((each) => (each.id === saved.id ? saved : each)));
            }
        );
    };

    const addFloor = () => {
        const name = newFloor.trim();
        if (!name || floorIssue) return;
        const temp: FloorView = { id: `${TEMP_PREFIX}${Date.now()}`, placeId, name };
        setNewFloor("");
        void attempt(
            () => setFloors((list) => byName([...(list ?? []), temp])),
            () => {
                setFloors((list) => (list ?? []).filter((each) => each.id !== temp.id));
                setNewFloor(name);
            },
            () => actions.saveFloorAction(null, { placeId, name }),
            (result: { floor?: FloorView }) => {
                const saved = result.floor;
                if (saved) setFloors((list) => byName((list ?? []).map((each) => (each.id === temp.id ? saved : each))));
            }
        );
    };

    const addRoom = () => {
        const name = newRoom.trim();
        if (!name || roomIssue) return;
        const temp: RoomView = {
            id: `${TEMP_PREFIX}${Date.now()}`,
            placeId,
            name,
            floor: floorName(newRoomFloor),
            floorId: newRoomFloor
        };
        setNewRoom("");
        void attempt(
            () => setRooms((list) => byName([...(list ?? []), temp])),
            () => {
                setRooms((list) => (list ?? []).filter((each) => each.id !== temp.id));
                setNewRoom(name);
            },
            () =>
                actions.saveRoomAction(
                    null,
                    normalizeRoomInput({ placeId, name, floor: temp.floor, floorId: newRoomFloor })
                ),
            (result: { room?: RoomView }) => {
                const saved = result.room;
                if (saved) setRooms((list) => byName((list ?? []).map((each) => (each.id === temp.id ? saved : each))));
            }
        );
    };

    const remove = async () => {
        if (!removing) return;
        setBusy(true);
        const target = removing;
        const onFloor = new Set(
            target.kind === "floor"
                ? (rooms ?? []).filter((room) => room.floorId === target.floor.id).map((room) => room.id)
                : []
        );
        setRemoving(null);
        await attempt(
            () => {
                if (target.kind === "floor") {
                    setFloors((list) => (list ?? []).filter((each) => each.id !== target.floor.id));
                    setRooms((list) =>
                        (list ?? []).map((room) => (onFloor.has(room.id) ? { ...room, floor: "", floorId: "" } : room))
                    );
                } else {
                    setRooms((list) => (list ?? []).filter((each) => each.id !== target.room.id));
                }
            },
            () => {
                if (target.kind === "floor") {
                    const { floor } = target;
                    setFloors((list) => byName([...(list ?? []).filter((each) => each.id !== floor.id), floor]));
                    setRooms((list) =>
                        (list ?? []).map((room) =>
                            onFloor.has(room.id) && !room.floorId
                                ? { ...room, floor: floor.name, floorId: floor.id }
                                : room
                        )
                    );
                } else {
                    const { room } = target;
                    setRooms((list) => byName([...(list ?? []).filter((each) => each.id !== room.id), room]));
                }
            },
            () =>
                target.kind === "floor"
                    ? actions.deleteFloorAction(target.floor.id)
                    : actions.deleteRoomAction(target.room.id)
        );
        setBusy(false);
    };

    const loading = rooms === null || floors === null;
    const removingName = removing ? (removing.kind === "floor" ? removing.floor.name : removing.room.name) : "";
    const removingUses = removing ? (uses[removing.kind === "floor" ? removing.floor.id : removing.room.id] ?? 0) : 0;
    const removingBody =
        removing?.kind === "floor" ? t("roomsDialog.removeFloorBody") : t("roomsDialog.removeRoomBody");

    return (
        <>
            <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{t("roomsDialog.title")}</DialogTitle>
                        <DialogDescription>{t("roomsDialog.description")}</DialogDescription>
                    </DialogHeader>

                    <div className="flex min-w-0 flex-col gap-5">
                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {placesRefusalText(t, error)}
                            </p>
                        )}

                        <section className="flex min-w-0 flex-col gap-2">
                            <h3 className="text-sm font-medium">{t("roomsDialog.floors")}</h3>
                            {loading ? (
                                <Skeleton className="h-9 w-full" />
                            ) : floors.length === 0 ? (
                                <p className="text-xs text-foreground-subtle">{t("roomsDialog.noFloors")}</p>
                            ) : (
                                <ul className="flex min-w-0 flex-col gap-2">
                                    {floors.map((floor) => (
                                        <NameRow
                                            key={floor.id}
                                            name={floor.name}
                                            schema={floorInputSchema}
                                            label={t("roomsDialog.floorName")}
                                            pending={isTemp(floor.id)}
                                            onSave={(next) => saveFloor(floor, next.name)}
                                            onRemove={() => setRemoving({ kind: "floor", floor })}
                                        />
                                    ))}
                                </ul>
                            )}
                            <div className="flex min-w-0 items-center gap-2">
                                <Input
                                    value={newFloor}
                                    maxLength={40}
                                    aria-label={t("roomsDialog.newFloor")}
                                    placeholder={t("roomsDialog.newFloorPlaceholder")}
                                    className="min-w-0 flex-1"
                                    disabled={loading}
                                    onChange={(event) => setNewFloor(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") addFloor();
                                    }}
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className={TEXT_BUTTON}
                                    aria-disabled={!newFloor.trim() || floorIssue !== null}
                                    disabled={loading || !newFloor.trim() || floorIssue !== null}
                                    onClick={addFloor}
                                >
                                    <Plus className="size-4 shrink-0" />
                                    {t("roomsDialog.addFloor")}
                                </Button>
                            </div>
                            {floorIssue && <span className="text-xs text-danger">{floorIssue}</span>}
                        </section>

                        <section className="flex min-w-0 flex-col gap-2">
                            <h3 className="text-sm font-medium">{t("roomsDialog.rooms")}</h3>
                            {loading ? (
                                <Skeleton className="h-9 w-full" />
                            ) : rooms.length === 0 ? (
                                <p className="text-xs text-foreground-subtle">{t("roomsDialog.noRooms")}</p>
                            ) : (
                                <ul className="flex min-w-0 flex-col gap-2">
                                    {rooms.map((room) => (
                                        <NameRow
                                            key={room.id}
                                            name={room.name}
                                            floorId={room.floorId ?? ""}
                                            floors={floors}
                                            schema={roomInputSchema}
                                            label={t("roomsDialog.roomName")}
                                            pending={isTemp(room.id)}
                                            onSave={(next) => saveRoom(room, next)}
                                            onRemove={() => setRemoving({ kind: "room", room })}
                                        />
                                    ))}
                                </ul>
                            )}
                            <div className={ROW_WITH_FLOOR}>
                                <Input
                                    value={newRoom}
                                    maxLength={60}
                                    aria-label={t("roomsDialog.newRoom")}
                                    placeholder={t("roomsDialog.newRoomPlaceholder")}
                                    className="min-w-0 flex-1"
                                    disabled={loading}
                                    onChange={(event) => setNewRoom(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") addRoom();
                                    }}
                                />
                                <div className="flex min-w-0 items-center gap-2">
                                    <Select
                                        value={newRoomFloor}
                                        onValueChange={setNewRoomFloor}
                                        aria-label={t("roomsDialog.newRoomFloor")}
                                        className={FLOOR_SELECT}
                                        disabled={loading}
                                        options={floorOptions(floors ?? [], t("roomsDialog.noFloor"))}
                                    />
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className={TEXT_BUTTON}
                                        aria-disabled={!newRoom.trim() || roomIssue !== null}
                                        disabled={loading || !newRoom.trim() || roomIssue !== null}
                                        onClick={addRoom}
                                    >
                                        <Plus className="size-4 shrink-0" />
                                        {t("roomsDialog.addRoom")}
                                    </Button>
                                </div>
                            </div>
                            {roomIssue && <span className="text-xs text-danger">{roomIssue}</span>}
                        </section>
                    </div>
                </DialogContent>
            </Dialog>

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => (next ? undefined : setRemoving(null))}
                name={removingName}
                kind={removing?.kind === "floor" ? t("roomsDialog.floorKind") : t("roomsDialog.roomKind")}
                requireTyping={false}
                title={removing?.kind === "floor" ? t("roomsDialog.removeFloorTitle") : t("roomsDialog.removeRoomTitle")}
                question={t.rich("roomsDialog.removeQuestion", {
                    name: removingName,
                    em: (chunks) => <span className="font-medium text-foreground">{chunks}</span>
                })}
                description={
                    removingUses > 0
                        ? `${removingBody} ${t("roomsDialog.removeUsed", { count: removingUses })}`
                        : removingBody
                }
                confirmLabel={t("roomsDialog.remove")}
                pending={busy}
                onConfirm={() => void remove()}
            />
        </>
    );
}
