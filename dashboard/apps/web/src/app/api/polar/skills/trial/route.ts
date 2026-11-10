/**
 * POST /api/polar/skills/trial - adds the skill a temporary chat was trying:
 * a catalog skill by id, or the draft it was given, held to the same schema
 * the Skills editor uses. Answers the saved skill, or `{ error }` in words.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import * as store from "@/lib/polar/skills/store";
import { getTranslations } from "@/lib/i18n/request";
import { trialSkillSchema } from "@/lib/polar/skills/shared";

export const dynamic = "force-dynamic";

/** A skill is a few kilobytes; anything past this is not one. */
const BODY_MAX = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const t = await getTranslations("polar");
    const refuse = (
        code: "viewingAs" | "too_long" | "failed" | "limit" | "duplicate" | "not_found",
        status: number
    ) =>
        NextResponse.json({ error: t(`settings.skills.errors.${code}`) }, { status });
    if (user.viewingAs) return refuse("viewingAs", 403);
    const text = await request.text().catch(() => "");
    if (text.length > BODY_MAX) return refuse("too_long", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return refuse("failed", 400);
    }
    const parsed = trialSkillSchema.safeParse(raw);
    if (!parsed.success) return refuse("failed", 400);
    const saved =
        "catalog" in parsed.data
            ? await store.addCatalogSkill(user.id, parsed.data.catalog)
            : await store.createSkill(user.id, parsed.data.draft);
    if (typeof saved === "string") {
        return refuse(saved === "invalid" ? "failed" : saved, saved === "not_found" ? 404 : 409);
    }
    return NextResponse.json({ skill: saved }, { status: 201 });
}
