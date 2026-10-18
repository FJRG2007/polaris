"use client";

/**
 * What Cloud servers draws inside core screens, by slot kind.
 *
 * `connections`: its section of a connections hub, a person's own or an
 * organization's, whose props are `CloudConnectionsProps`.
 */

import type { AppHostTypes } from "@polaris/app-host";
import { CloudConnectionsSection } from "./connections-section";
import type { CloudConnectionsProps } from "../lib/connections-slot";

type AppSlot = AppHostTypes["AppSlot"];

export function CloudServersSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "connections":
            return <CloudConnectionsSection {...(slot.props as CloudConnectionsProps)} />;
        default:
            return null;
    }
}
