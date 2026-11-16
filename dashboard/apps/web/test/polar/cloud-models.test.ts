import { describe, expect, it } from "vitest";
import { signAwsRequest } from "@/lib/integrations/aws-sign";
import { cloudCredentialSchema } from "@/lib/agents/cloud-credentials";
import { forgetCloudTokens, type TokenFetch } from "@/lib/agents/cloud-tokens";
import {
    bedrockCanonicalPath,
    bedrockSigningFetch,
    checkCloudCredential,
    cloudListsModel,
    snowflakeBody,
    vertexBase
} from "@/lib/polar/cloud-models";

const keys = {
    provider: "amazon-bedrock" as const,
    method: "keys" as const,
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1"
};

describe("Bedrock SigV4", () => {
    it("signs each path segment encoded once more than it is sent", () => {
        expect(bedrockCanonicalPath("/model/anthropic.claude-v1%3A0/converse-stream")).toBe(
            "/model/anthropic.claude-v1%253A0/converse-stream"
        );
    });

    it("replaces the placeholder bearer with a signature over the sent request", async () => {
        const now = new Date("2026-11-16T12:00:00Z");
        let sent: { url: string; headers: Headers } | null = null;
        const request: TokenFetch = async (url, init) => {
            sent = { url, headers: new Headers(init.headers) };
            return new Response("{}");
        };
        const signed = bedrockSigningFetch(keys, request, () => now);
        const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v1%3A0/converse";
        const body = JSON.stringify({ messages: [] });
        await signed(url, {
            method: "POST",
            headers: { authorization: "Bearer sigv4", "content-type": "application/json" },
            body
        });
        const expected = signAwsRequest({
            credentials: keys,
            service: "bedrock",
            host: "bedrock-runtime.us-east-1.amazonaws.com",
            path: "/model/anthropic.claude-v1%3A0/converse",
            canonicalPath: "/model/anthropic.claude-v1%253A0/converse",
            body,
            now
        });
        expect(sent!.url).toBe(url);
        expect(sent!.headers.get("authorization")).toBe(expected.headers.authorization);
        expect(sent!.headers.get("authorization")).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261116\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
        );
        expect(sent!.headers.get("x-amz-date")).toBe("20261116T120000Z");
    });
});

describe("cloud model lists", () => {
    it("keeps Vertex to Google's own models and Azure to its deployments", () => {
        expect(cloudListsModel("google-vertex", "gemini-2.5-flash")).toBe(true);
        expect(cloudListsModel("google-vertex", "claude-opus-4-8@default")).toBe(false);
        expect(cloudListsModel("azure", "gpt-5.4")).toBe(false);
        expect(cloudListsModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-6")).toBe(true);
    });

    it("points Vertex at the project's Google publisher", () => {
        const credential = cloudCredentialSchema.parse({
            provider: "google-vertex",
            method: "service-account",
            serviceAccount: {
                type: "service_account",
                project_id: "my-project",
                private_key: "PRIVATE KEY",
                client_email: "a@b.iam.gserviceaccount.com"
            },
            project: "my-project",
            location: "us-central1"
        });
        if (credential.provider !== "google-vertex") throw new Error("parse");
        expect(vertexBase(credential)).toBe(
            "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-project/locations/us-central1/publishers/google"
        );
    });
});

describe("checking a new cloud account", () => {
    it("lists Azure deployments with the key and keeps them with the typed ones", async () => {
        forgetCloudTokens();
        const seen: Array<{ url: string; key: string | null }> = [];
        const request: TokenFetch = async (url, init) => {
            seen.push({ url, key: new Headers(init.headers).get("api-key") });
            return new Response(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "mini" }] }));
        };
        const credential = cloudCredentialSchema.parse({
            provider: "azure",
            method: "key",
            endpoint: "res",
            apiKey: "k",
            deployments: ["mini", "typed"]
        });
        const result = await checkCloudCredential(credential, request);
        expect(seen).toEqual([{ url: "https://res.openai.azure.com/openai/deployments?api-version=2022-12-01", key: "k" }]);
        expect(result.ok && result.credential.provider === "azure" && result.credential.deployments).toEqual([
            "mini",
            "typed",
            "gpt-5"
        ]);
    });

    it("reports a refused Azure key and a resource with nothing deployed", async () => {
        const credential = cloudCredentialSchema.parse({ provider: "azure", method: "key", endpoint: "res", apiKey: "k" });
        expect(await checkCloudCredential(credential, async () => new Response("", { status: 401 }))).toEqual({
            ok: false,
            reason: "refused"
        });
        expect(
            await checkCloudCredential(credential, async () => new Response(JSON.stringify({ data: [] })))
        ).toEqual({ ok: false, reason: "no-deployments" });
    });

    it("checks a DigitalOcean token against the model list", async () => {
        const credential = cloudCredentialSchema.parse({ provider: "digitalocean", method: "key", token: "t" });
        let asked = "";
        const result = await checkCloudCredential(credential, async (url, init) => {
            asked = `${url} ${new Headers(init.headers).get("authorization")}`;
            return new Response("", { status: 401 });
        });
        expect(asked).toBe("https://inference.do-ai.run/v1/models Bearer t");
        expect(result).toEqual({ ok: false, reason: "refused" });
    });
});

describe("Snowflake Cortex request body", () => {
    it("sends max_completion_tokens in place of the refused max_tokens", () => {
        expect(snowflakeBody({ model: "m", max_tokens: 1024 })).toEqual({ model: "m", max_completion_tokens: 1024 });
        expect(snowflakeBody({ model: "m" })).toEqual({ model: "m" });
        expect(snowflakeBody({ model: "m", max_tokens: undefined })).toEqual({ model: "m" });
    });
});
