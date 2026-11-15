/**
 * `polaris-agent`: the process a native session runs, started by the session
 * boot (`launch.sh`, in tmux) or the runner exactly like a coding CLI.
 *
 * Two ways to run, matching the CLIs the session machinery already drives:
 *
 * - `-p`: one turn. The prompt is standard input, the answer is printed, the
 *   process exits. The runner runs every queued prompt this way, resuming the
 *   conversation its hooks last named (`--resume <id>`).
 * - interactive: each line typed (or pasted, bracketed) is a prompt;
 *   `/model <id>` switches the model and `/compact` compacts.
 *
 * Ctrl-C interrupts the turn in progress; a second one while idle exits.
 * Flags: `--resume <id>`, `--fork-session` (continue a copy of the resumed
 * conversation under a new id), `--permission-mode <mode>`, `--model <id>`.
 *
 * Server-free: no Polaris server import, so esbuild bundles it into one file
 * (`scripts/build-native-agent.mjs`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { CONVERSATION_ID, replayTranscript } from "@/lib/polar/native/resume";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/polar/native/tools";
import { launchModel, launchSession, readLaunchEnv, transcriptDir, transcriptPathOf, type LaunchConfig } from "@/lib/polar/native/launch";

/** The command line, parsed; anything unknown is refused by name. */
export interface AgentArgs {
    readonly oneTurn: boolean;
    readonly resume: string | null;
    readonly fork: boolean;
    readonly mode: PermissionMode | null;
    readonly model: string | null;
}

export function parseArgs(argv: readonly string[]): AgentArgs | { error: string } {
    let oneTurn = false;
    let resume: string | null = null;
    let fork = false;
    let mode: PermissionMode | null = null;
    let model: string | null = null;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index] as string;
        const value = () => argv[++index] ?? "";
        if (arg === "-p" || arg === "--print") oneTurn = true;
        else if (arg === "--fork-session") fork = true;
        else if (arg === "--resume") {
            resume = value();
            // An id, or (for a fork) the path of the parent's transcript.
            if (!CONVERSATION_ID.test(resume) && !/^\/[A-Za-z0-9_./-]+\.jsonl$/.test(resume)) {
                return { error: "that is not a conversation polaris-agent can reopen" };
            }
        } else if (arg === "--permission-mode") {
            const given = value();
            if (!(PERMISSION_MODES as readonly string[]).includes(given)) return { error: `unknown permission mode: ${given}` };
            mode = given as PermissionMode;
        } else if (arg === "--model") {
            model = value().trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/.test(model)) return { error: "that is not a model id" };
        } else return { error: `unknown argument: ${arg}` };
    }
    return { oneTurn, resume, fork, mode, model };
}

/** The file a resume reads, and the conversation id the run continues as. */
export function conversationOf(config: LaunchConfig, args: AgentArgs): { id: string; from: string | null } {
    if (!args.resume) return { id: randomUUID(), from: null };
    const from = args.resume.startsWith("/") ? args.resume : transcriptPathOf(config, args.resume);
    if (args.fork || args.resume.startsWith("/")) return { id: randomUUID(), from };
    return { id: args.resume, from };
}

/** The repository's instruction files, as the prompt quotes them. */
function memoryOf(workdir: string): { file: string; text: string }[] {
    return ["AGENTS.md", "CLAUDE.md"].flatMap((file) => {
        try {
            const text = fs.readFileSync(path.join(workdir, file), "utf8");
            return text.trim() ? [{ file, text }] : [];
        } catch {
            return [];
        }
    });
}

