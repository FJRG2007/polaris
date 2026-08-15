"use server";

/**
 * What the Code screens call.
 *
 * Every one of them is scoped by whose GitHub account is asking, and the service
 * resolves that from the session rather than from anything the client sends.
 * A repository name in a request is a request, not a grant: GitHub answers 404
 * to a token that cannot see it, and this layer passes that through as the
 * sentence it deserves rather than treating it as an error.
 *
 * `agents.read` is the gate. It is the permission that already means "may see
 * the repositories this instance is connected to", and inventing a second one
 * for the same subject would only mean two switches an operator has to find.
 */

import { z } from "zod";
import * as code from "@/lib/code/code-service";
import { requirePermission } from "@/lib/session";
import { CodeError } from "@/lib/code/code-service";
import type { CodeComment, CodeDetail, CodeItem } from "@/lib/code/code-service";

const listSchema = z.object({
    kind: z.enum(code.CODE_KINDS),
    scope: z.enum(code.CODE_SCOPES),
    state: z.enum(code.CODE_STATES),
    // Passed through to GitHub's search as extra qualifiers, so somebody who
    // knows the syntax can use it. Capped because it ends up in a URL.
    query: z.string().max(200).optional()
});

const targetSchema = z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    number: z.number().int().positive()
});

async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof CodeError) return { error: caught.message };
        console.error(caught);
        return { error: "That could not be read from GitHub." };
    }
}

export async function listWorkAction(
    input: unknown
): Promise<{ items?: CodeItem[]; error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = listSchema.safeParse(input);
    if (!parsed.success) return { error: "That filter could not be read" };

    const result = await guard(() => code.listWork(user.id, parsed.data));
    return result.error ? { error: result.error } : { items: result.value };
}

export async function readWorkAction(
    input: unknown
): Promise<{ item?: CodeDetail; error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not something to open" };

    const result = await guard(() =>
        code.readWork(user.id, parsed.data.owner, parsed.data.repo, parsed.data.number)
    );
    return result.error ? { error: result.error } : { item: result.value };
}

export async function readConversationAction(
    input: unknown
): Promise<{ comments?: CodeComment[]; error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema.extend({ kind: z.enum(code.CODE_KINDS) }).safeParse(input);
    if (!parsed.success) return { error: "That is not something to open" };

    const result = await guard(() =>
        code.readConversation(
            user.id,
            parsed.data.owner,
            parsed.data.repo,
            parsed.data.number,
            parsed.data.kind
        )
    );
    return result.error ? { error: result.error } : { comments: result.value };
}

export async function commentAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema
        .extend({ body: z.string().trim().min(1, "Write something first").max(60000) })
        .safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That could not be posted" };
    }

    return guard(() =>
        code.comment(
            user.id,
            parsed.data.owner,
            parsed.data.repo,
            parsed.data.number,
            parsed.data.body
        )
    );
}

export async function setStateAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema.extend({ state: z.enum(["open", "closed"]) }).safeParse(input);
    if (!parsed.success) return { error: "That could not be changed" };

    return guard(() =>
        code.setState(
            user.id,
            parsed.data.owner,
            parsed.data.repo,
            parsed.data.number,
            parsed.data.state
        )
    );
}

export async function mergeAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema
        .extend({ method: z.enum(["merge", "squash", "rebase"]) })
        .safeParse(input);
    if (!parsed.success) return { error: "That could not be merged" };

    return guard(() =>
        code.merge(
            user.id,
            parsed.data.owner,
            parsed.data.repo,
            parsed.data.number,
            parsed.data.method
        )
    );
}
