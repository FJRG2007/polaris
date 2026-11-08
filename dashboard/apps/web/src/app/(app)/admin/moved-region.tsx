"use client";

/**
 * A region whose data says the screen lives elsewhere: it moves there, keeping
 * the skeleton on screen meanwhile. The page could not redirect before it
 * painted, because deciding needed the data it no longer waits for.
 */

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

export function MovedRegion({ to, children }: { to: string; children: ReactNode }) {
    const router = useRouter();
    useEffect(() => router.replace(to), [router, to]);
    return <>{children}</>;
}
