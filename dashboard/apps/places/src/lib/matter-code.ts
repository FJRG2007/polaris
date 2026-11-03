/**
 * The code a Matter camera is added with, and where it lives once added.
 *
 * The code is what the camera's own app shows under "share with another app"
 * (multi-admin): an 11-digit manual code, the 21-digit long form, or the
 * `MT:` text of a QR code. Both digit forms end in a Verhoeff check digit
 * (Matter Core spec 5.1.4.1), so a mistyped digit is caught here, while the
 * person is still typing, instead of after a minute of the camera not answering.
 *
 * Client-safe: the add-camera form and the server read the same rules.
 */

/** The vendor id a Matter camera is stored under. */
export const MATTER_VENDOR = "matter";

const MULTIPLY = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

const PERMUTE = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

/** Whether a string of digits, check digit last, passes Verhoeff. */
export function verhoeffValid(digits: string): boolean {
    let check = 0;
    const reversed = [...digits].reverse();
    for (let i = 0; i < reversed.length; i++) {
        const row = MULTIPLY[check] as number[];
        const permuted = (PERMUTE[i % 8] as number[])[Number(reversed[i])] as number;
        check = row[permuted] as number;
    }
    return check === 0;
}

/** The code as typed, reduced to what it is: spaces and dashes go, a QR text
 *  keeps its own characters upper-cased. */
export function normalizeMatterCode(raw: string): string {
    const trimmed = raw.trim();
    if (/^mt:/i.test(trimmed)) return `MT:${trimmed.slice(3).replace(/\s/g, "").toUpperCase()}`;
    return trimmed.replace(/[\s-]/g, "");
}

/** Why a code cannot be the one, or null when it can. An empty field is not
 *  wrong yet, only unfinished. */
export type MatterCodeIssue = "incomplete" | "format" | "check";

export function matterCodeIssue(raw: string): MatterCodeIssue | null {
    const code = normalizeMatterCode(raw);
    if (code === "") return "incomplete";
    if (code.startsWith("MT:")) return /^MT:[0-9A-Z.-]{19,}$/.test(code) ? null : "format";
    if (!/^\d+$/.test(code)) return "format";
    if (code.length < 11) return "incomplete";
    if (code.length !== 11 && code.length !== 21) return "format";
    // The first digit of a manual code is 0-7 (its top bits are the version
    // and the long-form flag); 8 and 9 never appear there.
    if (Number(code[0]) > 7) return "format";
    return verhoeffValid(code) ? null : "check";
}

/** Where a commissioned camera is, as the relay's path into the bridge. Stored
 *  in the camera's main path, which is what that field is for every make. */
export function matterStreamPath(nodeId: number, endpointId: number): string {
    return `/cameras/${nodeId}/${endpointId}`;
}

export function parseMatterPath(path: string | null | undefined): {
    nodeId: number;
    endpointId: number;
} | null {
    const match = /^\/cameras\/(\d{1,20})\/(\d{1,5})$/.exec(path ?? "");
    if (!match) return null;
    const nodeId = Number(match[1]);
    const endpointId = Number(match[2]);
    return Number.isSafeInteger(nodeId) && endpointId <= 0xfffe ? { nodeId, endpointId } : null;
}

/**
 * The relay's source for a Matter camera: go2rtc's own WebRTC signalling
 * format (`webrtc:ws://...`, internal/webrtc/client.go), which carries the
 * camera's speaker as well as its picture. The token is the bridge's password;
 * the source lives only in the relay's configuration, never on a screen.
 */
export function matterRelaySource(bridgeUrl: string, path: string, token: string): string {
    const ws = bridgeUrl.replace(/^http/, "ws").replace(/\/$/, "");
    return `webrtc:${ws}${path}/webrtc?${new URLSearchParams({ token }).toString()}`;
}
