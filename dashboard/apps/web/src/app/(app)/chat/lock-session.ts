/**
 * The unlock proofs this tab holds, one per locked conversation it has opened.
 *
 * sessionStorage, so a lock opened in one tab is opened there alone and closes
 * with the tab - the server checks every proof on each message read, so this is
 * only where the tab keeps what it was handed, never what decides.
 */

const KEY = "polaris.chat.unlocked";

function readAll(): Record<string, string> {
    try {
        const raw = window.sessionStorage.getItem(KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object") return {};
        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string"
            )
        );
    } catch {
        return {};
    }
}

function writeAll(proofs: Record<string, string>): void {
    try {
        window.sessionStorage.setItem(KEY, JSON.stringify(proofs));
    } catch {
        // A private window without storage asks for the code on each open.
    }
}

export function unlockProofFor(channelId: string): string | null {
    if (typeof window === "undefined") return null;
    return readAll()[channelId] ?? null;
}

export function keepUnlockProofs(proofs: Record<string, string>): void {
    writeAll({ ...readAll(), ...proofs });
}

export function forgetUnlockProof(channelId: string): void {
    const all = readAll();
    delete all[channelId];
    writeAll(all);
}
