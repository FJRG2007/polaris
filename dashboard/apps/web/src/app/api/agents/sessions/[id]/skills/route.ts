/**
 * The skills a Code session loads, fetched once at boot by the script
 * `skillsSyncScript` writes (`lib/agents/session-skills.ts`), with the
 * session's own token. Answers the person who started the session: their own
 * switched-on skills, the built-ins they switched on, and the Enigma skills
 * edited for them or for everybody. Only for a home that is one person's,
 * the same rule the boot uses to write the script.
 */

import { prisma } from "@polaris/db";
import { enabledSkills } from "@/lib/polar/skills/store";
import { sessionForToken } from "@/lib/agents/session-service";
import { ownEnigma } from "@/lib/agents/agent-defaults-service";
import { enigmaCatalogue } from "@/lib/polar/skills/enigma-catalogue";
import { effectiveUpstreamSkills } from "@/lib/polar/skills/override-store";
import { pickSessionSkills, sessionSkillsBody } from "@/lib/agents/session-skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}

/** Read by a script, not shown to a person. */
function answer(status: number, body = ""): Response {
    return new Response(body, {
        status,
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }
    });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const session = await sessionForToken(bearer(request));
    if (!session || session.id !== id) return answer(401);
    const record = await prisma.agentSession.findUnique({
        where: { id },
        select: { startedById: true, place: true, sharedHome: true }
    });
    if (!record?.startedById || record.place !== "local" || record.sharedHome) return answer(404);
    const userId = record.startedById;
    try {
        const [own, enigma] = await Promise.all([
            enabledSkills(userId),
            ownEnigma(userId).then(async ({ resolved }) => {
                if (!resolved.enabled) return [];
                const off = new Set(resolved.skillsOff);
                return (await enigmaCatalogue()).skills.filter((skill) => !off.has(skill.name));
            })
        ]);
        const effective = await effectiveUpstreamSkills(userId, enigma);
        const skills = pickSessionSkills({
            own,
            builtins: effective.builtins,
            enigmaUpstream: enigma,
            enigmaEffective: effective.enigma
        });
        return answer(200, sessionSkillsBody(skills));
    } catch (error) {
        console.error(`[agent-session] ${id}: skills not read:`, error);
        return answer(500);
    }
}
