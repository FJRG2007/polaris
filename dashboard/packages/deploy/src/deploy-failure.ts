/**
 * What a deploy that gave up actually means, in words the operator can act on.
 *
 * The same job `mount-failure.ts` does for a share, for the same reason, and it
 * was written after the same afternoon. A deploy stopped with this in the log:
 *
 *   failed commit on ref "layer-sha256:d54b0e...": commit failed: rename
 *   /var/lib/containerd/io.containerd.content.v1.content/ingest/3f7c.../data
 *   /var/lib/containerd/.../blobs/sha256/d54b0e...: no such file or directory
 *
 * Which is a sentence about a rename, and reads like a corrupted image or a bad
 * registry. It means the disk filled up while the image was coming down. The
 * machine was at 97%, the layer had nowhere to land, and nothing anywhere said
 * so - not the log, not the deployment record, not the screen. Somebody without
 * a terminal has no way to reach that fact at all, and somebody with one still
 * has to know to look.
 *
 * So the handful of failures that actually turn up get translated, and anything
 * unrecognized is passed through untouched rather than guessed at. The original
 * is always kept: the translation is for the person reading the deploy log, and
 * the original is for whoever has to search for it.
 *
 * Pure - a string in and a string out - so every case here is a test rather than
 * an evening with a full disk.
 */

/** One thing a deploy failure can mean, and how to recognize it. */
interface Meaning {
    /** Matched case-insensitively against whatever the runtime said. */
    readonly signs: readonly string[];
    readonly says: string;
}

/**
 * In order: the first that matches wins, so the specific ones come before the
 * general. Every entry is a message seen in the wild.
 */
const MEANINGS: readonly Meaning[] = [
    {
        // Out of room, in each of its disguises. The last two are the ones worth
        // having: the image store reports a full disk as a failed rename or a
        // layer it could not register, and neither says anything about space.
        signs: [
            "no space left on device",
            "enospc",
            "not enough space",
            "insufficient space",
            "failed commit on ref",
            "failed to register layer",
            "write /var/lib/docker",
            "write /var/lib/containerd"
        ],
        says: "the machine ran out of disk space while fetching the image. Nothing was deployed. Free some room on it and try again."
    },
    {
        signs: ["manifest unknown", "manifest for", "not found: manifest", "no such manifest"],
        says: "that image does not exist at the address it was asked for - check the name and the tag."
    },
    {
        signs: ["unauthorized", "authentication required", "denied: requested access", "forbidden"],
        says: "the registry refused the credentials for that image."
    },
    {
        signs: [
            "no route to host",
            "connection refused",
            "dial tcp",
            "i/o timeout",
            "temporary failure in name resolution",
            "no such host",
            "tls handshake timeout"
        ],
        says: "the registry could not be reached from that machine."
    },
    {
        // Docker's own words for a port already taken, which reads as a compose
        // problem and is somebody else's container.
        signs: ["address already in use", "port is already allocated", "bind for"],
        says: "something on that machine is already using a port this needs."
    },
    {
        signs: ["exec format error", "no matching manifest for", "platform"],
        says: "that image was not built for this machine's processor."
    }
];

/**
 * Turn what the runtime said into a sentence, keeping the original.
 *
 * The fallback is the caller's own words for the step that failed, so a deploy
 * that gave up with nothing to say still names the step rather than saying
 * "failed".
 */
export function deployFailureReason(raw: string, fallback: string): string {
    const said = raw.trim();
    if (!said) return fallback;
    const lowered = said.toLowerCase();
    const meaning = MEANINGS.find((entry) => entry.signs.some((sign) => lowered.includes(sign)));
    // Unrecognized: the runtime's own words, which are better than a wrong
    // translation of them.
    if (!meaning) return said;
    return `${meaning.says} (${said})`;
}

/** Whether this failure was the disk filling up, for a caller that wants to do
 *  something about it rather than only say it. */
export function isOutOfSpace(raw: string): boolean {
    const lowered = raw.toLowerCase();
    return MEANINGS[0]!.signs.some((sign) => lowered.includes(sign));
}
