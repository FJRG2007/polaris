/**
 * Whose provider account a run spends, and which of that owner's keys.
 *
 * Two owners can hold a key for the same provider - the person whose
 * repositories the runs belong to, and the deployment itself - and getting the
 * order wrong is not a display bug. A personal key that the deployment's could
 * override would be a setting with no effect; a deployment key spent by somebody
 * an administrator excluded is somebody else's bill.
 *
 * Either owner can now hold several keys for one provider, which adds a second
 * order underneath the first: their own list, top down. The variable the agent
 * CLIs read holds one value, so which key fills it is the whole question these
 * cover.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stored row, as the fake store holds it. In priority order. */
interface FakeKey {
    id: string;
    provider: string;
    config: string;
    expiresAt: Date | null;
}

const state = {
    ownKeys: [] as FakeKey[],
    /** The deployment's own, which are the same rows with no owner. */
    instanceKeys: [] as FakeKey[],
    /** Ciphertext to plaintext. A row whose id is absent here is one this
     *  deployment can no longer decrypt. */
    secrets: new Map<string, string>(),
    shared: true,
    touched: [] as string[]
};

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: {
            // The fake ignores `orderBy` and `select`: each list is already in
            // priority order, and returning more fields than were asked for is
            // indistinguishable from returning exactly them. The owner it does
            // honour, because which list a read is against is the question half
            // of these ask, and so is the expiry filter.
            findMany: vi.fn(async ({ where }: { where?: { userId?: string | null; OR?: unknown[] } } = {}) =>
                (where?.userId ? state.ownKeys : state.instanceKeys)
                    .filter((row) => !where?.OR || row.expiresAt === null || row.expiresAt > new Date())
                    .map((row) => ({
                        ...row,
                        encryptedSecret: Buffer.from(row.id),
                        secretNonce: Buffer.from("n"),
                        secretKeyId: "k"
                    }))
            ),
            findFirst: vi.fn(async () => null),
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
                state.touched.push(...where.id.in);
                return { count: where.id.in.length };
            }),
            create: vi.fn(async () => undefined),
            update: vi.fn(async () => undefined),
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
        const secret = state.secrets.get(blob.ciphertext.toString());
        if (secret === undefined) throw new FakeDecryptError("wrong master key");
        return secret;
    },
    CredentialDecryptError: FakeDecryptError
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => (state.shared ? "on" : "off"),
    setSetting: async () => undefined
}));

const { connectedProviders, keySourcesFor, runSecretsFor } = await import("@/lib/agents/model-keys");

beforeEach(() => {
    state.ownKeys = [];
    state.instanceKeys = [];
    state.secrets = new Map();
    state.shared = true;
    state.touched = [];
});

/** Append a key to a list. `secret` of null is a row this deployment can no
 *  longer read. */
function add(
    rows: FakeKey[],
    id: string,
    slug: string,
    secret: string | null,
    config: Record<string, unknown> = {},
    expiresAt: Date | null = null
): void {
    rows.push({ id, provider: slug, config: JSON.stringify(config), expiresAt });
    if (secret !== null) state.secrets.set(id, secret);
}

/** A key the deployment holds. Its id is derived so the tests that check what
 *  was used can name it without inventing one. */
function instanceHas(slug: string, secret: string, config: Record<string, unknown> = {}): string {
    const id = `instance-${slug}`;
    add(state.instanceKeys, id, slug, secret, config);
    return id;
}

function ownHas(id: string, slug: string, secret: string | null, config: Record<string, unknown> = {}): void {
    add(state.ownKeys, id, slug, secret, config);
}

/** The same, with an end date. Negative days are already gone. */
function ownHasUntil(id: string, slug: string, secret: string, days: number): void {
    add(state.ownKeys, id, slug, secret, {}, new Date(Date.now() + days * 86_400_000));
}

