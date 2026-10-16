"use client";

/**
 * The "add" button under each stage of a Places automation, and the dialog it
 * opens: the kinds of trigger, condition or step in their groups, each with what
 * it does in a line, a search across them, and the copied block first when there
 * is one that fits here.
 */

import { Button } from "@polaris/ui";
import * as fields from "./flow-fields";
import { usePlacesT } from "../use-places-t";
import { createContext, useContext, useState, type ReactNode } from "react";
import { roomsByFloor, type RoomView } from "../../lib/room-kinds";
import * as kinds from "../../lib/device-kinds";
import * as auto from "../../lib/automation-kinds";
import * as purposes from "../../lib/automation-purposes";
import type { PlacesKey } from "../../../messages";
import type { DeviceView } from "../../lib/device-kinds";
import {
    AddBlockDialog,
    type AddGroup,
    type AddStrings,
    type AddTargets
} from "@polaris/ui/automation-add";
import {
    BatteryLow,
    Bell,
    Clock,
    DoorClosed,
    DoorOpen,
    Filter,
    Footprints,
    Lock,
    LockOpen,
    Gauge,
    Hand,
    Hourglass,
    Plus,
    Power,
    Repeat,
    Timer,
    Unplug,
    Workflow
} from "lucide-react";

export type AddRole = "trigger" | "condition" | "step";

/** The place's rooms, which "By target" groups devices by. The editor provides
 *  them once rather than through every list a block can be added to. */
const RoomsContext = createContext<readonly RoomView[]>([]);
export const RoomsProvider = RoomsContext.Provider;

/**
 * "By target" groups: a room's devices under the room, floor by floor, then
 * the devices in no room by what they are. With no rooms, it is only the
 * second.
 */
export function targetGroups<T extends { id: string; kind: string; roomId?: string | null }>(
    devices: readonly T[],
    rooms: readonly RoomView[],
    kindHeading: (device: T) => string,
    roomHeading: (room: RoomView) => string
): { id: string; label: string; devices: T[] }[] {
    const known = new Set(rooms.map((room) => room.id));
    const inRoom = (device: T) => Boolean(device.roomId && known.has(device.roomId));
    const byRoom = roomsByFloor(rooms)
        .flatMap((floor) => floor.rooms)
        .map((room) => ({
            id: `room:${room.id}`,
            label: roomHeading(room),
            devices: devices.filter((device) => device.roomId === room.id)
        }))
        .filter((group) => group.devices.length > 0);
    const rest = devices.filter((device) => !inRoom(device));
    const headings = [...new Set(rest.map(kindHeading))];
    return [
        ...byRoom,
        ...headings.map((heading) => ({
            id: heading,
            label: heading,
            devices: rest.filter((device) => kindHeading(device) === heading)
        }))
    ];
}

type GroupId = "devices" | "time" | "other";

/** Which group each kind is listed under, and the icon it is drawn with. */
const VOCABULARY: Record<AddRole, Record<string, { group: GroupId; icon: ReactNode }>> = {
    trigger: {
        change: { group: "devices", icon: <Power /> },
        stays: { group: "devices", icon: <Hourglass /> },
        threshold: { group: "devices", icon: <Gauge /> },
        time: { group: "time", icon: <Clock /> },
        interval: { group: "time", icon: <Repeat /> },
        manual: { group: "other", icon: <Hand /> }
    },
    condition: {
        device: { group: "devices", icon: <Power /> },
        reading: { group: "devices", icon: <Gauge /> },
        time: { group: "time", icon: <Clock /> },
        weekday: { group: "time", icon: <Clock /> }
    },
    step: {
        device: { group: "devices", icon: <Power /> },
        wait: { group: "devices", icon: <Hourglass /> },
        delay: { group: "time", icon: <Timer /> },
        notify: { group: "other", icon: <Bell /> },
        run: { group: "other", icon: <Workflow /> }
    }
};

