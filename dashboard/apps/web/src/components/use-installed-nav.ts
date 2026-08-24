"use client";

/**
 * What the rail is allowed to show for one installed app.
 *
 * The same shape as `useOrgNav`, for the same reason: the shell draws the rail
 * from the path, and the path carries an id and no name. It asks once per app and
 * keeps the answer for the tab, so moving between a server's own screens never
 * blinks the rail.
 *
 * Null until the answer arrives, which leaves the Apps rail drawn - a rail that
 * flashed a server's screens in and back out again would be worse than one that
 * arrives a moment late.
 */

import { useEffect, useState } from "react";
import type { InstalledAppNav } from "@/lib/apps";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

/** An installed app is renamed rarely and its screens change with a deploy, so an
 *  answer stands for the tab's session. */
const MAX_AGE_MS = 30 * 60_000;

const key = (id: string) => `installed.nav:${id}`;

export function useInstalledNav(id: string | null): InstalledAppNav | null {
    const [nav, setNav] = useState<InstalledAppNav | null>(() =>
        id ? (readSnapshot<InstalledAppNav>(key(id), MAX_AGE_MS)?.value ?? null) : null
    );

    useEffect(() => {
        if (!id) {
            setNav(null);
            return;
        }
        setNav(readSnapshot<InstalledAppNav>(key(id), MAX_AGE_MS)?.value ?? null);

        const controller = new AbortController();
        void fetch(`/api/apps/installed/${encodeURIComponent(id)}/nav`, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) return;
                const body = (await response.json()) as Partial<InstalledAppNav>;
                const labels =
                    typeof body.labels === "object" && body.labels !== null
                        ? Object.fromEntries(
                              Object.entries(body.labels).filter(([, label]) => typeof label === "string")
                          )
                        : {};
                const value: InstalledAppNav = {
                    name: typeof body.name === "string" && body.name ? body.name : "Server",
                    tabs: Array.isArray(body.tabs) ? body.tabs.filter((tab) => typeof tab === "string") : [],
                    labels
                };
                setNav(value);
                writeSnapshot(key(id), value);
            })
            .catch(() => {
                // Offline, or an app that is no longer this account's. The app's own
                // rail is still drawn and every screen still answers for itself.
            });
        return () => controller.abort();
    }, [id]);

    return nav;
}
