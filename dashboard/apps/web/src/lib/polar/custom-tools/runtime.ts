/**
 * Custom tools and project tools running for Polar, always in the person's
 * own session sandbox.
 *
 * The sandbox is the newest live Code session the person started that takes
 * commands: its container, or their own server (`runInSession`). A session on
 * somebody's computer takes protocol frames rather than commands, so it is not
 * one; no session at all and a call answers with the step that gives it one.
 * Nothing here runs a script in this process - the command `toolCommand`
 * builds is executed by the session's machine.
 *
 * Every call is parsed against the tool's declared input before it is sent,
 * and asked about in the chat unless the person set the tool to "allow"; a
 * "deny" tool is never offered.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { tool, type FlexibleSchema, type ToolSet } from "ai";
import * as store from "@/lib/polar/custom-tools/store";
import * as shared from "@/lib/polar/custom-tools/shared";
import * as modules from "@/lib/polar/custom-tools/opencode-modules";
import { runInSession } from "@/lib/agents/session-runtime";

/** The live states a session takes commands in. */
const LIVE_STATES = ["working", "waiting", "idle"];

export interface Sandbox {
    readonly sessionId: string;
    /** The repository it works in, the key an approval is kept under. */
    readonly repository: string | null;
}

/** The person's newest live session that takes commands, or null. `sessionId`
 *  narrows it to one, still only theirs. */
export async function sandboxFor(userId: string, sessionId: string | null = null): Promise<Sandbox | null> {
    const row = await prisma.agentSession.findFirst({
        where: {
            startedById: userId,
            state: { in: LIVE_STATES },
            place: { not: "computer" },
            ...(sessionId ? { id: sessionId } : {})
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, repoId: true }
    });
    return row ? { sessionId: row.id, repository: row.repoId } : null;
}

export type CallOutcome = { ok: boolean; text: string };

const NO_SANDBOX =
    "Custom tools run in one of your Code sessions, and none is running. Start a Code session, then ask again.";

/** One call of a tool, parsed and run in the sandbox. */
export async function runTool(
    sandbox: Sandbox,
    definition: shared.RunnableTool,
    written: unknown,
    run: typeof runInSession = runInSession
): Promise<CallOutcome> {
    const args = shared.callSchema(definition.input).safeParse(written ?? {});
    if (!args.success) return { ok: false, text: `${definition.name} was called with input it does not take.` };
    try {
        const result = await run(sandbox.sessionId, shared.toolCommand(definition, args.data));
        const outcome = shared.readToolRun(result.output);
        if (outcome.timedOut)
            return { ok: false, text: `${definition.name} ran past ${definition.timeoutSeconds} s and was stopped.\n${outcome.text}` };
        return { ok: outcome.ok, text: outcome.text || (outcome.ok ? "(no output)" : `Exited with ${outcome.code ?? "an error"}.`) };
    } catch (error) {
        console.error(`[polar-tools] ${definition.name} could not run in ${sandbox.sessionId}`, error);
        return { ok: false, text: "The session could not run the tool. It may have just stopped." };
    }
}

/** A repository's own tools as the sandbox's checkout has them, and whether
 *  the person approved this revision of them. */
export interface ProjectReview extends shared.ProjectTools {
    readonly digest: string;
    readonly approved: boolean;
    readonly files: shared.ProjectFile[];
    /** Whether the sandbox has Bun, which OpenCode's TypeScript tools need. */
    readonly hasBun: boolean;
}

export async function reviewProjectTools(
    userId: string,
    sandbox: Sandbox,
    run: typeof runInSession = runInSession
): Promise<ProjectReview | null> {
    if (!sandbox.repository) return null;
    const result = await run(sandbox.sessionId, shared.projectFilesCommand()).catch(() => null);
    if (!result) return null;
    const files = shared.readProjectFiles(result.output);
    if (files.length === 0) return null;
    const digest = await shared.projectDigest(files);
    const approved = await store.isApproved(userId, sandbox.repository, digest);
    return { ...shared.parseProjectTools(files), digest, approved, files, hasBun: shared.readHasBun(result.output) };
}

/** The approved repository tools of a sandbox, OpenCode's modules read
 *  with Bun included, and the modules that could not be offered. */
export interface ProjectOffer {
    readonly tools: shared.ProjectTool[];
    readonly unavailable: modules.UnavailableModule[];
}

const NO_OFFER: ProjectOffer = { tools: [], unavailable: [] };

/** What an approved review offers. Modules are imported only here, after the
 *  approval, and only where the sandbox has Bun to import them with. */
