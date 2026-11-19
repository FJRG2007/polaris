/**
 * A model endpoint of a person's own is called by the dashboard from inside the
 * deployment, with the stored key attached. It may only be a public address -
 * at save and at every call - so a member cannot point it at the cloud metadata
 * service or a container on the internal network. The deployment's own keys,
 * saved by an administrator, may still be on the local network (an Ollama).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    created: [] as Array<{ provider: string; config?: Record<string, unknown> }>,
    updated: [] as Array<{ config?: Record<string, unknown> }>
}));

vi.mock("@/lib/agents/machine-logins", () => ({ machineLoginOf: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/agents/model-keys", () => ({
    createModelKey: async (
        _owner: unknown,
        input: { provider: string; config?: Record<string, unknown> }
    ) => void state.created.push(input),
    updateModelKey: async (_owner: unknown, _id: string, input: { config?: Record<string, unknown> }) => {
        state.updated.push(input);
        return true;
    },
    providerOfModelKey: async () => "enigma",
    heldModelKey: async () => null,
    isStorableProvider: () => true,
    ownerHasModelKeyName: async () => false,
    ownerHasModelSecret: async () => false,
    deleteModelKey: vi.fn(),
    reorderModelKeys: vi.fn(),
    setModelKeyEnabled: vi.fn()
}));
vi.mock("@/lib/agents/provider-key-check", () => ({
    checkProviderKey: async () => ({ state: "unverified", code: "unsupported", reason: "first run" })
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { addKey, editKey } = await import("@/lib/agents/model-key-actions");
const { configuredFetch, RefusedAddressError } = await import("@/lib/safe-fetch");
const { gatewayKeyConfigSchema } = await import("@polaris/core");

const account = { owner: "user-1", actorId: "user-1", path: "/polar/settings/providers", audit: "account" as const };
const instance = { owner: "instance", actorId: "admin-1", path: "/admin/integrations/models", audit: "instance" as const };
const ID = "0190a3c2-7a3e-7000-8000-000000000001";

const gateway = (baseUrl: string) => ({
    provider: "enigma",
    name: "Mine",
    secret: "sk-test-fixture-0001",
    config: { baseUrl, model: "fixture-model", context: 0, maxOutput: 0 }
});

beforeEach(() => {
    state.created = [];
    state.updated = [];
});

describe("saving an endpoint of your own", () => {
    it.each([
        "http://127.0.0.1:1/v1",
        "http://169.254.169.254/latest",
        "http://10.0.0.5:11434/v1",
        "http://[::1]:8080/v1"
    ])("refuses %s on an account", async (baseUrl) => {
        const result = await addKey(account, gateway(baseUrl));
        expect(result.error).toBe("refusals.aiKeys.privateEndpoint");
        expect(state.created).toHaveLength(0);
    });

    it("refuses a private address when an account key's endpoint is edited", async () => {
        const result = await editKey(account, {
            id: ID,
            name: "Mine",
            config: gateway("http://169.254.169.254/latest").config
        });
        expect(result.error).toBe("refusals.aiKeys.privateEndpoint");
        expect(state.updated).toHaveLength(0);
    });

    it("keeps a public address on an account", async () => {
        const result = await addKey(account, gateway("https://1.1.1.1/v1"));
        expect(result.error).toBeUndefined();
        expect(state.created).toHaveLength(1);
    });

    it("keeps the local network for the deployment's own keys", async () => {
        const result = await addKey(instance, gateway("http://10.0.0.5:11434/v1"));
        expect(result.error).toBeUndefined();
        expect(state.created).toHaveLength(1);
    });

    it("takes only an http or https address without credentials", () => {
        const config = gateway("").config;
        for (const baseUrl of ["file:///etc/passwd", "ftp://host/v1", "http://user:pass@host.example/v1"]) {
            expect(gatewayKeyConfigSchema.safeParse({ ...config, baseUrl }).success).toBe(false);
        }
        expect(gatewayKeyConfigSchema.safeParse({ ...config, baseUrl: "https://api.example.com/v1" }).success).toBe(true);
    });
});

describe("calling an endpoint of your own", () => {
    it("refuses a private address before anything is sent", async () => {
        const sent = vi.spyOn(globalThis, "fetch");
        const guarded = configuredFetch(60_000);
        for (const address of ["http://169.254.169.254/latest/chat/completions", "http://127.0.0.1:1/v1"]) {
            await expect(guarded(address, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
                RefusedAddressError
            );
        }
        expect(sent).not.toHaveBeenCalled();
        sent.mockRestore();
    });

    it("is what a person's own gateway model calls through, and not the deployment's", async () => {
        const { languageModel } = await import("@/lib/polar/models");
        const credential = (source: "own" | "instance") => ({
            provider: "enigma",
            source,
            secret: "sk-test-fixture-0001",
            baseUrl: "http://127.0.0.1:1/v1",
            gatewayModel: "fixture-model"
        });
        const sent = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("reached the network"));
        const prompt = {
            prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }]
        };

        const own = languageModel(credential("own"), "fixture-model");
        await expect(
            (own as unknown as { doGenerate: (input: unknown) => Promise<unknown> }).doGenerate(prompt)
        ).rejects.toThrow();
        expect(sent).not.toHaveBeenCalled();

        const deployment = languageModel(credential("instance"), "fixture-model");
        await expect(
            (deployment as unknown as { doGenerate: (input: unknown) => Promise<unknown> }).doGenerate(prompt)
        ).rejects.toThrow();
        expect(sent).toHaveBeenCalled();
        sent.mockRestore();
    });
});
