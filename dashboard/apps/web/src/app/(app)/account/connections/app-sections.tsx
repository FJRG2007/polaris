/**
 * What the installed apps add to a connections hub, for both hubs: a person's
 * own and an organization's. Built on the server from the same viewer the apps
 * check their actions against, so a section never offers what its action
 * would refuse.
 */

import type { ReactNode } from "react";
import { strictSafeRedirect } from "@/lib/safe-redirect";
import { RETURN_PARAM } from "@/lib/connections/hub-href";
import { connectionsSlots } from "@/lib/app-extensions/registry";
import { AppSlotView } from "@/components/app-extensions/installed-client";
import type { ConnectionsScope } from "@/lib/app-extensions/types";

export interface HubAppSections {
    readonly node: ReactNode;
    readonly ids: readonly string[];
}

/** The page's own query string, keeping only what the hub reads. */
export function hubSearch(params: Record<string, string | string[] | undefined>): string {
    const initial = new URLSearchParams();
    for (const key of ["provider", RETURN_PARAM]) {
        const value = params[key];
        if (typeof value === "string") initial.set(key, value);
    }
    return initial.toString();
}

export async function hubAppSections(
    userId: string,
    scope: ConnectionsScope,
    search: string
): Promise<HubAppSections> {
    const returnTo = strictSafeRedirect(new URLSearchParams(search).get(RETURN_PARAM));
    const slots = await connectionsSlots({ userId, scope, returnTo });
    return {
        ids: slots.map((slot) => slot.app),
        node:
            slots.length > 0
                ? slots.map((slot) => <AppSlotView key={slot.app} slot={slot} />)
                : null
    };
}