export async function projectOffer(
    sandbox: Sandbox,
    review: ProjectReview | null,
    run: typeof runInSession = runInSession
): Promise<ProjectOffer> {
    if (!review?.approved) return NO_OFFER;
    if (review.modules.length === 0) return { tools: review.tools, unavailable: [] };
    if (!review.hasBun)
        return { tools: review.tools, unavailable: review.modules.map((path) => ({ path, reason: "no_bun" as const })) };
    const listed = await run(sandbox.sessionId, modules.moduleListCommand(review.modules)).catch(() => null);
    if (!listed)
        return { tools: review.tools, unavailable: review.modules.map((path) => ({ path, reason: "load_failed" as const })) };
    const read = modules.readModuleList(
        listed.output,
        review.modules,
        sandbox.sessionId,
        new Set(review.tools.map((entry) => entry.name))
    );
    return { tools: [...review.tools, ...read.tools], unavailable: read.unavailable };
}

/** Project offers kept a short while, so a chat turn or a session's tool list
 *  does not read the checkout every time. A new revision shows up within the
 *  window. */
const REVIEW_TTL_MS = 30_000;
const offers = new Map<string, { at: number; offer: ProjectOffer }>();

async function cachedOffer(userId: string, sandbox: Sandbox): Promise<ProjectOffer> {
    const key = `${userId}:${sandbox.sessionId}`;
    const hit = offers.get(key);
    if (hit && Date.now() - hit.at < REVIEW_TTL_MS) return hit.offer;
    const review = await reviewProjectTools(userId, sandbox).catch(() => null);
    const offer = await projectOffer(sandbox, review).catch(() => NO_OFFER);
    if (offers.size > 500) offers.clear();
    offers.set(key, { at: Date.now(), offer });
    return offer;
}

/** Forgets a cached review, after the person approved one. */
export function forgetReview(userId: string, sessionId: string): void {
    offers.delete(`${userId}:${sessionId}`);
}

export interface CustomToolSet {
    tools: ToolSet;
    approval: Record<string, () => Promise<"approved" | "user-approval">>;
    described: Record<string, { title: string; writes: boolean; destructive: boolean }>;
}

/** A tool a sandbox offers, and whether a call needs the person's yes. */
export interface OfferedTool {
    readonly definition: shared.RunnableTool;
    readonly fromProject: boolean;
    /** A repository's tool is always asked about: the approval was for the
     *  files, not for every call any input could make. */
    readonly asks: boolean;
}

/** Every tool a sandbox offers the person: their own switched-on tools, then
 *  the approved repository tools whose names they do not already use. */
export async function sandboxTools(
    userId: string,
    sandbox: Sandbox | null
): Promise<{ tools: OfferedTool[]; unavailable: modules.UnavailableModule[] }> {
    const own = (await store.listTools(userId).catch(() => [])).filter(offered);
    const offer = sandbox ? await cachedOffer(userId, sandbox) : NO_OFFER;
    const project = offer.tools.filter((entry) => !own.some((mine) => mine.name === entry.name));
    return {
        tools: [
            ...own.map((definition) => ({ definition, fromProject: false, asks: definition.permission !== "allow" })),
            ...project.map((definition) => ({ definition, fromProject: true, asks: true }))
        ],
        unavailable: offer.unavailable
    };
}

/** Whether a definition is offered at all. */
export function offered(definition: Pick<shared.CustomTool, "enabled" | "permission">): boolean {
    return definition.enabled && definition.permission !== "deny";
}

/**
 * The person's custom tools, and the approved revision of their newest
 * session's repository tools, as AI SDK tools. The sandbox is found again on
 * every call: the session a turn started with may have stopped by the time an
 * approval comes back.
 */
export async function polarCustomTools(userId: string): Promise<CustomToolSet> {
    const sandbox = await sandboxFor(userId).catch(() => null);
    const offer = await sandboxTools(userId, sandbox);
    const set: CustomToolSet = { tools: {}, approval: {}, described: {} };
    for (const { definition, fromProject, asks } of offer.tools) {
        const name = shared.turnToolName(definition.name);
        set.tools[name] = tool({
            description: definition.description,
            inputSchema: shared.callSchema(definition.input) as unknown as FlexibleSchema<Record<string, unknown>>,
            async execute(written: unknown) {
                const at = await sandboxFor(userId, fromProject && sandbox ? sandbox.sessionId : null);
                if (!at) return { ok: false, text: NO_SANDBOX };
                return runTool(at, definition, written);
            }
        });
        const allowed = !asks;
        set.approval[name] = async () => (allowed ? "approved" : "user-approval");
        set.described[name] = { title: definition.name, writes: true, destructive: !allowed };
    }
    return set;
}
