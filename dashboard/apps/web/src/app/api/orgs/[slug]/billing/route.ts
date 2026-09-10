/**
 * One organization's statement for a month, and its budget.
 *
 * The permission is `settings.manage`, the one that already governs how the
 * organization is run: what it spends, and how much it means to, is the business
 * of whoever holds its settings rather than of everybody on the roster. A handle
 * that exists but is not this account's answers exactly as one that does not.
 * Node runtime for Prisma.
 */

import { apiUser } from "@/lib/api-session";
import { getOrgBudget } from "@/lib/billing/budgets";
import { statementResponse } from "@/lib/billing/export";
import { orgReaderWith } from "@/lib/orgs/activity-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { slug } = await params;
    const orgId = await orgReaderWith(user, slug, "settings.manage");
    if (!orgId) return new Response(null, { status: 404 });
    return statementResponse(request, { kind: "orgs", orgIds: [orgId] }, async () => ({
        budget: await getOrgBudget(orgId)
    }));
}
