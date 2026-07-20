/**
 * Private container-registry credentials. Owner-scoped, one login per registry
 * host, with the password envelope-encrypted at rest (the same AES-256-GCM master
 * key that protects other secrets). A deploy resolves the credential whose registry
 * matches the image being pulled and `docker login`s before the pull.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";

export interface RegistryCredentialView {
    id: string;
    registry: string;
    username: string;
    updatedAt: string;
}

/** Public (password-free) list of an owner's registry logins. */
export async function listRegistryCredentials(ownerId: string): Promise<RegistryCredentialView[]> {
    const rows = await prisma.registryCredential.findMany({
        where: { ownerId },
        orderBy: { registry: "asc" },
        select: { id: true, registry: true, username: true, updatedAt: true }
    });
    return rows.map((row) => ({
        id: row.id,
        registry: row.registry,
        username: row.username,
        updatedAt: row.updatedAt.toISOString()
    }));
}

/** Normalize a registry host: lowercased, no scheme or trailing slash. Empty maps
 *  to Docker Hub ("docker.io"). */
export function normalizeRegistry(input: string): string {
    const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return trimmed || "docker.io";
}

/** Create or update the login for a registry host (password replaced when given). */
export async function upsertRegistryCredential(
    ownerId: string,
    input: { registry: string; username: string; password: string }
): Promise<void> {
    const registry = normalizeRegistry(input.registry);
    const username = input.username.trim();
    if (!username) throw new Error("A username is required");
    if (!input.password) throw new Error("A password or token is required");
    const blob = encryptSecret(input.password, loadEnv().POLARIS_MASTER_KEY);
    await prisma.registryCredential.upsert({
        where: { ownerId_registry: { ownerId, registry } },
        create: {
            ownerId,
            registry,
            username,
            encryptedPassword: blob.ciphertext,
            passwordNonce: blob.nonce,
            passwordKeyId: blob.keyId
        },
        update: {
            username,
            encryptedPassword: blob.ciphertext,
            passwordNonce: blob.nonce,
            passwordKeyId: blob.keyId
        }
    });
}

/** Remove a registry login the owner owns. */
export async function deleteRegistryCredential(id: string, ownerId: string): Promise<void> {
    await prisma.registryCredential.deleteMany({ where: { id, ownerId } });
}

/** The registry host an image reference pulls from ("docker.io" when implicit). */
export function registryHostOfImage(image: string): string {
    const first = image.split("/")[0] ?? "";
    // A registry host has a dot, a colon (port), or is localhost; otherwise the
    // image is a Docker Hub short name (e.g. "nginx:latest").
    if (first.includes(".") || first.includes(":") || first === "localhost") return first.toLowerCase();
    return "docker.io";
}

/**
 * Resolve the login to use for an image, or null if none is stored for its
 * registry. The returned `registry` is passed to `docker login` ("docker.io"
 * becomes an empty string, which targets Docker Hub).
 */
export async function resolveRegistryLogin(
    ownerId: string,
    image: string
): Promise<{ registry: string; username: string; password: string } | null> {
    const host = registryHostOfImage(image);
    const row = await prisma.registryCredential.findUnique({
        where: { ownerId_registry: { ownerId, registry: host } }
    });
    if (!row) return null;
    try {
        const password = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedPassword),
                nonce: Buffer.from(row.passwordNonce),
                keyId: row.passwordKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return { registry: host === "docker.io" ? "" : host, username: row.username, password };
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}
