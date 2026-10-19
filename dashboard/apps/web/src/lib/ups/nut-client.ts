/**
 * A client for a NUT server's line protocol (RFC 9271), for a UPS whose NUT
 * server is somewhere on the network rather than on a machine Polaris runs.
 *
 * One connection per read or command, a hard deadline on each, and a cap on
 * how much an answer may hold, so a server that never finishes cannot hold a
 * poll open or fill memory. Each request waits for its own whole answer (one
 * line, or `BEGIN LIST` to `END LIST`) before the next is sent.
 */

import { Socket } from "node:net";
import type { UpsRwVar } from "./ups-settings";

const TIMEOUT_MS = 6_000;
const MAX_ANSWER = 256 * 1024;
/** Most writable variables read, each one costing a round trip or two. */
const MAX_RW = 64;

export interface NutTarget {
    host: string;
    port: number;
    upsName: string;
}

/** Quote a word for the protocol: NUT names never need it, passwords might. */
function word(value: string): string {
    return /^[A-Za-z0-9._@+-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function unescape(value: string): string {
    return value.replace(/\\(.)/g, "$1");
}

/** `VAR ups name "value"` lines into variables; `\"` and `\\` unescaped. */
export function parseListVar(answer: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of answer.split(/\r?\n/)) {
        const match = /^VAR \S+ (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line);
        if (match) vars[match[1]!] = unescape(match[2]!);
    }
    return vars;
}

export function parseListCmd(answer: string): string[] {
    return answer
        .split(/\r?\n/)
        .map((line) => /^CMD \S+ (\S+)$/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name));
}

/** `RW ups name "value"` lines. */
export function parseListRw(answer: string): [string, string][] {
    return answer
        .split(/\r?\n/)
        .map((line) => /^RW \S+ (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1]!, unescape(match[2]!)]);
}

/** The kind and string length out of a `TYPE ups var RW STRING:16` answer. */
export function parseType(answer: string): Pick<UpsRwVar, "kind" | "maxLen"> {
    const words = answer.trim().split(/\s+/).slice(3);
    if (words.includes("ENUM")) return { kind: "enum" };
    if (words.includes("RANGE")) return { kind: "range" };
    const string = words.find((one) => one.startsWith("STRING:"));
    if (string) {
        const length = Number.parseInt(string.slice("STRING:".length), 10);
        return Number.isFinite(length) ? { kind: "string", maxLen: length } : { kind: "string" };
    }
    if (words.includes("NUMBER")) return { kind: "number" };
    return { kind: "string" };
}

