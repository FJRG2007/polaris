/**
 * Everything at a place on one list: the devices of the connected accounts, and
 * the hardware Polaris knows another way - its cameras, and the UPSes and NASes
 * placed there. Each keeps its own screen; this only decides what is listed,
 * under which heading, and what a filter or a search leaves.
 *
 * Pure and client-safe, so the merge, the filters and the grouping are asserted
 * in a test without a database.
 */

import * as kinds from "./device-kinds";
import type { PlacesTranslator } from "./i18n";
import type { DeviceView } from "./device-kinds";
import type { AccountNetwork } from "./network-details";

/** The hardware that is not a connected account's device. */
export const HARDWARE_KINDS = ["camera", "ups", "nas"] as const;
export type HardwareKind = (typeof HARDWARE_KINDS)[number];

/** A camera, UPS or NAS at the place, as the list draws it. */
export interface HardwareView {
    readonly id: string;
    readonly kind: HardwareKind;
    readonly name: string;
    readonly model: string | null;
    readonly roomId: string | null;
    /** Its own page, for a UPS or a NAS; a camera opens its dialog instead. */
    readonly href: string | null;
    /** Whether this reader may move it to another room, by the same check the
     *  server makes when they do. */
    readonly canArrange: boolean;
}

export type ListEntry =
    | { readonly type: "device"; readonly key: string; readonly device: DeviceView }
    | { readonly type: "hardware"; readonly key: string; readonly hardware: HardwareView };

/** Devices first, in the order they came, then the hardware. Keys are unique
 *  across kinds, since a camera and a device can share nothing but an id. */
export function listEntries(
    devices: readonly DeviceView[],
    hardware: readonly HardwareView[]
): ListEntry[] {
    return [
        ...devices.map((device) => ({ type: "device" as const, key: `device:${device.id}`, device })),
        ...hardware.map((item) => ({
            type: "hardware" as const,
            key: `${item.kind}:${item.id}`,
            hardware: item
        }))
    ];
}

export function entryName(entry: ListEntry): string {
    return entry.type === "device" ? entry.device.name : entry.hardware.name;
}

export function entryRoom(entry: ListEntry): string | null {
    return (entry.type === "device" ? entry.device.roomId : entry.hardware.roomId) ?? null;
}

/** The heading it is listed under, which is also what the type filter offers. */
export function entryGroup(entry: ListEntry, t: PlacesTranslator): string {
    return entry.type === "device"
        ? kinds.groupText(entry.device.kind, t)
        : t(`devicesView.kinds.${entry.hardware.kind}`);
}

/** Every heading, in the order the list shows them: the device kinds in their
 *  own order - doors first - and then the cameras, UPSes and NASes. */
export function groupOrder(t: PlacesTranslator): string[] {
    const order = [
        ...kinds.DEVICE_KINDS.map((kind) => kinds.groupText(kind, t)),
        ...HARDWARE_KINDS.map((kind) => t(`devicesView.kinds.${kind}`))
    ];
    return [...new Set(order)];
}

export interface ListFilter {
    /** The headings kept; empty keeps every one. */
    readonly groups: ReadonlySet<string>;
    readonly query: string;
}

function folded(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** What a type filter and a search leave. The search reads the name, the model,
 *  the zone and the room's name, without case or accents. */
export function filterEntries(
    entries: readonly ListEntry[],
    filter: ListFilter,
    t: PlacesTranslator,
    roomName: (roomId: string) => string | undefined = () => undefined
): ListEntry[] {
    const words = folded(filter.query.trim()).split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
        if (filter.groups.size > 0 && !filter.groups.has(entryGroup(entry, t))) return false;
        if (words.length === 0) return true;
        const room = entryRoom(entry);
        const text = folded(
            [
                entryName(entry),
                entry.type === "device" ? entry.device.model : entry.hardware.model,
                entry.type === "device" ? entry.device.zone : "",
                room ? (roomName(room) ?? "") : ""
            ].join(" ")
        );
        return words.every((word) => text.includes(word));
    });
}

/** The entries under their headings, in `groupOrder`, empty headings left out. */
export function groupEntries(
    entries: readonly ListEntry[],
    t: PlacesTranslator
): { label: string; entries: ListEntry[] }[] {
    const groups = new Map(groupOrder(t).map((label) => [label, [] as ListEntry[]]));
    for (const entry of entries) {
        const label = entryGroup(entry, t);
        const group = groups.get(label);
        if (group) group.push(entry);
        else groups.set(label, [entry]);
    }
    return [...groups].flatMap(([label, list]) => (list.length > 0 ? [{ label, entries: list }] : []));
}

/** The headings present, for the type filter: offering one that would leave
 *  nothing is offering a dead end. */
export function presentGroups(entries: readonly ListEntry[], t: PlacesTranslator): string[] {
    return groupEntries(entries, t).map((group) => group.label);
}

/**
 * Where a device is on the network: the addresses of the account that reaches
 * it. `shared` says the account reaches other devices too, so the address is
 * that account's - a hub or a bridge - rather than this device's own.
 */
export function networksFor(
    device: Pick<DeviceView, "id" | "accountId">,
    networks: readonly AccountNetwork[],
    devices: readonly Pick<DeviceView, "id" | "accountId">[]
): { networks: AccountNetwork[]; shared: boolean } {
    if (!device.accountId) return { networks: [], shared: false };
    const mine = networks.filter((network) => network.accountId === device.accountId);
    const shared =
        mine.length > 0 &&
        devices.some((other) => other.id !== device.id && other.accountId === device.accountId);
    return { networks: mine, shared };
}

/** The automation editor, opened on a new automation about this entry. Null for
 *  what an automation cannot reach - a UPS or a NAS has no trigger or step. */
export function automationHref(entry: ListEntry, placeId: string): string | null {
    const place = `place=${encodeURIComponent(placeId)}`;
    if (entry.type === "device") {
        return `/places/devices/automations/new?device=${encodeURIComponent(entry.device.id)}&${place}`;
    }
    if (entry.hardware.kind === "camera") {
        return `/places/devices/automations/new?camera=${encodeURIComponent(entry.hardware.id)}&${place}`;
    }
    return null;
}
