/**
 * Whose provider account a run spends.
 *
 * Two accounts can hold a key for the same provider - the person whose
 * repositories the runs belong to, and the administrator who set the deployment
 * up - and getting the order wrong is not a display bug. A personal key that the
 * deployment's could override would be a setting with no effect; a deployment
 * key spent by somebody an administrator excluded is somebody else's bill.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    ownKeys: [] as Array<{ provider: string }>,
    ownSecrets: new Map<string, string>(),
    instanceStates: new Map<string, { enabled: boolean; hasSecret: boolean; config: Record<string, unknown> }>(),
    instanceSecrets: new Map<string, string>(),
    shared: true,
    touched: [] as string[]
};

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: {
            findMany: vi.fn(async () => state.ownKeys),
            findUnique: vi.fn(async ({ where }: { where: { userId_provider: { provider: string } } }) => {
                const provider = where.userId_provider.provider;
                return state.ownSecrets.has(provider)
                    ? { encryptedSecret: Buffer.from(provider), secretNonce: Buffer.from("n"), secretKeyId: "k", config: "{}" }
                    : null;
            }),
            updateMany: vi.fn(async ({ where }: { where: { provider: { in: string[] } } }) => {
                state.touched.push(...where.provider.in);
                return { count: where.provider.in.length };
            }),
            upsert: vi.fn(async () => undefined),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test" }) }));

class FakeDecryptError extends Error {}

vi.mock("@polaris/storage", () => ({
    // The envelope is not what is under test; the resolution order is. Decrypt
    // hands back whatever the fake row carried, and refuses the way the real one
    // does when it cannot - which is a throw, not a null.
    encryptSecret: (value: string) => ({ ciphertext: Buffer.from(value), nonce: Buffer.from("n"), keyId: "k" }),
    decryptSecret: (blob: { ciphertext: Buffer }) => {
        const secret = state.ownSecrets.get(blob.ciphertext.toString());
        if (secret === undefined) throw new FakeDecryptError("wrong master key");
        return secret;
    },
    CredentialDecryptError: FakeDecryptError
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => (state.shared ? "on" : "off"),
    setSetting: async () => undefined
}));

vi.mock("@/lib/integration-service", () => ({
    listIntegrationStates: async () => state.instanceStates,
    getIntegrationSecret: async (slug: string) => state.instanceSecrets.get(slug) ?? null
}));

const { keySourcesFor, runSecretsFor } = await import("@/lib/agents/user-model-keys");

beforeEach(() => {
    state.ownKeys = [];
    state.ownSecrets = new Map();
    state.instanceStates = new Map();
    state.instanceSecrets = new Map();
    state.shared = true;
    state.touched = [];
});

function instanceHas(slug: string, secret: string): void {
    state.instanceStates.set(slug, { enabled: true, hasSecret: true, config: {} });
    state.instanceSecrets.set(slug, secret);
}

function ownHas(slug: string, secret: string): void {
    state.ownKeys.push({ provider: slug });
    state.ownSecrets.set(slug, secret);
}

describe("runSecretsFor", () => {
    it("prefers the person's own key over the deployment's", async () => {
        ownHas("anthropic", "sk-mine");
        instanceHas("anthropic", "sk-theirs");
        const secrets = await runSecretsFor("user-1");
        expect(secrets?.ANTHROPIC_API_KEY).toBe("sk-mine");
    });

    it("falls back to the deployment's for a provider they have not brought", async () => {
        instanceHas("groq", "gsk-theirs");
        expect((await runSecretsFor("user-1"))?.GROQ_API_KEY).toBe("gsk-theirs");
    });

    it("does not hand over the deployment's keys once sharing is off", async () => {
        // The whole point of the switch: an administrator who turns it off is
        // saying nobody else spends these accounts.
        state.shared = false;
        instanceHas("groq", "gsk-theirs");
        expect(await runSecretsFor("user-1")).toEqual({});
    });

    it("still hands over the person's own keys when sharing is off", async () => {
        state.shared = false;
        ownHas("anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const secrets = await runSecretsFor("user-1");
        expect(secrets).toEqual({ ANTHROPIC_API_KEY: "sk-mine" });
    });

    it("hands over every provider that resolves, not only one", async () => {
        // The agent CLIs substitute a model themselves when one is unreachable;
        // one key would turn a recoverable substitution into a failed run.
        ownHas("anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const secrets = await runSecretsFor("user-1");
        expect(Object.keys(secrets ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "GROQ_API_KEY"]);
    });

    it("records that a personal key was used, and only the personal ones", async () => {
        ownHas("anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        await runSecretsFor("user-1");
        expect(state.touched).toEqual(["anthropic"]);
    });

    it("resolves the deployment's alone when there is no person", async () => {
        // A run with no owner is not a run with an empty wallet.
        instanceHas("groq", "gsk-theirs");
        expect((await runSecretsFor(null))?.GROQ_API_KEY).toBe("gsk-theirs");
    });

    it("skips a key it cannot decrypt rather than failing the run", async () => {
        // A row written under a master key this deployment no longer holds is a
        // credential it does not have, not an error to raise at a run.
        state.ownKeys.push({ provider: "anthropic" });
        instanceHas("anthropic", "sk-theirs");
        expect((await runSecretsFor("user-1"))?.ANTHROPIC_API_KEY).toBe("sk-theirs");
    });
});

describe("keySourcesFor", () => {
    it("says which account each provider would bill", async () => {
        ownHas("anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const sources = await keySourcesFor("user-1");
        expect(sources.get("anthropic")).toBe("own");
        expect(sources.get("groq")).toBe("instance");
    });

    it("omits a provider nothing holds a key for", async () => {
        expect((await keySourcesFor("user-1")).has("openai")).toBe(false);
    });

    it("hides the deployment's providers once sharing is off", async () => {
        state.shared = false;
        instanceHas("groq", "gsk-theirs");
        expect([...(await keySourcesFor("user-1")).keys()]).toEqual([]);
    });
});
