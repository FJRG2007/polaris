/**
 * The copy of a place's automation list a tab keeps for painting from, and the
 * one call that forgets it after anything changes an automation.
 */

import { hostUi } from "@polaris/app-host/client";

const { dropSnapshots } = hostUi.snapshotCache;

const PREFIX = "places.automations.";

export function automationsCacheKey(placeId: string): string {
    return `${PREFIX}${placeId}`;
}

/** Forget every cached list, after anything that changes one. */
export function dropAutomationsCache(): void {
    dropSnapshots(PREFIX);
}
