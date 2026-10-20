/**
 * Polar connectors in the database, always read and written for their owner.
 *
 * The secret - a bearer token, or the OAuth client, its tokens and an
 * authorization in flight - is one blob envelope-encrypted under the master
 * key, the way `connections/store.ts` keeps a linked account's tokens. Nothing
 * here hands it to a caller that renders: `ConnectorView` carries whether a
 * connector is signed in, never with what. A blob that no longer decrypts (a
 * rotated master key) reads as no secret, so the screen asks to sign in again.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { hostAllowed } from "@/lib/polar/connectors/shared";
import { readPolarPolicy, type PolarConnectorPolicy } from "@/lib/polar/access";
import { CredentialDecryptError, decryptSecret, encryptSecret } from "@polaris/storage";
import * as rules from "@/lib/polar/connectors/policy";

const clientSchema = z.object({
    clientId: z.string(),
    clientSecret: z.string().nullable(),
    tokenEndpoint: z.string(),
    authMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]),
    resource: z.string()
});

const secretSchema = z.object({
    token: z.string().optional(),
    registered: z.object({ clientId: z.string(), clientSecret: z.string().nullable() }).optional(),
    client: clientSchema.optional(),
    tokens: z
        .object({
            accessToken: z.string(),
            refreshToken: z.string().nullable(),
            expiresAt: z.number().nullable()
        })
        .optional(),
    pending: clientSchema
        .extend({
            stateHash: z.string(),
            verifier: z.string(),
            redirectUri: z.string(),
            expiresAt: z.number()
        })
        .optional()
});
export type ConnectorSecret = z.infer<typeof secretSchema>;

export type ConnectorStatus = "new" | "ok" | "sign_in" | "error";

export interface ConnectorRow {
    id: string;
    ownerId: string;
    name: string;
    url: string;
    transport: rules.ConnectorTransport;
    auth: rules.ConnectorAuth;
    enabled: boolean;
    tools: rules.CachedTool[];
    policies: Record<string, rules.ToolPolicy>;
    status: ConnectorStatus;
    lastError: string | null;
    checkedAt: Date | null;
}

/** A connector as the browser may see it. */
export interface ConnectorView {
    id: string;
    name: string;
    url: string;
    transport: rules.ConnectorTransport;
    auth: rules.ConnectorAuth;
    enabled: boolean;
    status: ConnectorStatus;
    lastError: string | null;
    checkedAt: string | null;
    signedIn: boolean;
    tools: {
        name: string;
        title: string;
        description: string;
        readOnly: boolean;
        destructive: boolean;
        policy: rules.ToolPolicy;
    }[];
}

const SELECT = {
    id: true,
    ownerId: true,
    name: true,
    url: true,
    transport: true,
    auth: true,
    enabled: true,
    tools: true,
    toolPolicies: true,
    status: true,
    lastError: true,
    checkedAt: true,
    secret: true,
    secretNonce: true,
    secretKeyId: true
} as const;

type Selected = {
    id: string;
    ownerId: string;
    name: string;
    url: string;
    transport: string;
    auth: string;
    enabled: boolean;
    tools: unknown;
    toolPolicies: unknown;
    status: string;
    lastError: string | null;
    checkedAt: Date | null;
    secret: Uint8Array | null;
    secretNonce: Uint8Array | null;
    secretKeyId: string | null;
};

function toRow(row: Selected): ConnectorRow {
    return {
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        url: row.url,
        transport: row.transport === "sse" ? "sse" : "http",
        auth: row.auth === "bearer" || row.auth === "oauth" ? row.auth : "none",
        enabled: row.enabled,
        tools: rules.readCachedTools(row.tools),
        policies: rules.readToolPolicies(row.toolPolicies),
        status: (["new", "ok", "sign_in", "error"] as const).includes(row.status as ConnectorStatus)
            ? (row.status as ConnectorStatus)
            : "new",
        lastError: row.lastError,
        checkedAt: row.checkedAt
    };
}