/** Strips the bracketed-paste markers a terminal wraps pasted text in. */
export function pasteState(line: string, inPaste: boolean): { text: string; inPaste: boolean } {
    let state = inPaste;
    if (line.includes("\u001b[200~")) state = true;
    if (line.includes("\u001b[201~")) state = false;
    return { text: line.replace(/\u001b\[20[01]~/g, ""), inPaste: state };
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if ("error" in args) {
        process.stderr.write(`polaris-agent: ${args.error}\n`);
        return 2;
    }
    const read = readLaunchEnv(process.env);
    if ("invalid" in read) {
        process.stderr.write(`polaris-agent: missing or malformed: ${read.invalid.join(", ")}\n`);
        return 2;
    }
    let config: LaunchConfig = args.model ? { ...read.config, POLARIS_MODEL: args.model } : read.config;
    // The token is this process's own; nothing the agent runs inherits it.
    delete process.env.POLARIS_SESSION_TOKEN;

    const conversation = conversationOf(config, args);
    const transcriptPath = transcriptPathOf(config, conversation.id);
    fs.mkdirSync(config.POLARIS_TRANSCRIPT ? path.dirname(transcriptPath) : transcriptDir(), { recursive: true });
    let previous = "";
    if (conversation.from) {
        try {
            previous = fs.readFileSync(conversation.from, "utf8");
        } catch {
            previous = "";
        }
        // A fork's file starts as a copy of its parent's, so its history reads whole.
        if (conversation.from !== transcriptPath && previous) fs.writeFileSync(transcriptPath, previous);
    }
    const session = launchSession(config, {
        writeTranscript: (line) => fs.appendFileSync(transcriptPath, `${line}\n`),
        memory: memoryOf(config.POLARIS_WORKDIR),
        conversationId: conversation.id
    });
    if (args.mode) session.setMode(args.mode);
    if (previous) session.restore(replayTranscript(previous));
    await session.start(previous ? "resume" : "startup");

    let current: AbortController | null = null;
    let lastInterrupt = 0;
    process.on("SIGINT", () => {
        if (current) {
            current.abort(new Error("interrupted"));
            return;
        }
        if (args.oneTurn || Date.now() - lastInterrupt < 2_000) process.exit(130);
        lastInterrupt = Date.now();
        process.stdout.write("\n(press Ctrl-C again to exit)\n");
    });

    const run = async (prompt: string): Promise<boolean> => {
        current = new AbortController();
        try {
            const result = await session.turn(prompt, current.signal);
            process.stdout.write(`${result.interrupted ? "[interrupted]" : result.text}\n`);
            return true;
        } catch (error) {
            process.stdout.write(`polaris-agent: ${(error as Error).message}\n`);
            return false;
        } finally {
            current = null;
        }
    };

    if (args.oneTurn) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const prompt = Buffer.concat(chunks).toString("utf8").trim();
        if (!prompt) {
            process.stderr.write("polaris-agent: no prompt on standard input\n");
            return 2;
        }
        return (await run(prompt)) ? 0 : 1;
    }

    if (process.stdout.isTTY) process.stdout.write("\u001b[?2004h");
    const input = readline.createInterface({ input: process.stdin, terminal: false });
    let buffer: string[] = [];
    let inPaste = false;
    process.stdout.write("> ");
    for await (const raw of input) {
        const state = pasteState(raw, inPaste);
        inPaste = state.inPaste;
        buffer.push(state.text);
        if (inPaste) continue;
        const prompt = buffer.join("\n").trim();
        buffer = [];
        if (!prompt) {
            process.stdout.write("> ");
            continue;
        }
        if (prompt === "/exit") break;
        if (prompt === "/compact") {
            current = new AbortController();
            await session.compact(current.signal).catch((error: unknown) => process.stdout.write(`${(error as Error).message}\n`));
            current = null;
        } else if (prompt.startsWith("/model ")) {
            const model = prompt.slice("/model ".length).trim();
            const next = parseArgs(["--model", model]);
            if ("error" in next) process.stdout.write(`${next.error}\n`);
            else {
                config = { ...config, POLARIS_MODEL: model };
                session.setModel(launchModel(config), model);
            }
        } else await run(prompt);
        process.stdout.write("> ");
    }
    return 0;
}

/** Runs the program and exits with its status; the bundle's entry calls it
 *  (`bin.ts`), so a test importing the helpers above starts nothing. */
export function runAgent(): void {
    main().then(
        (code) => process.exit(code),
        (error: unknown) => {
            process.stderr.write(`polaris-agent: ${(error as Error).message}\n`);
            process.exit(1);
        }
    );
}
