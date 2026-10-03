/**
 * Whether the Google Calendar API is switched on in the Cloud project of the
 * OAuth client this Polaris signs in with.
 *
 * One answer per instance, kept in the `Setting` table: the project is the
 * operator's, so every Google account here syncs or fails on it together. The
 * sync writes it from what Google answers; the admin Integrations screen reads
 * it, probes it, and writes it too. A source waiting on it is retried with a
 * growing gap, and every one is retried at once when it starts working.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { host } from "@polaris/app-host";
import type { ProviderSetup } from "./sync";

const KEY = core.GOOGLE_CALENDAR_API_STATE_KEY;

const MINUTE = 60_000;

/** The first retry of a source waiting on the API, and the longest gap. */
const FIRST_RETRY_MINUTES = 2;
const LONGEST_RETRY_MINUTES = 60;

export async function readGoogleCalendarApi(): Promise<core.ProviderApiState | null> {
    const raw = await host.settingStore.getSetting(KEY).catch(() => null);
    return core.readProviderApiState(raw);
}

/** Record that Google said the API is off, and answer the new state. */
export async function recordGoogleCalendarApiOff(
    setup: ProviderSetup,
    now: Date
): Promise<core.ProviderApiState> {
    const previous = await readGoogleCalendarApi();
    const next = core.nextProviderApiState(
        previous,
        { state: "disabled", project: setup.project, activationUrl: setup.activationUrl },
        now
    );
    await host.settingStore.setSetting(KEY, JSON.stringify(next));
    return next;
}

/**
 * Record that a Google call went through. When the API had been off, every
 * source still waiting on it is made due now instead of at its next gap.
 */
export async function recordGoogleCalendarApiOn(now: Date): Promise<void> {
    const previous = await readGoogleCalendarApi();
    if (previous?.state === "enabled") return;
    await host.settingStore.setSetting(
        KEY,
        JSON.stringify(core.nextProviderApiState(previous, { state: "enabled" }, now))
    );
    if (previous) await retryWaitingSources(now);
}

/** Make every Google source waiting on the API due now. */
export async function retryWaitingSources(now: Date): Promise<number> {
    const moved = await prisma.calendarSource.updateMany({
        where: { kind: "google", status: "setup", nextSyncAt: { gt: now } },
        data: { nextSyncAt: now }
    });
    return moved.count;
}

/**
 * When a source waiting on the API is tried again: soon at first, then less
 * often the longer it stays off - half the time it has been off, between two
 * minutes and an hour. Needs no counter of its own: `since` is the clock.
 */
export function nextSetupRetry(state: core.ProviderApiState, now: Date): Date {
    const off = Math.max(0, now.getTime() - Date.parse(state.since));
    const minutes = Math.min(
        LONGEST_RETRY_MINUTES,
        Math.max(FIRST_RETRY_MINUTES, Math.round(off / MINUTE / 2))
    );
    return new Date(now.getTime() + minutes * MINUTE);
}