/** Every quoted value on each `verb` line (`ENUM ups v "x"`, `RANGE ups v "a" "b"`). */
export function parseQuoted(answer: string, verb: "ENUM" | "RANGE"): string[][] {
    return answer
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${verb} `))
        .map((line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unescape(match[1]!)));
}

/** One connection: requests answered strictly in order. */
class NutSession {
    private readonly socket = new Socket();
    private buffer = "";
    private total = 0;
    private failure: Error | null = null;
    private waiter: (() => void) | null = null;

    constructor(private readonly target: Pick<NutTarget, "host" | "port">) {}

    open(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.setTimeout(TIMEOUT_MS, () => this.fail("timeout"));
            this.socket.on("error", () => {
                this.fail("unreachable");
                reject(new Error("unreachable"));
            });
            this.socket.on("data", (chunk) => {
                const text = chunk.toString("utf8");
                this.total += text.length;
                if (this.total > MAX_ANSWER) return this.fail("tooLong");
                this.buffer += text;
                this.waiter?.();
            });
            this.socket.once("close", () => this.fail("closed"));
            this.socket.connect(this.target.port, this.target.host, () => resolve());
        });
    }

    private fail(message: string) {
        this.failure ??= new Error(message);
        this.socket.destroy();
        this.waiter?.();
    }

    /** Send one request and read its whole answer. */
    async ask(line: string): Promise<string> {
        this.socket.write(`${line}\n`);
        for (;;) {
            const answer = this.complete();
            if (answer !== null) return answer;
            if (this.failure) throw this.failure;
            await new Promise<void>((resolve) => {
                this.waiter = resolve;
            });
            this.waiter = null;
        }
    }

    /** One complete answer off the front of the buffer, or null for more. */
    private complete(): string | null {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) return null;
        const first = this.buffer.slice(0, newline).replace(/\r$/, "");
        if (!first.startsWith("BEGIN LIST ")) {
            this.buffer = this.buffer.slice(newline + 1);
            return first;
        }
        const end = `END LIST ${first.slice("BEGIN LIST ".length)}`;
        const at = this.buffer.indexOf(end);
        if (at < 0) return null;
        const stop = this.buffer.indexOf("\n", at);
        if (stop < 0) return null;
        const answer = this.buffer.slice(0, stop + 1);
        this.buffer = this.buffer.slice(stop + 1);
        return answer;
    }

    close() {
        if (!this.socket.destroyed) this.socket.end("LOGOUT\n");
        this.socket.destroy();
    }
}

async function withSession<T>(target: Pick<NutTarget, "host" | "port">, run: (s: NutSession) => Promise<T>): Promise<T> {
    const session = new NutSession(target);
    try {
        await session.open();
        return await run(session);
    } finally {
        session.close();
    }
}

function errorOf(answer: string): string | null {
    return /^ERR (\S+)/.exec(answer)?.[1] ?? null;
}

/** The writable variables with their kinds and allowed values. */
async function readWritable(session: NutSession, name: string): Promise<UpsRwVar[]> {
    const listed = await session.ask(`LIST RW ${name}`);
    if (errorOf(listed)) return [];
    const out: UpsRwVar[] = [];
    for (const [variable, value] of parseListRw(listed).slice(0, MAX_RW)) {
        if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(variable)) continue;
        const rw: UpsRwVar = { name: variable, value, ...parseType(await session.ask(`GET TYPE ${name} ${variable}`)) };
        if (rw.kind === "enum") {
            rw.options = parseQuoted(await session.ask(`LIST ENUM ${name} ${variable}`), "ENUM").map((one) => one[0]!);
        } else if (rw.kind === "range") {
            rw.ranges = parseQuoted(await session.ask(`LIST RANGE ${name} ${variable}`), "RANGE")
                .filter((one) => one.length === 2)
                .map((one) => [one[0]!, one[1]!] as [string, string]);
        }
        out.push(rw);
    }
    return out;
}

/** A UPS's variables, the commands it accepts and what can be set on it. */
export async function nutRead(
    target: NutTarget
): Promise<{ vars: Record<string, string>; commands: string[]; rw: UpsRwVar[] }> {
    const name = word(target.upsName);
    return withSession(target, async (session) => {
        const vars = await session.ask(`LIST VAR ${name}`);
        const error = errorOf(vars);
        if (error) throw new Error(error);
        const commands = await session.ask(`LIST CMD ${name}`);
        const rw = await readWritable(session, name).catch(() => []);
        return { vars: parseListVar(vars), commands: errorOf(commands) ? [] : parseListCmd(commands), rw };
    });
}

async function login(session: NutSession, username: string, password: string) {
    for (const line of [`USERNAME ${word(username)}`, `PASSWORD ${word(password)}`]) {
        const error = errorOf(await session.ask(line));
        if (error) throw new Error(error);
    }
}

/** Run one instant command, logged in as `username`. */
export async function nutCommand(
    target: NutTarget,
    username: string,
    password: string,
    command: string
): Promise<void> {
    await withSession(target, async (session) => {
        await login(session, username, password);
        const error = errorOf(await session.ask(`INSTCMD ${word(target.upsName)} ${word(command)}`));
        if (error) throw new Error(error);
    });
}

/** Set one writable variable, logged in as `username`. */
export async function nutSetVar(
    target: NutTarget,
    username: string,
    password: string,
    variable: string,
    value: string
): Promise<void> {
    await withSession(target, async (session) => {
        await login(session, username, password);
        const quoted = `"${value.replace(/["\\]/g, "\\$&")}"`;
        const error = errorOf(await session.ask(`SET VAR ${word(target.upsName)} ${word(variable)} ${quoted}`));
        if (error) throw new Error(error);
    });
}
