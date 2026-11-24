"use client";

/**
 * Sends what was written on this device while Polaris could not be reached,
 * from whichever screen is open - a note saved on the train goes out when the
 * laptop next finds the network, not when the notes are opened again.
 *
 * Each kind registers itself on import (`lib/offline/app-writes`); the imports
 * below are what make every kind sendable from anywhere.
 */

import "@/app/(app)/notes/offline-writes";
import "@/app/(app)/office/offline-writes";
import { appWrites, offlineStore, recoverUnloaded } from "@/lib/offline/app-writes";
import { useQueueFlusher } from "@/lib/offline/write-queue";

export function OfflineWrites({ userId }: { userId: string }) {
    // Before the first flush: the store reads and writes nothing for nobody.
    offlineStore.setOwner(userId);
    // What a tab closed on before it could save goes in line first.
    useQueueFlusher(() => void recoverUnloaded().then(appWrites.flush), [userId]);
    return null;
}
