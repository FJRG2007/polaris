/**
 * Next calls this once per runtime. Everything Polaris starts lives in
 * `instrumentation-node.ts`, reached only from inside the Node check: with a
 * middleware in the app Next also builds this file for the edge runtime, and
 * the check written around the import (not as an early return) is what lets
 * the edge build leave the Node-only modules out.
 */

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { registerNode } = await import("./instrumentation-node");
        await registerNode();
    }
}
