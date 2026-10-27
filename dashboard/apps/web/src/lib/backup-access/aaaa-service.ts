/**
 * Publish this server's IPv6 as AAAA records on the dashboard's names, and take
 * them back down, through the same Cloudflare calls the address follower uses.
 *
 * Cloudflare is the only DNS provider Polaris can write to: a zone at IONOS or
 * anywhere else is named on the screen, never written to.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { getDomainZones, zoneRecords } from "@/lib/domain-zones";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    createAddressRecord,
    deleteDnsRecord,
    findAddressRecords,
    listZones,
    repointRecord,
    zoneForHostname
} from "@/lib/integrations/cloudflare-api";
import { AAAA_KEY, nextAaaa, planAaaaRecords, readAaaaState, type AaaaState } from "./aaaa";

export async function readAaaa(): Promise<AaaaState> {
    return readAaaaState(await getSetting(AAAA_KEY));
}

/**
 * One pass: decide from this check, then bring every web name's AAAA to it.
 * Idempotent: a pass with nothing to change reads the records and writes none.
 */
export async function syncAaaa(input: {
    readonly ipv6: string | null;
    readonly inbound: boolean | null;
}): Promise<AaaaState> {
    const previous = await readAaaa();
    const next = nextAaaa(previous, input);
    // No record of ours left and nothing to write: no call to Cloudflare at all.
    if (!next.published && next.written.length === 0) {
        if (JSON.stringify(next) !== JSON.stringify(previous))
            await setSetting(AAAA_KEY, JSON.stringify(next));
        return next;
    }
    const config = await getDomainZones().catch(() => null);
    const token = await loadCloudflareToken().catch(() => null);
    if (!config?.baseDomain || !token) {
        const blocked: AaaaState = {
            ...next,
            published: null,
            problem: config?.baseDomain ? "no-cloudflare" : null
        };
        await setSetting(AAAA_KEY, JSON.stringify(blocked));
        return blocked;
    }
    try {
        const zone = zoneForHostname(await listZones(token), config.baseDomain);
        if (!zone) {
            const elsewhere: AaaaState = { ...next, published: null, problem: "no-cloudflare" };
            await setSetting(AAAA_KEY, JSON.stringify(elsewhere));
            return elsewhere;
        }
        const zoneId = zone.id;
        const names = zoneRecords(config).flatMap((record) => [record.host, record.wildcard]);
        // Sequential: Cloudflare rate-limits per account.
        for (const name of names) {
            const records = await findAddressRecords(token, zoneId, name);
            for (const op of planAaaaRecords(records, next.published, next.written)) {
                if (op.kind === "delete") await deleteDnsRecord(token, zoneId, op.id);
                else if (op.kind === "repoint")
                    await repointRecord(token, zoneId, op.id, op.content);
                else
                    await createAddressRecord(token, zoneId, {
                        type: "AAAA",
                        name,
                        content: op.content,
                        proxied: false
                    });
            }
        }
    } catch (caught) {
        console.warn(
            `polaris: AAAA records could not be updated: ${caught instanceof Error ? caught.message : String(caught)}`
        );
        // Tried again next pass from what was true before this one.
        // Addresses written this pass stay remembered as ours.
        const failed: AaaaState = { ...previous, written: next.written, problem: "failed" };
        await setSetting(AAAA_KEY, JSON.stringify(failed));
        return failed;
    }
    // Nothing published and every record of ours now gone: forget them, so the
    // next pass makes no call to Cloudflare at all.
    const done: AaaaState = { ...next, written: next.published ? next.written : [], problem: null };
    await setSetting(AAAA_KEY, JSON.stringify(done));
    return done;
}
