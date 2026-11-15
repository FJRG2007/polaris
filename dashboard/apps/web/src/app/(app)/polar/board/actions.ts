"use server";

import { z } from "zod";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { requireUser, userHasManage } from "@/lib/session";
import { boardPeopleOptions, boardRepoOptions, type BoardOption } from "@/lib/polar/code-board";

const optionsInput = z
    .object({
        kind: z.enum(["repo", "person"]),
        query: z.string().trim().max(100).optional().default(""),
        cursor: z.string().trim().max(200).nullish(),
        ids: z.array(z.string().uuid()).max(10).optional()
    })
    .strict();

/** A page of the repository or person filter's options, searched in the database. */
export async function boardOptionsAction(
    input: Record<string, unknown>
): Promise<{ items: BoardOption[]; next: string | null } | { error: string }> {
    const user = await requireUser();
    const t = await getTranslations("polar");
    if (!(await polarAccessFor(user.id)).use || !(await userHasManage(user, "agents.read")))
        return { error: t("board.noAccess") };
    const parsed = optionsInput.safeParse(input);
    if (!parsed.success) return { error: t("board.loadFailed") };
    const { kind, query, cursor, ids } = parsed.data;
    const read = kind === "repo" ? boardRepoOptions : boardPeopleOptions;
    return read(user.id, query, cursor ?? null, ids);
}
