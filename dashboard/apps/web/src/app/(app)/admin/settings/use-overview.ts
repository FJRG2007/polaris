"use client";

/**
 * The parts of the settings overview a screen draws, asked for once it has
 * painted and asked again until they answer.
 *
 * The screen is most often opened right after an update, while the new
 * dashboard is still coming up, and an answer that never comes back must not
 * leave it blank until somebody thinks to reload. A failure leaves the
 * skeletons standing rather than replacing them with a wrong answer.
 */

import { useEffect, useState } from "react";
import type { UpdateStatus } from "@/lib/update-service";
import { noteUpdateStatus } from "@/lib/update-status-shared";
import type { CheckedAddress } from "@/lib/address-health";
import type { OverviewPart, SettingsOverview } from "./overview";

/** How long one overview request may take before it is asked again, and how the
 *  retries space out while the dashboard is not answering. The server's slowest
 *  path (GitHub, the registry, the IP echo) is bounded well inside the timeout. */
const OVERVIEW_TIMEOUT_MS = 30_000;
const OVERVIEW_RETRY_FIRST_MS = 2_000;
const OVERVIEW_RETRY_MAX_MS = 30_000;

/** An overview from a build before `network` was one part - the dashboard
 *  still answering in the middle of an update - read the same way. */
function withNetwork(
    overview: SettingsOverview & { publicIp?: string | null; serverIp?: string | null }
): SettingsOverview {
    if (overview.network !== undefined || !("publicIp" in overview)) return overview;
    return {
        ...overview,
        network: { publicIp: overview.publicIp ?? null, serverIp: overview.serverIp ?? null }
    };
}

export function useSettingsOverview(parts: readonly OverviewPart[]) {
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    // Followed rather than read once: removing an address changes the list, and the
    // page that did it must not keep offering the entry it has just taken away.
    const [addresses, setAddresses] = useState<CheckedAddress[] | null>(null);
    const [network, setNetwork] = useState<SettingsOverview["network"]>(null);
    const key = parts.join(",");

    useEffect(() => {
        const wanted = key.split(",") as OverviewPart[];
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let delay = OVERVIEW_RETRY_FIRST_MS;
        const load = async (): Promise<void> => {
            // One attempt's own abort: the page leaving, or the attempt running long.
            const attempt = new AbortController();
            const leave = () => attempt.abort();
            controller.signal.addEventListener("abort", leave);
            const slow = setTimeout(leave, OVERVIEW_TIMEOUT_MS);
            try {
                const answer = await fetch(
                    `/api/admin/settings/overview?parts=${encodeURIComponent(key)}`,
                    { cache: "no-store", signal: attempt.signal }
                );
                if (answer.ok) {
                    const overview = withNetwork((await answer.json()) as SettingsOverview);
                    // A check that answered first is newer than this one.
                    if (overview.status) {
                        noteUpdateStatus(overview.status);
                        setStatus((current) => current ?? overview.status);
                    }
                    if (overview.addresses) setAddresses(overview.addresses);
                    if (overview.network) setNetwork(overview.network);
                    // A part that did not answer in time keeps its placeholder
                    // and is asked for again; the rest stays as it landed.
                    if (wanted.every((part) => overview[part])) return;
                } else if (answer.status === 401 || answer.status === 403) {
                    // Signed out or no longer an admin: asking again changes nothing.
                    return;
                }
                // Anything else - the edge's own 404 or 502 while the new
                // dashboard starts after an update, a page that is not JSON -
                // is asked again, never left on placeholders.
            } catch {
                if (controller.signal.aborted) return;
            } finally {
                clearTimeout(slow);
                controller.signal.removeEventListener("abort", leave);
            }
            timer = setTimeout(() => void load(), delay);
            delay = Math.min(delay * 2, OVERVIEW_RETRY_MAX_MS);
        };
        void load();
        return () => {
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [key]);

    return { status, setStatus, addresses, setAddresses, network };
}
