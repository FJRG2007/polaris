/**
 * A wall panel's devices as one long list: searched, grouped by floor and
 * room, and cut to the rows on screen so a floor of five hundred devices
 * scrolls as smoothly as one of five.
 *
 * Every row is the same height, so which rows are on screen is arithmetic on
 * the scroll position - no measuring, and nothing to keep in step with the
 * rows drawn.
 *
 * Pure and client-safe.
 */

/** What a row needs of a device. */
export interface ListDevice {
    readonly id: string;
    readonly name: string;
    readonly roomId?: string | null;
}

export interface ListRoom {
    readonly id: string;
    readonly name: string;
    readonly floor: string | null;
}

export type ListRow<T extends ListDevice> =
    | {
          readonly kind: "group";
          readonly key: string;
          readonly room: string | null;
          readonly floor: string | null;
          readonly count: number;
      }
    | { readonly kind: "device"; readonly key: string; readonly device: T };

/** Text as a search compares it: no accents, no case, single spaces. */
export function foldText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The rows of the list: a heading per room (by floor, then room, a device in
 * none last) and its devices by name, kept to those whose name, room or floor
 * holds every word of the search.
 */
export function listRows<T extends ListDevice>(
    devices: readonly T[],
    rooms: readonly ListRoom[],
    query: string
): ListRow<T>[] {
    const byId = new Map(rooms.map((room) => [room.id, room]));
    const words = foldText(query).split(" ").filter(Boolean);
    const groups = new Map<string, { room: ListRoom | null; devices: T[] }>();
    for (const device of devices) {
        const room = (device.roomId && byId.get(device.roomId)) || null;
        if (words.length) {
            const text = foldText(`${device.name} ${room?.name ?? ""} ${room?.floor ?? ""}`);
            if (!words.every((word) => text.includes(word))) continue;
        }
        const key = room?.id ?? "";
        const group = groups.get(key) ?? { room, devices: [] };
        group.devices.push(device);
        groups.set(key, group);
    }
    const order = [...groups.values()].sort((a, b) => {
        if (!a.room || !b.room) return a.room ? -1 : b.room ? 1 : 0;
        return (
            (a.room.floor ?? "").localeCompare(b.room.floor ?? "") ||
            a.room.name.localeCompare(b.room.name)
        );
    });
    const rows: ListRow<T>[] = [];
    for (const group of order) {
        rows.push({
            kind: "group",
            key: `group:${group.room?.id ?? ""}`,
            room: group.room?.name ?? null,
            floor: group.room?.floor ?? null,
            count: group.devices.length
        });
        for (const device of [...group.devices].sort((a, b) => a.name.localeCompare(b.name)))
            rows.push({ kind: "device", key: device.id, device });
    }
    return rows;
}

/** The rows to draw for a scroll position, with a few beyond each edge so a
 *  fling does not show a blank strip before they arrive. */
export function visibleRange(
    scrollTop: number,
    viewport: number,
    rowHeight: number,
    total: number,
    overscan = 6
): { start: number; end: number } {
    if (total === 0 || rowHeight <= 0) return { start: 0, end: 0 };
    const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const shown = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
    return {
        start: Math.max(0, first - overscan),
        end: Math.min(total, first + shown + overscan)
    };
}