function decrypt(row: Pick<Selected, "secret" | "secretNonce" | "secretKeyId">): ConnectorSecret | null {
    if (!row.secret || !row.secretNonce) return null;
    try {
        const plain = decryptSecret(
            {
                ciphertext: Buffer.from(row.secret),
                nonce: Buffer.from(row.secretNonce),
                keyId: row.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        const parsed = secretSchema.safeParse(JSON.parse(plain));
        return parsed.success ? parsed.data : null;
    } catch (caught) {
        if (caught instanceof CredentialDecryptError || caught instanceof SyntaxError) return null;
        throw caught;
    }
}

function encrypt(secret: ConnectorSecret | null) {
    if (!secret) return { secret: null, secretNonce: null, secretKeyId: null };
    const blob = encryptSecret(JSON.stringify(secret), loadEnv().POLARIS_MASTER_KEY);
    return { secret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

export function viewOf(row: ConnectorRow, secret: ConnectorSecret | null): ConnectorView {
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        transport: row.transport,
        auth: row.auth,
        enabled: row.enabled,
        status: row.status,
        lastError: row.lastError,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        signedIn:
            row.auth === "none" ||
            (row.auth === "bearer" ? Boolean(secret?.token) : Boolean(secret?.tokens)),
        tools: row.tools.map((tool) => ({
            name: tool.name,
            title: tool.title ?? tool.name,
            description: tool.description,
            readOnly: tool.readOnly,
            destructive: tool.destructive,
            policy: rules.effectiveToolPolicy(tool, row.policies)
        }))
    };
}

/** The deployment's connector rules. */
export async function connectorPolicy(): Promise<PolarConnectorPolicy> {
    return (await readPolarPolicy()).connectors;
}

/** This person's connectors, with their secrets for the server's own use. */
export async function ownConnectors(
    ownerId: string,
    where: { enabled?: boolean } = {}
): Promise<{ row: ConnectorRow; secret: ConnectorSecret | null }[]> {
    const rows = (await prisma.polarConnector.findMany({
        where: { ownerId, ...where },
        select: SELECT,
        orderBy: { createdAt: "asc" },
        take: rules.CONNECTOR_LIMIT
    })) as Selected[];
    return rows.map((row) => ({ row: toRow(row), secret: decrypt(row) }));
}

export async function ownConnector(
    ownerId: string,
    id: string
): Promise<{ row: ConnectorRow; secret: ConnectorSecret | null } | null> {
    const row = (await prisma.polarConnector.findFirst({
        where: { id, ownerId },
        select: SELECT
    })) as Selected | null;
    return row ? { row: toRow(row), secret: decrypt(row) } : null;
}

export async function listConnectorViews(ownerId: string): Promise<ConnectorView[]> {
    return (await ownConnectors(ownerId)).map(({ row, secret }) => viewOf(row, secret));
}

export type CreateRefusal = "limit" | "duplicate" | "address" | "host";

/** Adds a connector, refusing what the deployment does not allow. */
export async function createConnector(
    ownerId: string,
    input: rules.ConnectorInput,
    policy: PolarConnectorPolicy
): Promise<ConnectorRow | CreateRefusal> {
    const url = rules.canonicalServerUrl(input.url, policy.privateNetwork);
    if (!url) return "address";
    if (!hostAllowed(url, policy.hosts)) return "host";
    const held = await prisma.polarConnector.count({ where: { ownerId } });
    if (held >= rules.CONNECTOR_LIMIT) return "limit";
    const taken = await prisma.polarConnector.findFirst({
        where: { ownerId, name: { equals: input.name, mode: "insensitive" } },
        select: { id: true }
    });
    if (taken) return "duplicate";
    const secret: ConnectorSecret | null =
        input.auth === "bearer"
            ? { token: input.token }
            : input.auth === "oauth" && input.clientId
              ? { registered: { clientId: input.clientId, clientSecret: input.clientSecret ?? null } }
              : null;
    const created = (await prisma.polarConnector.create({
        data: {
            ownerId,
            name: input.name,
            url,
            transport: input.transport,
            auth: input.auth,
            ...encrypt(secret)
        },
        select: SELECT
    })) as Selected;
    return toRow(created);
}

export async function saveSecret(ownerId: string, id: string, secret: ConnectorSecret | null): Promise<void> {
    await prisma.polarConnector.updateMany({ where: { id, ownerId }, data: encrypt(secret) });
}

/** What a check found: the tool list, and whether it could be read. */
export async function recordCheck(
    ownerId: string,
    id: string,
    result: { status: ConnectorStatus; tools?: rules.CachedTool[]; error?: string | null }
): Promise<void> {
    await prisma.polarConnector.updateMany({
        where: { id, ownerId },
        data: {
            status: result.status,
            lastError: result.error ? result.error.slice(0, 300) : null,
            checkedAt: new Date(),
            ...(result.tools ? { tools: result.tools as never } : {})
        }
    });
}

export async function setEnabled(ownerId: string, id: string, enabled: boolean): Promise<boolean> {
    const { count } = await prisma.polarConnector.updateMany({ where: { id, ownerId }, data: { enabled } });
    return count > 0;
}

/** One tool's answer; a name the server never listed is refused. */
export async function setToolPolicy(
    ownerId: string,
    id: string,
    tool: string,
    policy: rules.ToolPolicy
): Promise<boolean> {
    const found = await ownConnector(ownerId, id);
    if (!found || !found.row.tools.some((entry) => entry.name === tool)) return false;
    const policies = { ...found.row.policies, [tool]: policy };
    await prisma.polarConnector.updateMany({
        where: { id, ownerId },
        data: { toolPolicies: policies }
    });
    return true;
}

export async function deleteConnector(ownerId: string, id: string): Promise<boolean> {
    const { count } = await prisma.polarConnector.deleteMany({ where: { id, ownerId } });
    return count > 0;
}
