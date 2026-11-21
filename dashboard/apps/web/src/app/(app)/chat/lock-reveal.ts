/**
 * Opening "Locked chats" from Chat search, for a reader who hid the entry.
 *
 * The search proves the code with the server (`openLockedChatsAction`, a POST,
 * so the code never sits in an address or a log) and keeps the proofs; this only
 * tells the sidebar to show the shelf - now if it is mounted, or on its next
 * mount when the search navigated to Chat first.
 *
 * Client-only.
 */

const EVENT = "polaris:chat-reveal-locked";
const FLAG = "polaris:chat-reveal-locked";

/** Ask the sidebar to open the "Locked chats" shelf. */
export function revealLockedChats(): void {
    try {
        sessionStorage.setItem(FLAG, "1");
    } catch {
        // Storage refused: the event still reaches a sidebar already on screen.
    }
    window.dispatchEvent(new Event(EVENT));
}

/** Whether a reveal is waiting, consuming it. */
function takeReveal(): boolean {
    try {
        const waiting = sessionStorage.getItem(FLAG) === "1";
        sessionStorage.removeItem(FLAG);
        return waiting;
    } catch {
        return false;
    }
}

/** Call `open` for a reveal that is waiting and for every one after it. */
export function listenForReveal(open: () => void): () => void {
    if (takeReveal()) open();
    const heard = () => {
        if (takeReveal()) open();
    };
    window.addEventListener(EVENT, heard);
    return () => window.removeEventListener(EVENT, heard);
}

/** Whether a Chat search may be a chat lock code, so it is tried as one and
 *  never sent as a search: digits only, no longer than the code. */
export function maybeLockCode(query: string, codeLength: number): boolean {
    return /^\d+$/.test(query) && query.length <= codeLength;
}
