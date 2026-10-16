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
import { useState, type ReactNode } from "react";
import * as kinds from "../../lib/device-kinds";
import * as auto from "../../lib/automation-kinds";
import type { PlacesKey } from "../../../messages";
import type { DeviceView } from "../../lib/device-kinds";
import {
    AddBlockDialog,
    type AddGroup,
    type AddStrings,
    type AddTargets
} from "@polaris/ui/automation-add";
import {
    Bell,
    Clock,
    Gauge,
    Hand,
    Hourglass,
    Plus,
    Power,
    Repeat,
    Timer,
    Workflow
} from "lucide-react";

export type AddRole = "trigger" | "condition" | "step";

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
    const [open, setOpen] = useState(false);
    const vocabulary = VOCABULARY[role];
    const blockItem = (kind: string) => ({
        value: kind,
        label: t(`automations.${LABELS[role]}.${kind}` as PlacesKey),
        description: t(`automations.add.about.${role}.${kind}` as PlacesKey),
        icon: vocabulary[kind]?.icon
    });
    const groups: AddGroup[] = (["devices", "time", "other"] as const)
        .map((id) => ({
            id,
            label: t(`automations.add.groups.${id}`),
            icon: GROUP_ICONS[id],
            items: KINDS[role].filter((kind) => vocabulary[kind]?.group === id).map(blockItem)
        }))
        .filter((group) => group.items.length > 0);
    const fits = (device: DeviceView) =>
        KINDS[role].filter((kind) => FITS[role][kind]?.(device, canControl));
    const reachable = devices.filter((device) => fits(device).length > 0);
    const kindGroups = [...new Set(reachable.map((device) => kinds.groupText(device.kind, t)))];
    const targets: AddTargets | undefined =
        reachable.length > 0
            ? {
                  groups: kindGroups.map((heading) => ({
                      id: heading,
                      label: heading,
                      items: reachable
                          .filter((device) => kinds.groupText(device.kind, t) === heading)
                          .map((device) => ({
                              value: device.id,
                              label: device.name,
                              description: device.zone || kinds.kindText(device.kind, t)
                          }))
                  })),
                  itemsFor: (id) => {
                      const device = reachable.find((each) => each.id === id);
                      return device ? fits(device).map(blockItem) : [];
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
                onPick={(kind, target) =>
                    onPick(
                        kind,
                        target ? reachable.find((device) => device.id === target) : undefined
                    )
                }
                onClose={() => setOpen(false)}
            />
        </>
    );
}
