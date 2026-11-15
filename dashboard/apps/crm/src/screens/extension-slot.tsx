"use client";

/**
 * What the CRM draws inside core screens, by slot kind: its steps' settings in
 * the central automation editor, and its New button on the automations list.
 */

import type { AppHostTypes } from "@polaris/app-host";
import type { AutomationsSlotProps } from "../lib/automation-filter";
import { CrmAutomationsActions } from "./automations/automations-actions";
import { CrmNodeFields, type CrmNodeFieldsProps } from "./automations/node-fields";

type AppSlot = AppHostTypes["AppSlot"];

export function CrmSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "automation-node":
            return <CrmNodeFields {...(slot.props as CrmNodeFieldsProps)} />;
        case "automations-actions":
            return <CrmAutomationsActions {...(slot.props as AutomationsSlotProps)} />;
        default:
            return null;
    }
}
