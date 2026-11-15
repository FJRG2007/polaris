/**
 * Reading a tool's own model list on a session's machine, and keeping it.
 *
 * Read once the agent is up (the tool is installed and signed in by then), on
 * the machine the session runs on: a container through the runtime ports, a
 * server through the session's own SSH path. A container's answer is written to
 * a file and streamed back, because `runIn` cuts its output at 16 KiB; a
 * server's comes back on the SSH stream, which keeps up to 200 000 characters.
 *
 * What a read finds replaces the person's stored list for that tool. A read that
 * finds nothing keeps the last good list and records why, so a picker never
 * loses models because one machine was slow or signed out.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as native from "./native-models";
import { runInSession } from "./session-runtime";
import { withContainerPorts } from "./session-ports";

/** How often one person's list for one tool is read again at most. */
const REREAD_MS = 15 * 60 * 1000;

/** The most a container's answer is read. The script bounds each section
 *  well under this; past it the answer is not ours. */
const ANSWER_BYTES = 12 * 1024 * 1024;

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** The machine's answer to the script, or null when it could not be asked. */
async function askMachine(
    session: { id: string; place: string; hostId: string | null; containerId: string | null },
    script: string,
    nonce: string
): Promise<string | null> {
    if (session.place === "host") return (await runInSession(session.id, script)).output;
    if (session.place !== "local" || !session.containerId) return null;
    const containerId = session.containerId;
    const file = `/tmp/polaris-models-${nonce}.out`;
    return await withContainerPorts(session.hostId, async (ports) => {
        try {
            const ran = await ports.runIn(containerId, ["sh", "-c", `{ ${script}\n} > "$1" 2>/dev/null`, "sh", file]);
            if (ran.code !== 0) return null;
            return await readBounded(await ports.readFile(containerId, file), ANSWER_BYTES);
        } finally {
            await ports.runIn(containerId, ["rm", "-f", file]).catch(() => undefined);
        }
    });
}

/**
 * Read the session's tool's model list and store it for its owner. Quiet by
 * design: it runs beside a session that has better things to report, so every
 * failure is logged and recorded on the row, never thrown.
 */
export async function refreshSessionModels(sessionId: string): Promise<void> {
    const session = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { id: true, cli: true, place: true, hostId: true, containerId: true, startedById: true }
    });
    if (!session?.startedById || !native.readsNativeModels(session.cli)) return;
    const key = { userId: session.startedById, cli: session.cli };
    const row = await prisma.agentNativeModels.findUnique({
        where: { userId_cli: key },
        select: { checkedAt: true }
    });
    if (row && Date.now() - row.checkedAt.getTime() < REREAD_MS) return;

    const nonce = native.modelsNonce();
    const script = native.nativeModelsScript(session.cli, nonce);
    if (!script) return;
    let models: native.NativeModel[] = [];
    let error: string | null = null;
    try {
        const output = await askMachine(session, script, nonce);
        models = output ? native.parseNativeModels(session.cli, output, nonce) : [];
        if (models.length === 0) error = output === null ? "unreachable" : "empty";
    } catch (cause) {
        console.error(`[native-models] ${sessionId}: could not read ${session.cli}'s models:`, cause);
        error = "unreachable";
    }
    const now = new Date();
    const written = error
        ? { error, checkedAt: now }
        : { models: JSON.stringify(models), fetchedAt: now, error: null, checkedAt: now };
    await prisma.agentNativeModels.upsert({
        where: { userId_cli: key },
        create: { ...key, ...written },
        update: written
    });
}

/** Start a read without waiting for it. */
export function refreshSessionModelsSoon(sessionId: string): void {
    void refreshSessionModels(sessionId).catch((cause: unknown) =>
        console.error(`[native-models] ${sessionId}: could not store the models read:`, cause)
    );
}

/** The person's stored lists for the tools named, by tool. Tools never read
 *  are absent; a list is the last good one whatever the newest read said. */
export async function nativeModelsFor(
    userId: string,
    clis: readonly string[]
): Promise<Map<string, native.NativeModel[]>> {
    const wanted = clis.filter(native.readsNativeModels);
    if (wanted.length === 0) return new Map();
    const rows = await prisma.agentNativeModels.findMany({
        where: { userId, cli: { in: wanted } },
        select: { cli: true, models: true }
    });
    return new Map(rows.map((row) => [row.cli, native.readStoredModels(row.models)]));
}
