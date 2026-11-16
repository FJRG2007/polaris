import { beforeEach, describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
    AZURE_COGNITIVE_SCOPE,
    CloudTokenError,
    GOOGLE_TOKEN_URL,
    entraToken,
    forgetCloudTokens,
    googleServiceToken,
    serviceAccountAssertion,
    type TokenFetch
} from "@/lib/agents/cloud-tokens";

function recorder(answer: () => Response) {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const request: TokenFetch = async (url, init) => {
        calls.push({ url, body: new URLSearchParams(String(init.body)) });
        return answer();
    };
    return { calls, request };
}

const ok = (token: string, expiresIn = 3600) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), { status: 200 });

const client = { tenantId: "contoso.onmicrosoft.com", clientId: "00000000-0000-4000-8000-000000000000", clientSecret: "s" };

beforeEach(() => forgetCloudTokens());

describe("Entra client credentials", () => {
    it("asks the tenant's v2.0 endpoint for the Cognitive Services scope", async () => {
        const { calls, request } = recorder(() => ok("entra-1"));
        expect(await entraToken(client, request, 0)).toBe("entra-1");
        expect(calls[0]!.url).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
        expect(Object.fromEntries(calls[0]!.body)).toEqual({
            client_id: client.clientId,
            client_secret: "s",
            scope: AZURE_COGNITIVE_SCOPE,
            grant_type: "client_credentials"
        });
    });

    it("reuses a token until five minutes before it ends, then asks again", async () => {
        let n = 0;
        const { calls, request } = recorder(() => ok(`entra-${++n}`));
        await entraToken(client, request, 0);
        expect(await entraToken(client, request, 54 * 60_000)).toBe("entra-1");
        expect(await entraToken(client, request, 56 * 60_000)).toBe("entra-2");
        expect(calls).toHaveLength(2);
    });

    it("shares one request between concurrent turns", async () => {
        const { calls, request } = recorder(() => ok("entra-1"));
        const [a, b] = await Promise.all([entraToken(client, request, 0), entraToken(client, request, 0)]);
        expect([a, b]).toEqual(["entra-1", "entra-1"]);
        expect(calls).toHaveLength(1);
    });

    it("says refused for a rejected secret and does not keep the failure", async () => {
        const { calls, request } = recorder(() => new Response('{"error":"invalid_client"}', { status: 401 }));
        await expect(entraToken(client, request, 0)).rejects.toEqual(new CloudTokenError("refused"));
        await expect(entraToken(client, request, 0)).rejects.toBeInstanceOf(CloudTokenError);
        expect(calls).toHaveLength(2);
    });
});

describe("Google service account", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = {
        client_email: "bot@my-project.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        private_key_id: "kid-1"
    };

    it("signs an RS256 assertion for the cloud-platform scope", () => {
        const jwt = serviceAccountAssertion(account, 1_700_000_000_000);
        const [header, claims, signature] = jwt.split(".");
        expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
        expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
            iss: account.client_email,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            aud: GOOGLE_TOKEN_URL,
            iat: 1_700_000_000,
            exp: 1_700_003_600
        });
        const verified = createVerify("RSA-SHA256")
            .update(`${header}.${claims}`)
            .verify(publicKey, Buffer.from(signature!, "base64url"));
        expect(verified).toBe(true);
    });

    it("trades the assertion at Google's token endpoint", async () => {
        const { calls, request } = recorder(() => ok("ya29.token"));
        expect(await googleServiceToken(account, request, 0)).toBe("ya29.token");
        expect(calls[0]!.url).toBe(GOOGLE_TOKEN_URL);
        expect(calls[0]!.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        expect(calls[0]!.body.get("assertion")?.split(".")).toHaveLength(3);
    });

    it("refuses a private key that does not parse without asking Google", async () => {
        const { calls, request } = recorder(() => ok("never"));
        await expect(googleServiceToken({ ...account, private_key: "PRIVATE KEY" }, request, 0)).rejects.toEqual(
            new CloudTokenError("refused")
        );
        expect(calls).toHaveLength(0);
    });
});
