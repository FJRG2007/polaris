"use client";

/**
 * What Calendar draws inside core screens, by slot kind.
 *
 * The server half (`lib/calendar-extension.ts`) names the slot; this draws it.
 */

import type { AppHostTypes } from "@polaris/app-host";
import { TimeIndicator } from "./clock/time-indicator";

type AppSlot = AppHostTypes["AppSlot"];

export function CalendarSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "header-time":
            return <TimeIndicator />;
        default:
            return null;
    }
}
