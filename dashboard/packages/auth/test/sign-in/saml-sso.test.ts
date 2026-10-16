/**
 * SAML sign-in end to end, against the real SSO plugin and a test identity
 * provider whose key pair lives in `test/fixtures` (generated for these tests
 * and used nowhere else).
 *
 * Each case starts the sign-in the way the screen does, answers it with a SAML
 * response signed - or not - by the fixture key, and posts that to the
 * assertion consumer service. The XML signature is verified by the plugin's
 * library; the test only produces one.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SignedXml } from "xml-crypto";
import { betterAuth } from "better-auth";
import { inflateRawSync } from "node:zlib";
import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "http://localhost:3000";
const PROVIDER_ID = "saml-fixture000001";
const IDP_ENTITY = "https://idp.fixture.test/metadata";
const SP_ENTITY = `${BASE}/api/auth/sso/saml2/sp/metadata?providerId=${PROVIDER_ID}`;
const ACS = `${BASE}/api/auth/sso/saml2/sp/acs/${PROVIDER_ID}`;
const KEY = readFileSync(join(__dirname, "../fixtures/test-idp.key"), "utf8");
const CERT = readFileSync(join(__dirname, "../fixtures/test-idp.crt"), "utf8");

interface Policy {
    providerId: string;
    domain: string;
    enforced: boolean;
    domainVerified: boolean;
    allowSignUp: boolean;
}

const state = vi.hoisted(() => ({
    policies: [] as Policy[],
    admins: new Set<string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        ssoProvider: { findMany: async () => state.policies },
        user: {
            findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
                const email =
                    where.email ??
                    (db.user.find((user) => user.id === where.id)?.email as string | undefined);
                return email === undefined ? null : { email, isAdmin: state.admins.has(email) };
            }
        }
    }
}));

const {
    refuseSessionForEnforcedDomain,
    samlSignUpAllowed,
    samlSsoPlugin,
    SSO_ERROR_PATH,
    SSO_REQUIRED_CODE
} = await import("../../src/saml-sso.js");
const { connectionSignInPlugin, CONNECTION_SIGN_IN_PATH } = await import(
    "../../src/connection-sign-in.js"
);

type Db = Record<string, Record<string, unknown>[]>;
let db: Db;
let auth: ReturnType<typeof createTestAuth>;

function createTestAuth() {
    return betterAuth({
        baseURL: BASE,
        secret: "fixture-secret-value-0123456789abcdef",
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        databaseHooks: {
            user: {
                create: { before: async (user, context) => samlSignUpAllowed(user.email, context) }
            },
            session: {
                create: {
                    before: async (session, context) => {
                        if (context?.path === CONNECTION_SIGN_IN_PATH)
                            await refuseSessionForEnforcedDomain(session.userId);
                    }
                }
            }
        },
        plugins: [samlSsoPlugin(), connectionSignInPlugin()]
    });
}

function setProvider(policy: Partial<Policy> = {}): void {
    const row: Policy = {
        providerId: PROVIDER_ID,
        domain: "acme.test",
        enforced: false,
        domainVerified: true,
        allowSignUp: true,
        ...policy
    };
    state.policies = [row];
    db.ssoProvider = [
        {
            id: "11111111-1111-4111-8111-111111111111",
            providerId: PROVIDER_ID,
            issuer: IDP_ENTITY,
            domain: row.domain,
            domainVerified: row.domainVerified,
            userId: null,
            organizationId: null,
            oidcConfig: null,
            samlConfig: JSON.stringify({
                issuer: SP_ENTITY,
                entryPoint: "https://idp.fixture.test/sso",
                cert: CERT,
                callbackUrl: ACS,
                audience: SP_ENTITY,
                idpMetadata: {
                    entityID: IDP_ENTITY,
                    cert: CERT,
                    singleSignOnService: [
                        {
                            Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                            Location: "https://idp.fixture.test/sso"
                        }
                    ]
                },
                spMetadata: { entityID: SP_ENTITY },
                identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                mapping: { id: "nameID", email: "email", name: "displayName" }
            })
        }
    ];
}

function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE },
            body: JSON.stringify(body)
        })
    );
}

/** Starts a sign-in and returns the request id and relay state the IdP is handed. */
async function startSignIn(
    email: string,
    callbackURL = "/drive"
): Promise<{ requestId: string; relayState: string }> {
    const response = await post("/sign-in/sso", { email, callbackURL });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    const request = inflateRawSync(
        Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")
    ).toString("utf8");
    const requestId = /ID="([^"]+)"/.exec(request)?.[1] ?? "";
    expect(requestId).not.toBe("");
    return { requestId, relayState: url.searchParams.get("RelayState") ?? "" };
}

