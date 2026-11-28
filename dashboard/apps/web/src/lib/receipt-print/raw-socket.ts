/**
 * Talking to a network receipt printer on its raw port (9100).
 *
 * One connection asks the printer how it is (`DLE EOT`, answered in real time),
 * and only when it is ready writes the job. That order is what lets a caller
 * know nothing was written: a refusal, a timeout or a printer out of paper all
 * end before the first byte of the ticket left, so retrying them can never print
 * a ticket twice. Only an error after the write started leaves the outcome
 * unknown, and that is reported as such.
 *
 * Server-only. The address is checked here as well as where it is saved, so no
 * caller can turn this into a way of writing bytes to an arbitrary host.
 */

import { connect, type Socket } from "node:net";
import * as print from "@polaris/core/receipt-print";

export const CONNECT_TIMEOUT_MS = 3000;
export const REPLY_TIMEOUT_MS = 1500;
export const WRITE_TIMEOUT_MS = 15_000;

export type SendOutcome =
    | { kind: "printed"; paperLow: boolean }
    | { kind: "not-sent"; problem: print.PrinterProblem }
    | { kind: "unknown" };

function open(address: string, port: number): Promise<Socket | null> {
    if (!print.isPrinterAddress(address) || !print.isPrinterPort(port)) return Promise.resolve(null);
    return new Promise((resolve) => {
        const socket = connect({ host: address, port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(null);
        }, CONNECT_TIMEOUT_MS);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(null);
        });
    });
}

/** Send a query and wait for the one byte it answers, or undefined. */
function ask(socket: Socket, query: readonly number[]): Promise<number | undefined> {
    return new Promise((resolve) => {
        const done = (value: number | undefined) => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            resolve(value);
        };
        const onData = (chunk: Buffer) => done(chunk[chunk.length - 1]);
        const onError = () => done(undefined);
        const timer = setTimeout(() => done(undefined), REPLY_TIMEOUT_MS);
        socket.on("data", onData);
        socket.once("error", onError);
        socket.write(Uint8Array.from(query));
    });
}

async function status(socket: Socket): Promise<print.PrinterStatus> {
    const printer = await ask(socket, print.STATUS_QUERIES.printer);
    if (printer === undefined) return { problem: "not-a-printer", paperLow: false };
    const offline = await ask(socket, print.STATUS_QUERIES.offline);
    const paper = await ask(socket, print.STATUS_QUERIES.paper);
    return print.readStatus(printer, offline, paper);
}

/** How the printer is, without printing anything. */
export async function readPrinterStatus(address: string, port: number): Promise<print.PrinterStatus> {
    const socket = await open(address, port);
    if (!socket) return { problem: "unreachable", paperLow: false };
    try {
        return await status(socket);
    } finally {
        socket.destroy();
    }
}

/**
 * The printer's model name (`GS I 67`, answered as "_" + name + NUL by Epson
 * and most compatibles), or null when it does not say.
 */
export async function readPrinterModel(address: string, port: number): Promise<string | null> {
    const socket = await open(address, port);
    if (!socket) return null;
    try {
        const text = await new Promise<string>((resolve) => {
            let buffer = "";
            const timer = setTimeout(() => resolve(buffer), REPLY_TIMEOUT_MS);
            socket.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("latin1");
                if (buffer.includes("\u0000")) {
                    clearTimeout(timer);
                    resolve(buffer);
                }
            });
            socket.once("error", () => resolve(buffer));
            socket.write(Uint8Array.from([0x1d, 0x49, 67]));
        });
        const match = /_([\x20-\x7e]{1,40})\u0000/.exec(text);
        return match ? match[1]!.trim() : null;
    } finally {
        socket.destroy();
    }
}

/**
 * Check the printer, then write the job. A printer that does not answer the
 * status query at all is still printed to: plenty of print servers in front of
 * an old printer pass the job through and never answer.
 */
export async function sendJob(address: string, port: number, payload: Uint8Array): Promise<SendOutcome> {
    const socket = await open(address, port);
    if (!socket) return { kind: "not-sent", problem: "unreachable" };
    try {
        const state = await status(socket);
        if (state.problem && state.problem !== "not-a-printer") return { kind: "not-sent", problem: state.problem };
        const written = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), WRITE_TIMEOUT_MS);
            socket.once("error", () => {
                clearTimeout(timer);
                resolve(false);
            });
            socket.end(payload, () => {
                clearTimeout(timer);
                resolve(true);
            });
        });
        return written ? { kind: "printed", paperLow: state.paperLow } : { kind: "unknown" };
    } finally {
        socket.destroy();
    }
}
