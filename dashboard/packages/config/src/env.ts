/**
 * Validated Polaris environment. Every process boundary that reads configuration
 * goes through here so a misconfigured deployment fails fast and loudly instead
 * of surfacing as a confusing runtime error deep in a request. All keys use the
 * repo-wide POLARIS_ prefix.
 */

import { z } from "zod";

/** Accept the usual truthy spellings for boolean flags coming from a shell. */
const boolFromEnv = z
    .string()
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /** Prisma connection string. Postgres in production, SQLite for local/dev. */
    POLARIS_DATABASE_URL: z.string().min(1, "POLARIS_DATABASE_URL is required"),

    /** Public origin the dashboard is served from (used by auth + share links). */
    POLARIS_APP_URL: z.string().url().default("http://localhost:3000"),

    /** better-auth signing secret. Must be set to a long random value in production. */
    POLARIS_AUTH_SECRET: z.string().min(16, "POLARIS_AUTH_SECRET must be at least 16 chars"),

    /**
     * Base64-encoded 32-byte master key for envelope-encrypting stored storage
     * credentials (AES-256-GCM). Rotating it means bumping the key id; old
     * ciphertexts keep decrypting under their recorded key id.
     */
    POLARIS_MASTER_KEY: z.string().min(1, "POLARIS_MASTER_KEY is required"),

    /** Directory for container-local storage and upload scratch space. */
    POLARIS_DATA_DIR: z.string().default("/var/lib/polaris"),

    /** Unix socket the privileged host daemon listens on (full edition only). */
    POLARIS_HOSTD_SOCKET: z.string().default("/run/polaris/hostd.sock"),

    /** File the daemon writes its bearer token to; mounted read-only here. */
    POLARIS_HOSTD_TOKEN_FILE: z.string().default("/run/polaris/hostd.token"),

    /** Optional TCP fallback for platforms without unix-socket sharing. */
    POLARIS_HOSTD_URL: z.string().url().optional(),

    /**
     * CIDRs of reverse proxies whose X-Forwarded-For we trust when resolving a
     * client IP for file-request allowlists and rate limits. Comma-separated.
     * Empty (the safe default) means trust no forwarded header.
     */
    POLARIS_TRUSTED_PROXIES: z
        .string()
        .default("")
        .transform((value) =>
            value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
        ),

    /** Master switch to disable auto-update even in the full edition. */
    POLARIS_AUTO_UPDATE: boolFromEnv.default("true")
});

export type PolarisEnv = z.infer<typeof envSchema>;

let cached: PolarisEnv | undefined;

/**
 * Parse and cache process.env once. Throws a readable aggregated error listing
 * every invalid or missing key so an operator can fix them all in one pass.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): PolarisEnv {
    if (cached) return cached;
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
            .join("\n");
        throw new Error(`Invalid Polaris environment:\n${issues}`);
    }
    cached = parsed.data;
    return cached;
}

/** Reset the cache. Test-only; production loads env exactly once. */
export function resetEnvCache(): void {
    cached = undefined;
}