const PURPOSE_ICONS: Record<purposes.TriggerPurpose | purposes.ConditionPurpose, ReactNode> = {
    opened: <DoorOpen />,
    closed: <DoorClosed />,
    locked: <Lock />,
    unlocked: <LockOpen />,
    motion: <Footprints />,
    still: <Footprints />,
    batteryLow: <BatteryLow />,
    unavailable: <Unplug />,
    open: <DoorOpen />,
    shut: <DoorClosed />,
    isLocked: <Lock />,
    isUnlocked: <LockOpen />,
    moving: <Footprints />,
    quiet: <Footprints />,
    batteryIsLow: <BatteryLow />,
    isUnavailable: <Unplug />
};

/**
 * The icon a stored block's row is drawn with: what it is for where it reads as
 * one of the purposes (a door, a lock, a battery), else its kind's - the same
 * icon the add dialog showed it with. A group is drawn as its first condition.
 */
export function blockIcon(
    role: "trigger" | "group" | "step",
    block: auto.Trigger | auto.ConditionGroup | auto.Step
): ReactNode {
    if (role === "trigger") {
        const trigger = block as auto.Trigger;
        const purpose = purposes.triggerPurposeOf(trigger);
        return purpose ? PURPOSE_ICONS[purpose] : VOCABULARY.trigger[trigger.kind]?.icon;
    }
    if (role === "group") {
        const first = (block as auto.ConditionGroup).items[0];
        return first ? conditionIcon(first) : <Filter />;
    }
    return VOCABULARY.step[(block as auto.Step).kind]?.icon;
}

/** One condition's icon, by the same rule as a block's. */
export function conditionIcon(condition: auto.Condition): ReactNode {
    const purpose = purposes.conditionPurposeOf(condition);
    return purpose ? PURPOSE_ICONS[purpose] : VOCABULARY.condition[condition.kind]?.icon;
}

const GROUP_ICONS: Record<GroupId, ReactNode> = {
    devices: <Power />,
    time: <Clock />,
    other: <Workflow />
};

const KINDS: Record<AddRole, readonly string[]> = {
    trigger: auto.TRIGGER_KINDS,
    condition: auto.CONDITION_KINDS,
    step: auto.STEP_KINDS
};

/** Whether a kind of block can point at `device`; kinds that point at none are absent. */
const FITS: Record<
    AddRole,
    Record<string, (device: DeviceView, canControl: boolean) => boolean>
> = {
    trigger: {
        change: fields.watchable,
        stays: fields.watchable,
        threshold: (device) => auto.measures(device.kind)
    },
    condition: {
        device: fields.watchable,
        reading: (device) => auto.measures(device.kind)
    },
    step: {
        device: (device, canControl) => canControl && fields.operable(device),
        wait: fields.watchable
    }
};

/** The blocks named for what they are for, each with the test that a device
 *  can answer it and its icon. Steps have none. */
const PURPOSES: Record<
    AddRole,
    readonly { id: string; fits: (device: DeviceView) => boolean; icon: ReactNode }[]
> = {
    trigger: purposes.TRIGGER_PURPOSES.map((id) => ({
        id,
        fits: (device: DeviceView) => purposes.triggerFits(id, device),
        icon: PURPOSE_ICONS[id]
    })),
    condition: purposes.CONDITION_PURPOSES.map((id) => ({
        id,
        fits: (device: DeviceView) => purposes.conditionFits(id, device),
        icon: PURPOSE_ICONS[id]
    })),
    step: []
};

/** The catalog list each role's kind names are under. */
const LABELS: Record<AddRole, string> = {
    trigger: "triggers",
    condition: "conditions",
    step: "steps"
};

