/**
 * What "Improve" knows about whoever asked for a rewrite: their name and
 * address, the context and skills they chose in Polar's settings, and - when
 * what they are writing belongs to an organization they are in - that
 * organization's name and shared writing guide.
 *
 * The organization is the caller's claim (the mailbox or task space the text
 * is written in), so it is honoured only for a member; anybody else gets the
 * rewrite without it rather than an error. Server-only.
 */

import { prisma } from "@polaris/db";
import type { SessionUser } from "@/lib/session";
import { resolveOrgAccess } from "@/lib/orgs/org-service";
import type { WritingProfile } from "@/lib/polar/improve-draft";
import type { PolarPreferences } from "@/lib/polar/preferences";

export async function writingProfile(
    user: Pick<SessionUser, "id" | "name" | "email">,
    orgId: string | null,
    settings: Pick<PolarPreferences, "writingContext" | "writingSkills"> | null
): Promise<WritingProfile> {
    const names = settings?.writingSkills ?? [];
    const [org, skills] = await Promise.all([
        orgId ? organizationFor(user.id, orgId) : null,
        names.length
            ? prisma.polarSkill.findMany({
                  where: { ownerId: user.id, name: { in: [...names] }, enabled: true },
                  select: { name: true, instructions: true },
                  take: names.length
              })
            : []
    ]);
    return {
        writer: { name: user.name ?? "", email: user.email ?? "" },
        org,
        context: settings?.writingContext ?? "",
        skills
    };
}

/** The organization's name and guide, for one of its members only. */
async function organizationFor(
    userId: string,
    orgId: string
): Promise<WritingProfile["org"]> {
    // Membership as the person themselves: an instance administrator writing in
    // somebody else's organization is not writing on its behalf.
    const access = await resolveOrgAccess({ id: userId, isAdmin: false }, orgId).catch(() => null);
    if (!access) return null;
    const row = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, writingGuide: true }
    });
    return row ? { name: row.name, guide: row.writingGuide } : null;
}
