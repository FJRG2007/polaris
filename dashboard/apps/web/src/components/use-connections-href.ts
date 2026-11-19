"use client";

import { usePathname } from "next/navigation";
import { usePolarAllowed } from "@/components/polar/polar-panel";
import { aiProvidersHref, connectionsHref } from "@/lib/connections/hub-href";

/** A link to Connected accounts that comes back to the screen it was followed from. */
export function useConnectionsHref(provider?: string | null): string {
    return connectionsHref(provider, usePathname());
}

/** Where to add an AI provider key: Polar's settings, or Connected accounts for
 *  an account Polar is not for. */
export function useAiProvidersHref(): string {
    return aiProvidersHref(usePolarAllowed(), usePathname());
}
