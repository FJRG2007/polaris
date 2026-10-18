"use client";

import { usePathname } from "next/navigation";
import { connectionsHref } from "@/lib/connections/hub-href";

/** A link to Connected accounts that comes back to the screen it was followed from. */
export function useConnectionsHref(provider?: string | null): string {
    return connectionsHref(provider, usePathname());
}
