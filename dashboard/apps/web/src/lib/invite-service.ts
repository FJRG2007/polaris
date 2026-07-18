/**
 * Invitations. New accounts come only from an admin invite: the admin creates an
 * invite (an emailed/handed-out link carrying a high-entropy token), and the
 * recipient sets their name and password to claim it. The raw token is returned
 * once at creation and never stored - only its hash is, so a database dump cannot
 * be used to accept invites.
 */

import { generateToken, hashToken } from "@polaris/core/tokens";
import { prisma } from "@polaris/db";
import { assignRole, provisionUser, seedDefaultRoles } from "@polaris/auth";
import { auth } from "@/lib/auth";

/** Seven days, the invite lifetime. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createInvite(
    invitedById: string,
    email: string,
    roleName: string
): Promise<{ token: string }> {
    await seedDefaultRoles();
    const normalizedEmail = email.trim().toLowerCase();
    const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
    const token = generateToken();
    await prisma.invite.create({
        data: {
            email: normalizedEmail,
            tokenHash: hashToken(token),
            roleId: role?.id ?? null,
            invitedById,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS)
        }
    });
    return { token };
}

/** Return a still-valid invite for a raw token, or null. */
export async function findValidInvite(token: string) {
    const invite = await prisma.invite.findUnique({
        where: { tokenHash: hashToken(token) }
    });
    if (!invite) return null;
    if (invite.acceptedAt) return null;
    if (invite.expiresAt.getTime() < Date.now()) return null;
    return invite;
}

/** Claim an invite: create the credentialed user and assign the invited role. */
export async function acceptInvite(token: string, name: string, password: string): Promise<void> {
    const invite = await findValidInvite(token);
    if (!invite) throw new Error("This invite is invalid, expired, or already used");

    const user = await provisionUser(auth, { email: invite.email, name, password });
    if (invite.roleId) {
        const role = await prisma.role.findUnique({ where: { id: invite.roleId }, select: { name: true } });
        if (role) await assignRole(user.id, role.name);
    }
    await prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
}

export async function listInvites() {
    return prisma.invite.findMany({
        where: { acceptedAt: null },
        select: { id: true, email: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: "desc" }
    });
}

export async function revokeInvite(id: string): Promise<void> {
    await prisma.invite.deleteMany({ where: { id, acceptedAt: null } });
}
