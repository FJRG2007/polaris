"use server";

/**
 * Checking the audit trail's chain on demand.
 *
 * The daily pass already does this; the button is for the moment somebody needs
 * the answer now - before handing an export to an auditor, or after something
 * about the database looked wrong. Recorded like everything else, with what it
 * found.
 */

import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { verifyAuditChain, type ChainVerification } from "@/lib/audit-chain";

export async function verifyAuditChainAction(): Promise<{
    result?: ChainVerification;
    error?: string;
}> {
    const user = await requireAdmin();
    try {
        const result = await verifyAuditChain();
        await recordAudit({
            actorId: user.id,
            action: "audit.verify",
            metadata: { ok: result.ok, checked: result.checked, ...(result.broken ? { brokenAt: result.broken.seq } : {}) }
        });
        return { result };
    } catch (caught) {
        console.error("polaris: the audit chain could not be verified:", caught);
        return { error: "The chain could not be checked just now. Try again in a minute." };
    }
}
