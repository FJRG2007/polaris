/**
 * What a run reports about itself while it works.
 *
 * The runtime PATCHes this as it goes: the pull request and issue it created,
 * the model it actually ran on, and the tokens it spent. Polaris served no such
 * route, so every run logged `PATCH workflow-run: 404` and the token counts on
 * the runs screen stayed empty - the numbers an operator is paying their
 * provider for, never recorded.
 *
 * The id in the path is **GitHub's** run id, not Polaris's - the runtime knows
 * itself by `GITHUB_RUN_ID` and has no reason to learn a second identifier. So
 * the path is a claim to cross-check, and the authenticated caller is what
 * decides which row is written. Comparing the path against the Polaris run id
 * instead is a 404 on every call, which is what this route did when it was
 * first written.
 *
 * Everything is optional and anything unrecognised is dropped, because the
 * runtime sends what it has at the moment it has it and gains fields faster than
 * this does.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { authenticateRun } from "@/lib/agents/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Polaris keeps.
 *
 * The runtime also sends GitHub node ids for the artefacts it made; those are
 * its own bookkeeping and Polaris links to the pull request by number instead,
 * so they are accepted and ignored rather than stored under a column that would
 * only ever be written.
 */
/** Long enough for the classified body with the provider's own message quoted
 *  under it; short enough that a run cannot write a novel into the row. */
const FAILURE_MAX = 4000;

const patchSchema = z.object({
    model: z.string().trim().max(120).optional(),
    inputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
    outputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
    // Which classification the failure landed on, as a value rather than as the
    // prose below - what decides whether the next model in the fallback chain is
    // tried. Kept as sent even when unrecognised: this Polaris does not have to
    // know every kind a newer runtime reports, and a stored value it cannot act
    // on is still the truth about what happened.
    failureKind: z.string().trim().min(1).max(40).optional(),
    // Why it failed, as the run itself explained it - the same words the job
    // summary and the pull request comment carry. It is markdown a person is
    // meant to read, so it is stored as sent and bounded rather than parsed.
    //
    // Trimmed to length rather than rejected for it: a body that ran long would
    // otherwise fail the whole request and take the token counts down with it,
    // which is a lot to lose over a verbose provider message.
    failure: z
        .string()
        .trim()
        .min(1)
        .max(200_000)
        .transform((body) => body.slice(0, FAILURE_MAX))
        .optional()
});

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
    const { runId } = await params;

    const caller = await authenticateRun(request.headers);
    if (!caller) return Response.json({ error: "not a recognised run" }, { status: 401 });

    // Either identifier is accepted, and both have to be about the caller. A
    // path naming somebody else's job is refused rather than quietly writing to
    // the caller's own row, which would let a job report another's numbers.
    const row = await prisma.agentRun.findUnique({
        where: { id: caller.runId },
        select: { githubRunId: true }
    });
    if (!row) return Response.json({ error: "not that run" }, { status: 404 });
    if (runId !== caller.runId && runId !== row.githubRunId) {
        return Response.json({ error: "not that run" }, { status: 404 });
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    // A body this does not understand is not an error the run should act on: it
    // is a newer runtime sending a field this Polaris has no column for.
    if (!parsed.success) return Response.json({ ok: true });

    const data = {
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.inputTokens === undefined ? {} : { tokensIn: parsed.data.inputTokens }),
        ...(parsed.data.outputTokens === undefined ? {} : { tokensOut: parsed.data.outputTokens }),
        ...(parsed.data.failure ? { error: parsed.data.failure } : {}),
        ...(parsed.data.failureKind ? { failureKind: parsed.data.failureKind } : {})
    };
    // The caller's own row, never the path's: the path may legitimately carry
    // GitHub's id, which is not what this table is keyed on.
    if (Object.keys(data).length > 0) {
        await prisma.agentRun.updateMany({ where: { id: caller.runId }, data });
    }

    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
