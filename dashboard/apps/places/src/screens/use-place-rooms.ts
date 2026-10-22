"use client";

/**
 * The rooms of one place, read again when another place is picked. Null while
 * they are being read; an empty list for no place, or when they could not be
 * read - a room picker that offers "none" is still a working form.
 *
 * Shared by every dialog that puts something in a room (doors and devices,
 * cameras), so they all offer the same rooms the same way.
 */

import * as actions from "./actions";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RoomView } from "../lib/room-kinds";

export function usePlaceRooms(
    placeId: string
): [RoomView[] | null, Dispatch<SetStateAction<RoomView[] | null>>] {
    const [rooms, setRooms] = useState<RoomView[] | null>(null);
    useEffect(() => {
        if (!placeId) {
            setRooms([]);
            return;
        }
        let current = true;
        setRooms(null);
        void actions.listRoomsAction(placeId).then(
            (result) => {
                if (current) setRooms(result.rooms ?? []);
            },
            () => {
                if (current) setRooms([]);
            }
        );
        return () => {
            current = false;
        };
    }, [placeId]);
    return [rooms, setRooms];
}
