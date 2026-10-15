/**
 * One key's usage (/account/api-keys/<id>/usage).
 *
 * Read from this account's own keys, so a URL naming somebody else's key is a
 * page that does not exist. The page itself only reads the key's row; the
 * counts load in the browser behind skeletons, so the heading, the last use and
 * the period picker paint first.
 */

import { notFound } from "next/navigation";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { KeyUsageView } from "./key-usage-view";

export const dynamic = "force-dynamic";

export default async function ApiKeyUsagePage({ params }: { params: Promise<{ keyId: string }> }) {
    const { keyId } = await params;
    const user = await requireUser();
    if (!/^[0-9a-f-]{36}$/i.test(keyId)) notFound();
    const key = await prisma.apiKey.findFirst({
        where: { id: keyId, userId: user.id },
        select: {
            id: true,
            name: true,
            prefix: true,
            lastUsedAt: true,
            lastUsedIp: true,
            lastUsedUserAgent: true
        }
    });
    if (!key) notFound();

    return (
        <KeyUsageView
            apiKey={{
                id: key.id,
                name: key.name,
                prefix: key.prefix,
                lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
                lastUsedIp: key.lastUsedIp,
                lastUsedUserAgent: key.lastUsedUserAgent
            }}
        />
    );
}