let counter = 0;

/** A SAML response for `email`, its assertion signed with the fixture key unless told not to. */
function samlResponse(
    email: string,
    requestId: string,
    options: { sign?: boolean; audience?: string; now?: Date } = {}
): string {
    counter += 1;
    const now = options.now ?? new Date();
    const later = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const before = new Date(now.getTime() - 60 * 1000).toISOString();
    const issued = now.toISOString();
    const xml =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp${counter}" Version="2.0" IssueInstant="${issued}" Destination="${ACS}" InResponseTo="${requestId}">` +
        `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        `<saml:Assertion ID="_assert${counter}" Version="2.0" IssueInstant="${issued}">` +
        `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${ACS}" InResponseTo="${requestId}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? SP_ENTITY}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="_session${counter}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Fixture Person</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion></samlp:Response>`;
    if (options.sign === false) return Buffer.from(xml).toString("base64");
    const signer = new SignedXml({
        privateKey: KEY,
        publicCert: CERT,
        signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
        canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#"
    });
    signer.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
        transforms: [
            "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
            "http://www.w3.org/2001/10/xml-exc-c14n#"
        ]
    });
    signer.computeSignature(xml, {
        location: {
            reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
            action: "after"
        }
    });
    return Buffer.from(signer.getSignedXml()).toString("base64");
}

function acs(SAMLResponse: string, RelayState: string): Promise<Response> {
    return auth.handler(
        new Request(ACS, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ SAMLResponse, RelayState }).toString()
        })
    );
}

function signedIn(response: Response): boolean {
    return response.headers
        .getSetCookie()
        .some(
            (cookie) =>
                cookie.startsWith("better-auth.session_token=") && !cookie.includes("Max-Age=0")
        );
}

beforeEach(() => {
    db = { user: [], session: [], account: [], verification: [], ssoProvider: [] };
    state.admins = new Set();
    auth = createTestAuth();
    setProvider();
});

describe("SAML assertion", () => {
    it("signs a person in with a signed assertion and lands on the requested path", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const response = await acs(samlResponse("ana@acme.test", requestId), relayState);
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get("location") ?? "", BASE).href).toBe(`${BASE}/drive`);
        expect(signedIn(response)).toBe(true);
        expect(db.user.map((user) => user.email)).toEqual(["ana@acme.test"]);
    });

    it("refuses an unsigned assertion", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const response = await acs(
            samlResponse("ana@acme.test", requestId, { sign: false }),
            relayState
        );
        expect(signedIn(response)).toBe(false);
        expect(response.headers.get("location") ?? "").toContain("error=");
        expect(db.user).toHaveLength(0);
    });

    it("refuses an assertion altered after it was signed", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const signed = Buffer.from(samlResponse("ana@acme.test", requestId), "base64").toString(
            "utf8"
        );
        const tampered = signed.replaceAll("ana@acme.test", "boss@acme.test");
        const response = await acs(Buffer.from(tampered).toString("base64"), relayState);
        expect(signedIn(response)).toBe(false);
        expect(db.user).toHaveLength(0);
    });

    it("refuses an assertion past its validity window", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const response = await acs(
            samlResponse("ana@acme.test", requestId, { now: hourAgo }),
            relayState
        );
        expect(signedIn(response)).toBe(false);
        expect(db.user).toHaveLength(0);
    });

    it("refuses a response to a request this deployment never made", async () => {
        const { relayState } = await startSignIn("ana@acme.test");
        const response = await acs(samlResponse("ana@acme.test", "_never-issued"), relayState);
        expect(signedIn(response)).toBe(false);
        expect(response.headers.get("location") ?? "").toContain(SSO_ERROR_PATH);
        expect(db.user).toHaveLength(0);
    });

    it("refuses an assertion meant for another service provider", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const response = await acs(
            samlResponse("ana@acme.test", requestId, { audience: "https://other.example/sp" }),
            relayState
        );
        expect(signedIn(response)).toBe(false);
        expect(db.user).toHaveLength(0);
    });

    it("refuses the same response a second time", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const signed = samlResponse("ana@acme.test", requestId);
        expect(signedIn(await acs(signed, relayState))).toBe(true);
        const replay = await acs(signed, relayState);
        expect(signedIn(replay)).toBe(false);
    });
});

