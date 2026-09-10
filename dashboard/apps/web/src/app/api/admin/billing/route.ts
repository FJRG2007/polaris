/**
 * The whole instance's statement for a month, read after the screen has painted.
 *
 * Admin-only: it names every owner's projects and what each of them used. The
 * organizations' budgets ride along, so the screen can put each one beside what
 * that organization spent. Node runtime for Prisma.
 */

import { apiAdmin } from "@/lib/api-session";
import { budgetsIn } from "@/lib/billing/budgets";
import { statementResponse } from "@/lib/billing/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    return statementResponse(request, { kind: "all" }, async (view) => {
        const currency = view.statement.rates?.currency;
        return { budgets: currency ? Object.fromEntries(await budgetsIn(currency)) : {} };
    });
}
