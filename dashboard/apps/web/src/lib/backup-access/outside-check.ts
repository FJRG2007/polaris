/**
 * The check from outside, the pure half: what an enrolled cloud server is asked
 * to run, how its answer is read, and how it combines with the check from inside.
 *
 * A cloud server sees the house the way a visitor does, so its answer beats
 * anything this machine can learn about itself: a router that does not loop back,
 * or a backup line behind carrier NAT, looks fine from inside and is plainly shut
 * from outside. Without one, or when it cannot be asked, the inside check stands.
 *
 * Run the way every other check on an enrolled machine is run (`server-probe.ts`):
 * one `sh -s` over the pooled SSH connection, the script on stdin.
 */

import { isIP } from "node:net";
import type { Verdict } from "./decision";

/** The marker the answer line starts with, so a login banner is never read. */
const MARKER = "POLARIS_OUTSIDE";
const CONNECT_SECONDS = 5;

/**
 * The script: open a TCP connection to the address and say how it went, with
 * curl where the server has it (it also times the connection), else nc, else
 * bash's /dev/tcp. The address is an IP literal, checked, so it cannot carry
 * anything else into the shell.
 */
export function outsideScript(address: string, port = 443): string {
    if (isIP(address) === 0) throw new Error("The address to check is not an IP address");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port to check is not a port");
    const url = `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}/`;
    return [
        `addr='${address}'`,
        `port=${port}`,
        "if command -v curl >/dev/null 2>&1; then",
        `  out=$(curl -sk -o /dev/null --connect-timeout ${CONNECT_SECONDS} --max-time ${CONNECT_SECONDS * 2} -w '%{time_connect}' '${url}' 2>/dev/null)`,
        `  echo "${MARKER} curl $? $out"`,
        "elif command -v nc >/dev/null 2>&1; then",
        `  nc -z -w ${CONNECT_SECONDS} "$addr" "$port" >/dev/null 2>&1`,
        `  echo "${MARKER} nc $?"`,
        "elif command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then",
        `  timeout ${CONNECT_SECONDS} bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$addr" "$port" >/dev/null 2>&1`,
        `  echo "${MARKER} bash $?"`,
        "else",
        `  echo "${MARKER} none"`,
        "fi",
        ""
    ].join("\n");
}

export interface OutsideAnswer {
    readonly verdict: "up" | "down";
    /** Milliseconds to open the connection, when the tool timed it. */
    readonly ms: number | null;
}

/** curl's codes for "never connected": could not connect, and timed out. */
const CURL_UNREACHED = new Set([7, 28]);

/** Read the script's answer. Null when it says nothing usable. */
export function readOutside(output: string): OutsideAnswer | null {
    const line = output
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${MARKER} `));
    if (!line) return null;
    const [, tool, code, timing] = line.split(/\s+/);
    const status = Number(code);
    if (tool === "curl") {
        const seconds = Number(timing);
        // A connection that opened has a connect time, whatever TLS made of it after.
        if (Number.isFinite(seconds) && seconds > 0) return { verdict: "up", ms: Math.round(seconds * 1000) };
        return Number.isInteger(status) && CURL_UNREACHED.has(status) ? { verdict: "down", ms: null } : null;
    }
    if (tool === "nc" || tool === "bash") {
        if (!Number.isInteger(status)) return null;
        return { verdict: status === 0 ? "up" : "down", ms: null };
    }
    return null;
}

/**
 * The verdict a pass decides on. No uplink is the breaker's to say and nothing
 * outside changes it; otherwise an answer from outside wins, and the inside check
 * is the fallback.
 */
export function combineVerdicts(
    inside: Verdict,
    outside: OutsideAnswer | null
): { verdict: Verdict; from: "outside" | "inside" } {
    if (inside === "no-uplink") return { verdict: inside, from: "inside" };
    if (outside) return { verdict: outside.verdict, from: "outside" };
    return { verdict: inside, from: "inside" };
}
