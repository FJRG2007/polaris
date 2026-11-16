import { describe, expect, it } from "vitest";
import * as cloud from "@/lib/agents/cloud-credentials";
import { spendableSecret } from "@/lib/agents/provider-oauth";

const bedrockKeys = {
    provider: "amazon-bedrock",
    method: "keys",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "",
    region: " US-EAST-1 "
};

describe("cloud credential schema", () => {
    it("normalises a Bedrock access key and drops an empty session token", () => {
        const parsed = cloud.cloudCredentialSchema.parse(bedrockKeys);
        expect(parsed).toMatchObject({ region: "us-east-1" });
        expect("sessionToken" in parsed && parsed.sessionToken).toBeFalsy();
    });

    it("refuses what is not an AWS key id or region", () => {
        expect(cloud.cloudCredentialSchema.safeParse({ ...bedrockKeys, accessKeyId: "nope" }).success).toBe(false);
        expect(cloud.cloudCredentialSchema.safeParse({ ...bedrockKeys, region: "mars" }).success).toBe(false);
    });

    it("holds Azure to Azure's own hosts", () => {
        expect(cloud.azureEndpoint("my-resource")).toBe("https://my-resource.openai.azure.com");
        expect(cloud.azureEndpoint("https://My-Res.cognitiveservices.azure.com/openai/v1/")).toBe(
            "https://my-res.cognitiveservices.azure.com"
        );
        expect(cloud.azureEndpoint("https://xy.services.ai.azure.com")).toBe("https://xy.services.ai.azure.com");
        expect(cloud.azureEndpoint("http://x.openai.azure.com")).toBeNull();
        expect(cloud.azureEndpoint("https://x.openai.azure.com.evil.example")).toBeNull();
        expect(cloud.azureEndpoint("https://169.254.169.254")).toBeNull();
        expect(cloud.azureEndpoint("https://x.openai.azure.com:8443")).toBeNull();
    });

    it("takes Entra client credentials with a GUID client id", () => {
        const base = {
            provider: "azure",
            method: "entra",
            endpoint: "res",
            tenantId: "contoso.onmicrosoft.com",
            clientSecret: "s"
        };
        expect(
            cloud.cloudCredentialSchema.safeParse({ ...base, clientId: "00000000-0000-4000-8000-000000000000" }).success
        ).toBe(true);
        expect(cloud.cloudCredentialSchema.safeParse({ ...base, clientId: "app" }).success).toBe(false);
    });

    it("cuts a Snowflake address back to its account identifier", () => {
        expect(cloud.snowflakeAccount("https://MyOrg_MyAccount.snowflakecomputing.com/")).toBe("myorg-myaccount");
        const parsed = cloud.cloudCredentialSchema.safeParse({
            provider: "snowflake-cortex",
            method: "pat",
            account: "evil.example/x",
            token: "t"
        });
        expect(parsed.success && parsed.data.provider === "snowflake-cortex" && parsed.data.account).toBe(
            "evil.example"
        );
        expect(
            cloud.cloudCredentialSchema.safeParse({ provider: "snowflake-cortex", method: "pat", account: "a b", token: "t" })
                .success
        ).toBe(false);
    });

    it("needs a whole service account for Vertex", () => {
        const account = {
            type: "service_account",
            project_id: "my-project",
            private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
            client_email: "bot@my-project.iam.gserviceaccount.com"
        };
        const base = { provider: "google-vertex", method: "service-account", project: "my-project", location: "global" };
        expect(cloud.cloudCredentialSchema.safeParse({ ...base, serviceAccount: account }).success).toBe(true);
        expect(
            cloud.cloudCredentialSchema.safeParse({ ...base, serviceAccount: { ...account, type: "authorized_user" } }).success
        ).toBe(false);
        expect(cloud.cloudCredentialSchema.safeParse({ ...base, serviceAccount: account, location: "../x" }).success).toBe(
            false
        );
    });

    it("maps Vertex locations to their hosts", () => {
        expect(cloud.vertexHost("global")).toBe("aiplatform.googleapis.com");
        expect(cloud.vertexHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
        expect(cloud.vertexHost("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
    });
});

describe("stored cloud secret", () => {
    it("round-trips and is told apart from a key or a login", () => {
        const credential = cloud.cloudCredentialSchema.parse(bedrockKeys);
        const secret = cloud.writeCloudSecret(credential);
        expect(cloud.readCloudSecret(secret)).toEqual(credential);
        expect(cloud.readCloudSecret("sk-plain")).toBeNull();
        expect(cloud.readCloudSecret(JSON.stringify({ kind: "oauth", access: "a", refresh: "", expires: 0 }))).toBeNull();
    });

    it("hints with the key id, never the secret, and hands runs only a bearer", () => {
        const credential = cloud.cloudCredentialSchema.parse(bedrockKeys);
        expect(cloud.cloudBearer(credential)).toBeNull();
        expect(cloud.cloudHintSource(credential)).toBe("AKIAIOSFODNN7EXAMPLE");
        expect(spendableSecret(cloud.writeCloudSecret(credential))).toBe("AKIAIOSFODNN7EXAMPLE");
        const pat = cloud.cloudCredentialSchema.parse({ provider: "snowflake-cortex", method: "pat", account: "a", token: "pat" });
        expect(cloud.cloudBearer(pat)).toBe("pat");
    });
});

describe("DigitalOcean sign-in", () => {
    it("asks for OpenCode's application, scopes and loopback return", () => {
        const url = new URL(cloud.digitaloceanAuthorizeUrl("st"));
        expect(url.origin + url.pathname).toBe("https://cloud.digitalocean.com/v1/oauth/authorize");
        expect(url.searchParams.get("response_type")).toBe("token");
        expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1456/auth/callback");
        expect(url.searchParams.get("scope")).toBe("genai:read inference:query");
        expect(url.searchParams.get("state")).toBe("st");
    });

    it("reads the token from the address pasted back, checking the state", () => {
        const now = 1_000;
        const pasted = "http://localhost:1456/auth/callback#access_token=tok&expires_in=3600&state=st";
        expect(cloud.readDigitaloceanReturn(pasted, "st", now)).toEqual({ ok: true, token: "tok", expires: now + 3_600_000 });
        expect(cloud.readDigitaloceanReturn(pasted, "other", now)).toEqual({ ok: false, reason: "bad-paste" });
        expect(cloud.readDigitaloceanReturn("not a url", "st", now)).toEqual({ ok: false, reason: "bad-paste" });
        expect(
            cloud.readDigitaloceanReturn("http://localhost:1456/auth/callback#error=access_denied&state=st", "st", now)
        ).toEqual({ ok: false, reason: "denied" });
    });
});