describe("just-in-time accounts", () => {
    it("creates no account when the provider does not allow it", async () => {
        setProvider({ allowSignUp: false });
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const response = await acs(samlResponse("ana@acme.test", requestId), relayState);
        expect(signedIn(response)).toBe(false);
        expect(db.user).toHaveLength(0);
    });

    it("creates no account for an address outside the provider's domains", async () => {
        const { requestId, relayState } = await startSignIn("ana@acme.test");
        const response = await acs(samlResponse("mallory@elsewhere.test", requestId), relayState);
        expect(signedIn(response)).toBe(false);
        expect(db.user).toHaveLength(0);
    });
});

describe("sign-in requests", () => {
    it("refuses a return address that leaves the deployment", async () => {
        for (const callbackURL of ["https://evil.example/x", "//evil.example", "/\\evil.example"]) {
            expect(
                (await post("/sign-in/sso", { email: "ana@acme.test", callbackURL })).status
            ).toBe(400);
        }
        expect(
            (
                await post("/sign-in/sso", {
                    email: "ana@acme.test",
                    callbackURL: "/drive",
                    errorCallbackURL: "https://evil.example"
                })
            ).status
        ).toBe(400);
    });

    it("keeps the plugin's provider management endpoints closed", async () => {
        const response = await post("/sso/register", {
            providerId: "saml-x",
            issuer: "x",
            domain: "evil.test"
        });
        expect(response.status).toBe(404);
    });
});

describe("enforced domains", () => {
    async function passwordSignIn(email: string): Promise<Response> {
        return post("/sign-in/email", { email, password: "Fixture-Password-123" });
    }

    beforeEach(async () => {
        await auth.api.signUpEmail({
            body: { email: "outside@other.test", password: "Fixture-Password-123", name: "Outside" }
        });
        setProvider({ enforced: true, allowSignUp: true });
        await auth.api.signUpEmail({
            body: { email: "root@acme.test", password: "Fixture-Password-123", name: "Root" }
        });
    });

    it("refuses a password for an address in an enforced domain", async () => {
        const response = await passwordSignIn("ana@acme.test");
        expect(response.status).toBe(403);
        expect(((await response.json()) as { code?: string }).code).toBe(SSO_REQUIRED_CODE);
    });

    it("keeps the password for a platform administrator", async () => {
        state.admins.add("root@acme.test");
        expect((await passwordSignIn("root@acme.test")).status).toBe(200);
    });

    it("leaves other domains and unverified providers alone", async () => {
        expect((await passwordSignIn("outside@other.test")).status).toBe(200);
        setProvider({ enforced: true, domainVerified: false });
        expect((await passwordSignIn("root@acme.test")).status).toBe(200);
    });

    async function connectionSignIn(email: string): Promise<unknown> {
        const userId = db.user.find((user) => user.email === email)?.id as string;
        const api = auth.api as unknown as {
            polarisConnectionSignIn(input: {
                body: { userId: string; provider: string; challenge: boolean };
                headers: Headers;
            }): Promise<unknown>;
        };
        return api
            .polarisConnectionSignIn({
                body: { userId, provider: "github", challenge: false },
                headers: new Headers()
            })
            .then(
                () => null,
                (error: { body?: { code?: string } }) => error.body?.code ?? "failed"
            );
    }

    it("refuses every other way in for an address in an enforced domain", async () => {
        const sessions = db.session.length;
        expect(await connectionSignIn("root@acme.test")).toBe(SSO_REQUIRED_CODE);
        expect(db.session).toHaveLength(sessions);
    });

    it("keeps the other ways in for an administrator and for other domains", async () => {
        state.admins.add("root@acme.test");
        expect(await connectionSignIn("root@acme.test")).toBeNull();
        expect(await connectionSignIn("outside@other.test")).toBeNull();
    });
});
