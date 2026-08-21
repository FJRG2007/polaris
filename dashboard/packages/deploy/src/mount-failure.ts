/**
 * What a failed mount actually means, in words the operator can act on.
 *
 * `mount.cifs` and `mount.nfs` report in their own vocabulary, and it sends
 * people to the wrong place. "Server abruptly closed the connection" is what
 * comes back when the machine is switched off - it reads like a protocol
 * argument or a password problem, and the afternoon goes into checking
 * credentials that were never wrong. "NT_STATUS_BAD_NETWORK_NAME" is a share
 * name with a typo in it, and says so to nobody.
 *
 * So the handful of messages that actually turn up get translated, and anything
 * unrecognized is passed through untouched rather than guessed at. The original
 * is always kept on the end: the translation is for the person reading the
 * deploy log, and the original is for whoever has to search for it.
 *
 * Pure - a string in and a string out - so every case here is a test rather than
 * an afternoon with a NAS.
 */

/** One thing a mount failure can mean, and how to recognize it. */
interface Meaning {
    /** Matched case-insensitively against whatever the mount helper said. */
    readonly signs: readonly string[];
    /** What to tell the operator. `$source` is replaced with the share. */
    readonly says: string;
}

/**
 * In order: the first that matches wins, so the specific ones come before the
 * general. Every entry here is a message seen in the wild.
 */
const MEANINGS: readonly Meaning[] = [
    {
        // The share exists and the machine is there, but the credentials are not
        // accepted. Worth separating from everything else, because it is the one
        // an operator can actually fix from the dashboard.
        signs: ["permission denied", "logon_failure", "access_denied", "authentication failure"],
        says: "$source refused the username or password."
    },
    {
        signs: ["bad_network_name", "no such file or directory", "does not exist"],
        says: "$source is not a share on that machine - check the name."
    },
    {
        // mount.cifs says this when nothing completes an SMB negotiation, which
        // in practice means the machine is off, asleep, or not sharing.
        signs: [
            "abruptly closed",
            "connection reset",
            "no route to host",
            "host is down",
            "connection timed out",
            "connection refused",
            "ehostunreach",
            "ehostdown",
            "etimedout",
            "network is unreachable",
            "could not resolve"
        ],
        says: "the machine holding $source is not answering. It is off the network, asleep, or not sharing right now."
    },
    {
        signs: ["invalid argument", "protocol not supported", "operation not supported", "unsupported"],
        says: "$source would not speak a protocol this machine understands."
    },
    {
        // A mount left behind by a share that died. The mount paths force-detach
        // one they cannot read, so seeing this means that did not work either.
        signs: ["device or resource busy", "stale file handle", "transport endpoint"],
        says: "$source is still held by a connection that has died. The machine it is on may need a restart."
    }
];

/**
 * Turn what the mount helper said into a sentence, keeping the original.
 *
 * The source is named rather than left implied: a deploy can bind more than one
 * share, and "the machine is not answering" about an unnamed one is a sentence
 * nobody can act on.
 */
export function mountFailureReason(source: string, raw: string): string {
    const said = raw.trim();
    const lowered = said.toLowerCase();
    const meaning = MEANINGS.find((entry) => entry.signs.some((sign) => lowered.includes(sign)));
    // Unrecognized: the helper's own words, under a line that at least says
    // which share they were about.
    if (!meaning) return said ? `could not mount ${source}: ${said}` : `${source} could not be mounted.`;
    return `${meaning.says.replaceAll("$source", source)}${said ? ` (${said})` : ""}`;
}
