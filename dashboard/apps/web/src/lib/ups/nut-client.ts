/**
 * A client for a NUT server's line protocol (RFC 9271), for a UPS whose NUT
 * server is somewhere on the network rather than on a machine Polaris runs.
 *
 * One connection per read or command, a hard deadline on each, and a cap on
 * how much an answer may hold, so a server that never finishes cannot hold a
 * poll open or fill memory.
 */

import { Socket } from "node:net";

const TIMEOUT_MS = 6_000;
const MAX_ANSWER = 256 * 1024;

export interface NutTarget {
    host: string;
    port: number;
    upsName: string;
}

/** Quote a word for the protocol: NUT names never need it, passwords might. */
function word(value: string): string {
    return /^[A-Za-z0-9._@+-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** `VAR ups name "value"` lines into variables; `\"` and `\\` unescaped. */
export function parseListVar(answer: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of answer.split(/\r?\n/)) {
        const match = /^VAR \S+ (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line);
        if (match) vars[match[1]!] = match[2]!.replace(/\\(.)/g, "$1");
    }
    return vars;
}

export function parseListCmd(answer: string): string[] {
    return answer
        .split(/\r?\n/)
        .map((line) => /^CMD \S+ (\S+)$/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name));
}

/**
 * Send `lines` and collect the answer until `done` says it is complete. Every
 * failure - refused, timed out, closed early, too long - is one Error.
 */
function converse(
    target: Pick<NutTarget, "host" | "port">,
    lines: readonly string[],
    done: (answer: string) => boolean
): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        let answer = "";
        const fail = (message: string) => {
            socket.destroy();
            reject(new Error(message));
        };
        socket.setTimeout(TIMEOUT_MS, () => fail("timeout"));
        socket.once("error", () => fail("unreachable"));
        socket.on("data", (chunk) => {
            answer += chunk.toString("utf8");
            if (answer.length > MAX_ANSWER) return fail("tooLong");
            if (done(answer)) {
                socket.end("LOGOUT\n");
                resolve(answer);
            }
        });
        socket.once("close", () => {
            if (!done(answer)) reject(new Error("closed"));
        });
        socket.connect(target.port, target.host, () => {
            socket.write(lines.map((line) => `${line}\n`).join(""));
        });
    });
}

/** A UPS's variables and the commands it accepts. */
export async function nutRead(
    target: NutTarget
): Promise<{ vars: Record<string, string>; commands: string[] }> {
    const name = word(target.upsName);
    const answer = await converse(
        target,
        [`LIST VAR ${name}`, `LIST CMD ${name}`],
        (text) =>
            /^ERR /m.test(text) ||
            (text.includes("END LIST VAR") && text.includes("END LIST CMD"))
    );
    const error = /^ERR (\S+)/m.exec(answer)?.[1];
    if (error && !answer.includes("END LIST VAR")) throw new Error(error);
    return { vars: parseListVar(answer), commands: parseListCmd(answer) };
}

/** Run one instant command, logged in as `username`. */
export async function nutCommand(
    target: NutTarget,
    username: string,
    password: string,
    command: string
): Promise<void> {
    const answer = await converse(
        target,
        [
            `USERNAME ${word(username)}`,
            `PASSWORD ${word(password)}`,
            `INSTCMD ${word(target.upsName)} ${word(command)}`
        ],
        (text) => (text.match(/^(OK|ERR)\b.*$/gm) ?? []).length >= 3 || /^ERR /m.test(text)
    );
    const error = /^ERR (\S+)/m.exec(answer)?.[1];
    if (error) throw new Error(error);
}
