/**
 * The fake app-server (`fake-app-server.mjs`) run as a real process, its
 * stdio held the way a session's pipe holds an agent's: everything it wrote,
 * read by offset, and its input appended to. Spawned from an argument array,
 * no shell.
 */

import { join } from "node:path";
import type { PipeIo } from "@/lib/agents/acp/transport";
import { ACP_READ_BYTES, type PipeRead } from "@/lib/agents/acp/pipe-commands";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const FAKE_APP_SERVER = join(__dirname, "fake-app-server.mjs");

export class StdioPipe implements PipeIo {
    readonly generation = "1700000000000000000-7";
    readonly child: ChildProcessWithoutNullStreams;
    private out = Buffer.alloc(0);
    private err = "";
    private exitCode: number | null = null;

    constructor(env: Record<string, string> = {}) {
        this.child = spawn(process.execPath, [FAKE_APP_SERVER], { env: { ...process.env, ...env }, stdio: "pipe" });
        this.child.stdout.on("data", (chunk: Buffer) => {
            this.out = Buffer.concat([this.out, chunk]);
        });
        this.child.stderr.on("data", (chunk: Buffer) => {
            this.err += chunk.toString("utf8");
        });
        this.child.on("exit", (code) => {
            this.exitCode = code ?? 1;
        });
    }

    /** Every frame the client sent, as the fake read it. */
    received(): Record<string, unknown>[] {
        return this.err
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    async read(offset: number): Promise<PipeRead | null> {
        const bytes = new Uint8Array(this.out.subarray(offset, offset + ACP_READ_BYTES));
        return { generation: this.generation, exitCode: bytes.byteLength > 0 ? null : this.exitCode, bytes };
    }

    async write(generation: string, bytes: Uint8Array): Promise<boolean> {
        if (generation !== this.generation || this.exitCode !== null) return false;
        await new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())));
        return true;
    }

    stop(): void {
        this.child.kill();
    }
}
