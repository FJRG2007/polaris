"use client";

/**
 * What Places draws inside core screens, by slot kind.
 *
 * `automation-node`: the settings of one of its nodes in the central
 * automation editor, whose props are the node and how to change its config.
 * `automations-actions` / `automations-after`: the central automations list
 * narrowed to Places' - its New menu, and what has not moved there yet.
 */

import type { AppHostTypes } from "@polaris/app-host";
import { HomeNodeFields, type HomeNodeFieldsProps } from "./automations/node-fields";
import { NewAutomationMenu, UnmovedAutomations } from "./automations/automations-view";
import type { AutomationsSlotProps } from "../lib/automation-filter";

type AppSlot = AppHostTypes["AppSlot"];

export function PlacesSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "automation-node":
            return <HomeNodeFields {...(slot.props as HomeNodeFieldsProps)} />;
        case "automations-actions":
            return <NewAutomationMenu placeId={(slot.props as AutomationsSlotProps).placeId} />;
        case "automations-after":
            return <UnmovedAutomations {...(slot.props as AutomationsSlotProps)} />;
        default:
            return null;
    }
}
