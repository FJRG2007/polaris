/**
 * Who may reach a mail server, and the credential Polaris manages it with.
 *
 * A server set up on somebody's own shelf is theirs; one set up on an
 * organization's shelf is that organization's, and anybody the organization
 * lets deploy may manage it. On top of either, the instance permission
 * `mailserver.manage` is asked by every action before this is - running a mail
 * server is a decision about the instance, not only about a project.
 *
 * Every lookup narrows inside the query or checks the organization before
 * anything about the row is returned, and "not yours" reads the same as "not
 * there", so an id in a URL cannot be used to learn that a server exists.
 */

import { reached } from "./steps";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { prisma, type MailServer } from "@polaris/db";
import type { StalwartCredentials } from "./stalwart";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";

export class MailServerAccessError extends Error {
    public constructor(message = "That mail server was not found.") {
        super(message);
        this.name = "MailServerAccessError";
    }
}

/** Who is asking. */
export interface MailServerActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** A server the actor may manage, or a refusal that says nothing about it. */
export async function requireServer(actor: MailServerActor, serverId: string): Promise<MailServer> {
    const row = await prisma.mailServer.findUnique({ where: { id: serverId } });
    if (!row) throw new MailServerAccessError();
    if (row.orgId) {
        await requireOrgPermission(actor, row.orgId, "deploy.manage").catch(() => {
            throw new MailServerAccessError();
        });
        return row;
    }
    if (row.ownerId !== actor.id) throw new MailServerAccessError();
    return row;
}

/** The servers on the shelf that is open. */
export async function listServers(actor: MailServerActor, shelfOrgId: string | null): Promise<MailServer[]> {
    if (shelfOrgId) {
        await requireOrgPermission(actor, shelfOrgId, "deploy.manage").catch(() => {
            throw new MailServerAccessError("You cannot manage this organization's mail servers.");
        });
        return prisma.mailServer.findMany({ where: { orgId: shelfOrgId }, orderBy: { createdAt: "asc" } });
    }
    return prisma.mailServer.findMany({
        where: { ownerId: actor.id, orgId: null },
        orderBy: { createdAt: "asc" }
    });
}

/** A secret sealed with the master key, in the three columns every sealed
 *  value here is stored in. */
export interface Sealed {
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly keyId: string;
}

export function seal(secret: string): Sealed {
    return encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
}

export function unseal(ciphertext: Uint8Array | null, nonce: Uint8Array | null, keyId: string | null): string | null {
    if (!ciphertext || !nonce) return null;
    return decryptSecret(
        { ciphertext: Buffer.from(ciphertext), nonce: Buffer.from(nonce), keyId: keyId ?? "" },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** The username of the recovery administrator pinned during setup. */
export const RECOVERY_USERNAME = "polaris-setup";

/**
 * The credential Polaris manages a server with right now.
 *
 * The administrator account setup created, once it has; until then the
 * recovery administrator whose password is the same sealed secret - setup
 * gives both the one password, so the credential does not change shape
 * between steps.
 */
export function adminCredentials(server: MailServer): StalwartCredentials {
    const password = unseal(server.adminSecret, server.adminSecretNonce, server.adminSecretKeyId);
    if (!password) throw new MailServerAccessError("This mail server has no administrator credential yet. Run setup again.");
    return reached(server.step, "admin")
        ? { username: `${core.MAIL_ADMIN_NAME}@${server.primaryDomain}`, password }
        : { username: RECOVERY_USERNAME, password };
}