export function AddBlockButton({
    role,
    label,
    devices = [],
    canControl = false,
    onPick,
    onPaste
}: {
    role: AddRole;
    label: string;
    /** The place's devices, for "By target"; without any the tab is not shown. */
    devices?: readonly DeviceView[];
    canControl?: boolean;
    /** `target` is the device chosen on "By target", when the block was picked there. */
    onPick: (kind: string, target?: DeviceView) => void;
    /** Present when the clipboard holds a block that belongs here. */
    onPaste?: () => void;
}) {
    const t = usePlacesT();
    const rooms = useContext(RoomsContext);
    const [open, setOpen] = useState(false);
    const vocabulary = VOCABULARY[role];
    const blockItem = (kind: string) => ({
        value: kind,
        label: t(`automations.${LABELS[role]}.${kind}` as PlacesKey),
        description: t(`automations.add.about.${role}.${kind}` as PlacesKey),
        icon: vocabulary[kind]?.icon
    });
    const purposeItem = (entry: (typeof PURPOSES)[AddRole][number]) => ({
        value: `${purposes.PURPOSE_PREFIX}${entry.id}`,
        label: t(`automations.purposes.${role}.${entry.id}` as PlacesKey),
        description: t(`automations.purposes.about.${role}.${entry.id}` as PlacesKey),
        icon: entry.icon
    });
    // A purpose is offered only where some device here can answer it, and one
    // picked by its type goes to the first that can.
    const offered = PURPOSES[role].filter((entry) => devices.some(entry.fits));
    const groups: AddGroup[] = (["devices", "time", "other"] as const)
        .map((id) => ({
            id,
            label: t(`automations.add.groups.${id}`),
            icon: GROUP_ICONS[id],
            items: [
                ...(id === "devices" ? offered.map(purposeItem) : []),
                ...KINDS[role].filter((kind) => vocabulary[kind]?.group === id).map(blockItem)
            ]
        }))
        .filter((group) => group.items.length > 0);
    const fits = (device: DeviceView) =>
        KINDS[role].filter((kind) => FITS[role][kind]?.(device, canControl));
    const purposesFor = (device: DeviceView) =>
        PURPOSES[role].filter((entry) => entry.fits(device));
    const reachable = devices.filter(
        (device) => fits(device).length > 0 || purposesFor(device).length > 0
    );
    const grouped = targetGroups(
        reachable,
        rooms,
        (device) => kinds.groupText(device.kind, t),
        (room) =>
            room.floor
                ? t("automations.add.roomOnFloor", { room: room.name, floor: room.floor })
                : room.name
    );
    const targets: AddTargets | undefined =
        reachable.length > 0
            ? {
                  groups: grouped.map((group) => ({
                      id: group.id,
                      label: group.label,
                      items: group.devices.map((device) => ({
                          value: device.id,
                          label: device.name,
                          description: device.zone || kinds.kindText(device.kind, t)
                      }))
                  })),
                  itemsFor: (id) => {
                      const device = reachable.find((each) => each.id === id);
                      return device
                          ? [
                                ...purposesFor(device).map(purposeItem),
                                ...fits(device).map(blockItem)
                            ]
                          : [];
                  }
              }
            : undefined;
    const strings: AddStrings = {
        search: t("automations.add.search"),
        byTarget: t("automations.add.byTarget"),
        byType: t("automations.add.byType"),
        blocks: t("automations.add.blocks"),
        back: t("automations.add.back"),
        close: t("automations.add.close"),
        noMatch: (term) => t("automations.add.noMatch", { term }),
        nothingForTarget: t("automations.add.nothingForTarget"),
        more: (count) => t("automations.add.more", { count })
    };
    return (
        <>
            <Button
                size="sm"
                variant="outline"
                className="self-start border-dashed"
                onClick={() => setOpen(true)}
            >
                <Plus className="size-4 shrink-0" />
                {label}
            </Button>
            <AddBlockDialog
                open={open}
                title={t(`automations.add.title.${role}`)}
                strings={strings}
                groups={groups}
                targets={targets}
                paste={
                    onPaste
                        ? {
                              label: t(`automations.add.paste.${role}`),
                              description: t("automations.add.pasteAbout"),
                              onPaste
                          }
                        : undefined
                }
                onPick={(kind, target) => {
                    const chosen = target
                        ? reachable.find((device) => device.id === target)
                        : undefined;
                    const purpose = kind.startsWith(purposes.PURPOSE_PREFIX)
                        ? PURPOSES[role].find(
                              (entry) => entry.id === kind.slice(purposes.PURPOSE_PREFIX.length)
                          )
                        : undefined;
                    onPick(kind, chosen ?? (purpose ? devices.find(purpose.fits) : undefined));
                }}
                onClose={() => setOpen(false)}
            />
        </>
    );
}
