/**
 * The live channel's frames, gathered into one refresh.
 *
 * A burst of frames is one refresh, run a short pause after the last of them.
 * But a pause is not something a busy mailbox is guaranteed to take: a first
 * sync stores mail folder by folder for minutes, and the server sends a frame
 * every few hundred milliseconds the whole time. Waiting only for quiet meant
 * the screen was never asked for again while that went on - the list sat on its
 * skeleton beside a rail filling up with mail. So a burst is also cut off at
 * `maxWaitMs` after its first frame, and a long one refreshes at that pace.
 */
export interface Settler {
    /** A frame arrived. */
    readonly frame: () => void;
    /** Drop whatever is waiting, for a screen going away. */
    readonly cancel: () => void;
}

export function settleFrames(run: () => void, settleMs: number, maxWaitMs: number): Settler {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let ceiling: ReturnType<typeof setTimeout> | null = null;

    const cancel = (): void => {
        if (quiet) clearTimeout(quiet);
        if (ceiling) clearTimeout(ceiling);
        quiet = null;
        ceiling = null;
    };
    const fire = (): void => {
        cancel();
        run();
    };

    return {
        frame: () => {
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(fire, settleMs);
            ceiling ??= setTimeout(fire, maxWaitMs);
        },
        cancel
    };
}
