"use client";

/**
 * What Places draws inside core screens, by slot kind.
 *
 * `automation-node`: the settings of one of its nodes in the central
 * automation editor, whose props are the node and how to change its config.
 */

import type { AppHostTypes } from "@polaris/app-host";
import { HomeNodeFields, type HomeNodeFieldsProps } from "./automations/node-fields";

type AppSlot = AppHostTypes["AppSlot"];

export function PlacesSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "automation-node":
            return <HomeNodeFields {...(slot.props as HomeNodeFieldsProps)} />;
        default:
            return null;
    }
}
