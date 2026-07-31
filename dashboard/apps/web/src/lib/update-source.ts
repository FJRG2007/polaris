/**
 * Where this deployment's updates come from: the image GitHub published, or a
 * build made on the host from the checkout.
 *
 * Kept apart from the schedule because it answers a different question - the
 * schedule is when an update installs, this is what installing one means - and
 * because two very different things read it. The dashboard reads it to decide
 * what counts as an update at all (a published image, or simply a newer commit),
 * and the host's updater reads it to decide what to do. The updater cannot reach
 * the database, so the choice is mirrored onto the volume both containers share
 * whenever it changes and again before every run.
 */

import { publishUpdateSource } from "@/lib/update-runner";
import { getSetting, setSetting } from "@/lib/setting-store";
import { parseUpdateSource, type UpdateSource } from "@polaris/core";

const SOURCE_KEY = "updates.source";

/** How this deployment installs updates. */
export async function getUpdateSource(): Promise<UpdateSource> {
    return parseUpdateSource(await getSetting(SOURCE_KEY));
}

/** Change it, and tell the host straight away so the next run agrees. */
export async function saveUpdateSource(source: UpdateSource): Promise<void> {
    await setSetting(SOURCE_KEY, source);
    await publishUpdateSource(source);
}
