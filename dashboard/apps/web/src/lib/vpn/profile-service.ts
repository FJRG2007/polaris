/**
 * The VPNs a person brought with them. Each file holds that person's private key at
 * their provider, so it is sealed at rest, opened only for its owner, and only at the
 * moment the desktop app connects. Nothing here needs VPN access from an administrator:
 * none of it goes through this instance's servers.
 */

import { isIP } from "node:net";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { lookup } from "node:dns/promises";
import { resolveGeo } from "@/lib/geo-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { MAX_PROFILES } from "./profile-limits";
import { parseProfile, profileName, profileSchema, type Profile } from "./profile";

export class ProfileRefusal extends Error {
    constructor(readonly code: "tooMany" | "notFound") {
        super(code);
    }
}

const PLACE_WAIT_MS = 3_000;

export interface ProfileFile {
    readonly name: string;
    readonly text: string;
}

export function profilesOf(userId: string) {
    return prisma.vpnProfile.findMany({
        where: { userId },
        orderBy: { name: "asc" },
        take: MAX_PROFILES,
        select: { id: true, name: true, country: true, city: true }
    });
}

/** Where a server is, when that can be told quickly. The list works without it. */
async function placeOf(profile: Profile): Promise<{ country: string | null; city: string | null }> {
    const nowhere = { country: null, city: null };
    const place = async () => {
        const ip = isIP(profile.endpoint)
            ? profile.endpoint
            : (await lookup(profile.endpoint)).address;
        const { countryCode, city } = await resolveGeo(ip);
        return { country: countryCode, city };
    };
    const late = new Promise<typeof nowhere>((resolve) => {
        setTimeout(() => resolve(nowhere), PLACE_WAIT_MS).unref();
    });
    return Promise.race([place().catch(() => nowhere), late]);
}

/** Keeps every file that reads as a tunnel and names the ones that did not. */
export async function importProfiles(
    userId: string,
    files: readonly ProfileFile[]
): Promise<{ added: number; rejected: string[] }> {
    const read = files.map((file) => ({ file, profile: parseProfile(file.text) }));
    const good = read.flatMap(({ file, profile }) => (profile ? [{ file, profile }] : []));
    const held = await prisma.vpnProfile.count({ where: { userId } });
    if (held + good.length > MAX_PROFILES) throw new ProfileRefusal("tooMany");
    const placed = await Promise.all(good.map(({ profile }) => placeOf(profile)));
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    await prisma.vpnProfile.createMany({
        data: good.map(({ file, profile }, index) => {
            const blob = encryptSecret(JSON.stringify(profile), masterKey);
            return {
                userId,
                name: profileName(file.name),
                encryptedConfig: blob.ciphertext,
                configNonce: blob.nonce,
                configKeyId: blob.keyId,
                country: placed[index]?.country ?? null,
                city: placed[index]?.city ?? null
            };
        })
    });
    return {
        added: good.length,
        rejected: read.filter(({ profile }) => !profile).map(({ file }) => profileName(file.name))
    };
}

export async function removeProfile(userId: string, id: string): Promise<void> {
    const { count } = await prisma.vpnProfile.deleteMany({ where: { id, userId } });
    if (count === 0) throw new ProfileRefusal("notFound");
}

/** The whole tunnel, for its owner's own app. The caller must not log or store it. */
export async function openProfile(userId: string, id: string): Promise<Profile> {
    const row = await prisma.vpnProfile.findFirst({
        where: { id, userId },
        select: { encryptedConfig: true, configNonce: true, configKeyId: true }
    });
    if (!row) throw new ProfileRefusal("notFound");
    const plain = decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedConfig),
            nonce: Buffer.from(row.configNonce),
            keyId: row.configKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return profileSchema.parse(JSON.parse(plain));
}