describe("runSecretsFor", () => {
    it("prefers the person's own key over the deployment's", async () => {
        ownHas("k1", "anthropic", "sk-mine");
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
        ownHas("k1", "anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const secrets = await runSecretsFor("user-1");
        expect(secrets).toEqual({ ANTHROPIC_API_KEY: "sk-mine" });
    });

    it("hands over every provider that resolves, not only one", async () => {
        // The agent CLIs substitute a model themselves when one is unreachable;
        // one key would turn a recoverable substitution into a failed run.
        ownHas("k1", "anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const secrets = await runSecretsFor("user-1");
        expect(Object.keys(secrets ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "GROQ_API_KEY"]);
    });

    it("uses the first of several keys for one provider", async () => {
        // The order is the setting. A second key for the same provider is a
        // spare, not a replacement.
        ownHas("k1", "openai", "sk-first");
        ownHas("k2", "openai", "sk-second");
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-first");
    });

    it("uses the first of the deployment's keys for one provider", async () => {
        // The administrator's list is a list in the same way: a second key is
        // the spare, and which one is tried first is the order they set.
        add(state.instanceKeys, "i1", "openai", "sk-first");
        add(state.instanceKeys, "i2", "openai", "sk-second");
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-first");
    });

    it("moves to the deployment's next key of that provider before giving up", async () => {
        add(state.instanceKeys, "i1", "openai", null);
        add(state.instanceKeys, "i2", "openai", "sk-second");
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-second");
    });

    it("moves to the account's next key of that provider before the deployment's", async () => {
        // A key this deployment cannot decrypt is one it does not hold - but the
        // account still holds another, and reaching past it to the instance
        // would spend the wrong wallet.
        ownHas("k1", "openai", null);
        ownHas("k2", "openai", "sk-second");
        instanceHas("openai", "sk-theirs");
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-second");
    });

    it("records every key that was used, whoever holds it", async () => {
        // "Last used" is a column on both screens now, and a key an administrator
        // pasted and forgot is exactly as invisible as one anybody else did.
        ownHas("k1", "anthropic", "sk-mine");
        ownHas("k2", "anthropic", "sk-spare");
        instanceHas("groq", "gsk-theirs");
        await runSecretsFor("user-1");
        expect(state.touched).toEqual(["k1", "instance-groq"]);
    });

    it("resolves the deployment's alone when there is no person", async () => {
        // A run with no owner is not a run with an empty wallet.
        instanceHas("groq", "gsk-theirs");
        expect((await runSecretsFor(null))?.GROQ_API_KEY).toBe("gsk-theirs");
    });

    it("skips a key it cannot decrypt rather than failing the run", async () => {
        // A row written under a master key this deployment no longer holds is a
        // credential it does not have, not an error to raise at a run.
        ownHas("k1", "anthropic", null);
        instanceHas("anthropic", "sk-theirs");
        expect((await runSecretsFor("user-1"))?.ANTHROPIC_API_KEY).toBe("sk-theirs");
    });

    it("stops handing over a key past its end date", async () => {
        // The date is the whole reason somebody entered it: on the day, the key
        // is not offered, whatever else happens.
        ownHasUntil("k1", "openai", "sk-expired", -1);
        expect(await runSecretsFor("user-1")).toEqual({});
    });

    it("still uses a key whose end date has not arrived", async () => {
        ownHasUntil("k1", "openai", "sk-live", 3);
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-live");
    });

    it("falls to the next key of the provider when the first has expired", async () => {
        ownHasUntil("k1", "openai", "sk-expired", -1);
        ownHas("k2", "openai", "sk-spare");
        expect((await runSecretsFor("user-1"))?.OPENAI_API_KEY).toBe("sk-spare");
    });

    it("stops handing over one of the deployment's past its end date", async () => {
        // The date means the same thing on either list, or an administrator has
        // entered one that does nothing.
        add(state.instanceKeys, "i1", "openai", "sk-expired", {}, new Date(Date.now() - 86_400_000));
        expect(await runSecretsFor("user-1")).toEqual({});
    });

    it("lets the deployment's key take over from an expired one", async () => {
        // The alternative is a provider that looks covered and is not: the whole
        // point of the fallback is that somebody's runs keep working.
        ownHasUntil("k1", "groq", "gsk-expired", -1);
        instanceHas("groq", "gsk-theirs");
        expect((await runSecretsFor("user-1"))?.GROQ_API_KEY).toBe("gsk-theirs");
    });

    it("takes the gateway's endpoint and limits from the account's own row", async () => {
        ownHas("k1", "enigma", "gw-token", {
            baseUrl: "https://gateway.example/v1/",
            model: "some-model",
            context: 200000,
            maxOutput: 32000
        });
        const secrets = await runSecretsFor("user-1");
        expect(secrets?.OPENAI_COMPATIBLE_BASE_URL).toBe("https://gateway.example/v1");
        expect(secrets?.OPENAI_COMPATIBLE_API_KEY).toBe("gw-token");
        expect(secrets?.OPENAI_COMPATIBLE_MODEL).toBe("some-model");
        expect(secrets?.OPENAI_COMPATIBLE_CONTEXT).toBe("200000");
        expect(state.touched).toEqual(["k1"]);
    });

    it("takes the deployment's gateway when the account has none", async () => {
        instanceHas("enigma", "gw-token", {
            baseUrl: "https://gateway.example/v1",
            model: "some-model",
            context: 200000,
            maxOutput: 32000
        });
        const secrets = await runSecretsFor("user-1");
        expect(secrets?.OPENAI_COMPATIBLE_BASE_URL).toBe("https://gateway.example/v1");
        expect(secrets?.OPENAI_COMPATIBLE_MODEL).toBe("some-model");
    });

    it("still points a run at a gateway that wants no token", async () => {
        // An endpoint on the operator's own network frequently accepts
        // unauthenticated calls. The variable is still set, because the runtime
        // reads it either way, and the row carries no credential at all - which
        // is how the deployment's gateway arrived from its Integration row.
        add(state.instanceKeys, "i1", "enigma", "", {
            baseUrl: "https://gateway.example/v1",
            model: "some-model"
        });
        const secrets = await runSecretsFor("user-1");
        expect(secrets?.OPENAI_COMPATIBLE_BASE_URL).toBe("https://gateway.example/v1");
        expect(secrets?.OPENAI_COMPATIBLE_API_KEY).toBe("unused");
    });
});

describe("keySourcesFor", () => {
    it("says which account each provider would bill", async () => {
        ownHas("k1", "anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        const sources = await keySourcesFor("user-1");
        expect(sources.get("anthropic")).toBe("own");
        expect(sources.get("groq")).toBe("instance");
    });

    it("lists the account's own providers in its own order, before the deployment's", async () => {
        // Every screen that offers a provider reads this, so the order somebody
        // set on their keys has to be the order they are offered in.
        ownHas("k1", "groq", "gsk-mine");
        ownHas("k2", "anthropic", "sk-mine");
        instanceHas("openai", "sk-theirs");
        expect([...(await keySourcesFor("user-1")).keys()]).toEqual(["groq", "anthropic", "openai"]);
    });

    it("counts a provider once however many keys it has", async () => {
        ownHas("k1", "openai", "sk-one");
        ownHas("k2", "openai", "sk-two");
        expect([...(await keySourcesFor("user-1")).keys()]).toEqual(["openai"]);
    });

    it("does not count an expired key as covering its provider", async () => {
        ownHasUntil("k1", "groq", "gsk-expired", -1);
        instanceHas("groq", "gsk-theirs");
        expect((await keySourcesFor("user-1")).get("groq")).toBe("instance");
    });

    it("omits a provider nothing holds a key for", async () => {
        expect((await keySourcesFor("user-1")).has("openai")).toBe(false);
    });

    it("hides the deployment's providers once sharing is off", async () => {
        state.shared = false;
        instanceHas("groq", "gsk-theirs");
        expect([...(await keySourcesFor("user-1")).keys()]).toEqual([]);
    });

    it("does not offer a gateway with no endpoint to ask", async () => {
        // A gateway is its endpoint. A row without one is a setting somebody
        // started and left, not a provider anything can reach.
        ownHas("k1", "enigma", "gw-token", { baseUrl: "", model: "" });
        expect((await keySourcesFor("user-1")).has("enigma")).toBe(false);
    });
});

describe("connectedProviders", () => {
    it("is what the deployment holds, and nobody's own", async () => {
        // The admin defaults read this: a provider one account brought a key for
        // is not a provider the deployment can offer everybody.
        ownHas("k1", "anthropic", "sk-mine");
        instanceHas("groq", "gsk-theirs");
        expect(await connectedProviders()).toEqual(["groq"]);
    });

    it("ignores the sharing switch, which is about who spends them", async () => {
        // Turning sharing off does not un-store the keys, and the screen that
        // lists them is not the screen that shares them.
        state.shared = false;
        instanceHas("groq", "gsk-theirs");
        expect(await connectedProviders()).toEqual(["groq"]);
    });
});
