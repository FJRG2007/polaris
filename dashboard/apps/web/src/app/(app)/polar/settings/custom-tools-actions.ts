"use server";

/**
 * Custom tools, plugins and a repository's own tools, from Polar's settings.
 * Every action establishes the signed-in person and their Polar access,
 * parses its input with the schemas the store writes with, and touches only
 * that person's rows. Somebody viewing as another account reads, and never
 * writes or approves.
 */

import type { UnavailableModule } from "@/lib/polar/custom-tools/opencode-modules";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import * as store from "@/lib/polar/custom-tools/store";
import * as runtime from "@/lib/polar/custom-tools/runtime";
import { toolsServerSkipped } from "@/lib/agents/session-runtime";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const idSchema = z.string().uuid().nullable();

async function caller(write: boolean): Promise<{ id: string } | { error: string }> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) return { error: t("settings.customTools.errors.noAccess") };
    if (write && user.viewingAs) return { error: t("settings.customTools.errors.viewingAs") };
    return { id: user.id };
}

async function refusal(reason: store.StoreRefusal | "changed"): Promise<{ ok: false; error: string }> {
    const t = await getTranslations("polar");
    return { ok: false, error: t(`settings.customTools.errors.${reason}`) };
}

export async function saveCustomTool(id: string | null, input: unknown): Promise<Result<store.StoredTool>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const target = idSchema.safeParse(id);
    if (!target.success) return refusal("invalid");
    const saved = await store.saveTool(who.id, target.data, input);
    return typeof saved === "string" ? refusal(saved) : { ok: true, value: saved };
}

export async function deleteCustomTool(id: string): Promise<Result<null>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const target = z.string().uuid().safeParse(id);
    if (!target.success || !(await store.deleteTool(who.id, target.data))) return refusal("not_found");
    return { ok: true, value: null };
}

export async function savePlugin(id: string | null, input: unknown): Promise<Result<store.StoredPlugin>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const target = idSchema.safeParse(id);
    if (!target.success) return refusal("invalid");
    const saved = await store.savePlugin(who.id, target.data, input);
    return typeof saved === "string" ? refusal(saved) : { ok: true, value: saved };
}

export async function deletePlugin(id: string): Promise<Result<null>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const target = z.string().uuid().safeParse(id);
    if (!target.success || !(await store.deletePlugin(who.id, target.data))) return refusal("not_found");
    return { ok: true, value: null };
}

/** A repository's tools as the person reviews them before saying yes. */
export interface ProjectToolsView {
    sessionId: string;
    digest: string;
    approved: boolean;
    tools: { name: string; description: string; path: string; runtime: string; script: string }[];
    refused: string[];
    /** OpenCode's TypeScript tool modules, their source, and whether they
     *  run: read after the approval, and only in a sandbox with Bun. */
    modules: { path: string; source: string; status: ModuleStatus }[];
}

export type ModuleStatus = "ready" | "pending" | UnavailableModule["reason"];

/** The tools of the repository the person's newest live session works in,
 *  read from its checkout; null when there is no such session or no tools. */
export async function reviewProjectTools(): Promise<Result<ProjectToolsView | null>> {
    const who = await caller(false);
    if ("error" in who) return { ok: false, error: who.error };
    const sandbox = await runtime.sandboxFor(who.id);
    if (!sandbox) return { ok: true, value: null };
    const review = await runtime.reviewProjectTools(who.id, sandbox);
    if (!review) return { ok: true, value: null };
    const offer = review.approved ? await runtime.projectOffer(sandbox, review) : null;
    const statusOf = (path: string): ModuleStatus => {
        if (!review.hasBun) return "no_bun";
        if (!offer) return "pending";
        const missing = offer.unavailable.find((entry) => entry.path === path || entry.path.startsWith(`${path}#`));
        return missing ? missing.reason : "ready";
    };
    return {
        ok: true,
        value: {
            sessionId: sandbox.sessionId,
            digest: review.digest,
            approved: review.approved,
            tools: review.tools.map(({ name, description, path, runtime: kind, script }) => ({
                name,
                description,
                path,
                runtime: kind,
                script
            })),
            refused: review.refused,
            modules: review.modules.map((path) => ({
                path,
                source: review.files.find((file) => file.path === path)?.contents ?? "",
                status: statusOf(path)
            }))
        }
    };
}

/** Whether the person's newest live session left their tools out because its
 *  machine has no Node to run the tool server with. */
export async function sessionToolsSkipped(): Promise<Result<boolean>> {
    const who = await caller(false);
    if ("error" in who) return { ok: false, error: who.error };
    const sandbox = await runtime.sandboxFor(who.id);
    return { ok: true, value: sandbox ? await toolsServerSkipped(sandbox.sessionId) : false };
}

/** The person's yes to the revision they reviewed. Read again here, so the
 *  yes is only kept when the checkout still has exactly what they saw. */
export async function approveProjectTools(sessionId: string, digest: string): Promise<Result<null>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const input = z.object({ sessionId: z.string().uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse({ sessionId, digest });
    if (!input.success) return refusal("invalid");
    const sandbox = await runtime.sandboxFor(who.id, input.data.sessionId);
    if (!sandbox?.repository) return refusal("not_found");
    const review = await runtime.reviewProjectTools(who.id, sandbox);
    if (!review || review.digest !== input.data.digest) return refusal("changed");
    await store.approve(who.id, sandbox.repository, review.digest);
    runtime.forgetReview(who.id, sandbox.sessionId);
    return { ok: true, value: null };
}
