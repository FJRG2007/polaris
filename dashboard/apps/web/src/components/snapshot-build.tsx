"use client";

/**
 * Which build this document came from, told to the kept-reads store.
 *
 * Renders nothing. It exists for its position: the store is asked during the
 * render of the first screen that paints a kept reading, which is before any
 * effect in the tree has run - so an effect is too late, and this has to happen
 * while React is still on its way down to the page.
 *
 * Placed above the page in the shell for that reason. Everything else in the
 * shell can afford to be an effect; this cannot, because the paint it protects
 * is the first one.
 */

import { rememberSnapshotBuild } from "@/lib/snapshot-cache";

export function SnapshotBuild({ build }: { build: string | null }) {
    // During render, deliberately. It is an idempotent assignment into a plain
    // module - no state, no subscription, nothing for React to re-run - and the
    // whole point is to be settled before the components below ask.
    rememberSnapshotBuild(build);
    return null;
}
