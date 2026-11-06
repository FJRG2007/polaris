"use client";

import { useRouter } from "next/navigation";
import { recoverServerAddressAction } from "./actions";
import type { FindServerResult } from "@/app/(app)/apps/deploy/terminal-panel";

/** Look for a server whose shell found nothing at its recorded address, and
 *  refresh the screen when it was moved to where it answered. */
export function useFindServer(): (hostId: string) => Promise<FindServerResult> {
    const router = useRouter();
    return async (hostId) => {
        const result = await recoverServerAddressAction(hostId);
        if (result.found) router.refresh();
        return result;
    };
}
