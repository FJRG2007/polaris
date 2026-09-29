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
 * The gates are the pair this subject already has, and no third one is invented
 * for it: `agents.read` means "may see the repositories this instance is
 * connected to", and `agents.manage` means "may act on them". Reading a pull
 * request and merging one are not the same act - a merge cannot be taken back
 * and a comment appears on GitHub under the caller's own name - and `agents.read`
 * is in the read-only role, so putting a write behind it would hand every viewer
 * a verb nobody meant to give them.
 */

import { z } from "zod";
import * as code from "@/lib/code/code-service";
import { requirePermission } from "@/lib/session";
import { CodeError } from "@/lib/code/code-service";
import type { CodeComment, CodeDetail, CodeItem } from "@/lib/code/code-service";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

type CodeKey = NamespaceKey<"code">;

/** A reply in the reader's language. */
async function say(key: CodeKey): Promise<string> {
    return (await getTranslations("code"))(key);
}

/** What the code service refuses with, by its English. */
const REFUSALS: Readonly<Record<string, CodeKey>> = {
    "Link a GitHub account first, under My account > Connected accounts.": "errors.linkFirst",
    "Link a GitHub account that reaches that repository.": "errors.linkReaching",
    "GitHub no longer accepts that link. Reconnect the account.": "errors.reconnect",
    "GitHub is rate limiting this account. Try again shortly.": "errors.rateLimited",
    "That account cannot do that on this repository.": "errors.cannot",
    "That is not there, or not visible to you.": "errors.notThere",
    "GitHub refused the merge: it is not in a mergeable state.": "errors.notMergeable",
    "GitHub could not answer that just now.": "errors.noAnswer",
    "Write something first": "errors.writeFirst"
};

/** A known sentence in the reader's words; anything else as it came. */
async function refusal(message: string): Promise<string> {
    const key = REFUSALS[message];
    return key ? say(key) : message;
}

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
        if (caught instanceof CodeError) return { error: await refusal(caught.message) };
        console.error(caught);
        return { error: await say("errors.readFailed") };
    }
}

export async function listWorkAction(
    input: unknown
): Promise<{ items?: CodeItem[]; error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = listSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.filter") };

    const result = await guard(() => code.listWork(user.id, parsed.data));
    return result.error ? { error: result.error } : { items: result.value };
}

export async function readWorkAction(
    input: unknown
): Promise<{ item?: CodeDetail; error?: string }> {
    const user = await requirePermission("agents.read");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.notOpenable") };

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
    if (!parsed.success) return { error: await say("errors.notOpenable") };

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
    const user = await requirePermission("agents.manage");
    const parsed = targetSchema
        .extend({ body: z.string().trim().min(1, "Write something first") /* i18n-ignore said through REFUSALS */.max(60000) })
        .safeParse(input);
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return { error: message ? await refusal(message) : await say("errors.post") };
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
    const user = await requirePermission("agents.manage");
    const parsed = targetSchema.extend({ state: z.enum(["open", "closed"]) }).safeParse(input);
    if (!parsed.success) return { error: await say("errors.change") };

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
    const user = await requirePermission("agents.manage");
    const parsed = targetSchema
        .extend({ method: z.enum(["merge", "squash", "rebase"]) })
        .safeParse(input);
    if (!parsed.success) return { error: await say("errors.merge") };

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
