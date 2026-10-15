/**
 * A Google service account's signed assertion, exchanged for an access token.
 *
 * The OAuth 2.0 flow for server-to-server applications: an RS256 JWT naming the
 * service account, the scope and the token endpoint, signed with the account's
 * private key, posted as `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 *
 * Building the assertion is pure; only `googleAccessToken` makes a call.
 */

import { z } from "zod";
import { callJson } from "../http";
import { createSign } from "node:crypto";

/** The fields of a service-account key file this app reads. */
export const serviceAccountSchema = z.object({
    type: z.literal("service_account"),
    project_id: z.string().min(1).max(100),
    // Signed into the assertion exactly as Google issued it. enigma:allow-raw-email
    client_email: z.string().email().max(320),
    private_key: z.string().min(100).max(10_000).includes("PRIVATE KEY"),
    token_uri: z.literal("https://oauth2.googleapis.com/token").optional()
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** The signed JWT. Valid for an hour, the most Google accepts. */
export function buildAssertion(account: ServiceAccount, scope: string, now: Date): string {
    const iat = Math.floor(now.getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
        JSON.stringify({
            iss: account.client_email,
            scope,
            aud: GOOGLE_TOKEN_URL,
            iat,
            exp: iat + 3600
        })
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    token_type: z.string()
});

/** An access token for the Compute Engine scope. */
export async function googleAccessToken(account: ServiceAccount): Promise<{ token: string; expiresAt: number }> {
    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: buildAssertion(account, COMPUTE_SCOPE, new Date())
    });
    const answer = await callJson(tokenSchema, GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
    });
    return { token: answer.access_token, expiresAt: Date.now() + answer.expires_in * 1000 };
}
