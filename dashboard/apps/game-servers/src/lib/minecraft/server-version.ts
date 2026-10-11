/**
 * Which Minecraft a server is running, out of what it wrote when it started.
 *
 * Server-only: it reads the container's log.
 */

import type { ServerContainer } from "./service";

const LOG_DIR = "/data/logs";
const LOG_FILE = `${LOG_DIR}/latest.log`;
const VERSION_LINE = "Starting minecraft server version [^ ]*";

/**
 * The version the server said it started as, out of its log; null when unread.
 *
 * The line is written once, when the server starts, and the log is rolled over
 * into `logs/<date>-<n>.log.gz` at the first midnight after that - so a server
 * that has been up since yesterday has no such line in `latest.log`. The newest
 * archive that has it is then this run's start: every start rolls the log over
 * too, so an older start is always in an older file.
 */
export async function serverVersion(server: ServerContainer): Promise<string | null> {
    const read = async (script: string) => {
        const result = await server.run(["sh", "-c", script]).catch(() => null);
        return /version (\S+)/.exec(result?.output ?? "")?.[1] ?? null;
    };
    return (
        (await read(`grep -m1 -o '${VERSION_LINE}' ${LOG_FILE}`)) ??
        (await read(
            `for f in $(ls -t ${LOG_DIR}/*.log.gz 2>/dev/null | head -n 60); do gzip -dc "$f" 2>/dev/null | grep -m1 -o '${VERSION_LINE}' && break; done`
        ))
    );
}
