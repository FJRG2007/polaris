/**
 * Copying a scope's variables into a new environment or a clone: a sealed value
 * is never carried over (the copy has it sealed and empty), and a variable with
 * a generator gets a fresh value drawn from it - a preview included.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const create = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { envVar: { findMany, create } } }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    decryptSecret: () => "opened",
    encryptSecret: (value: string) => ({
        ciphertext: Buffer.from(`sealed:${value}`),
        nonce: Buffer.from("n"),
        keyId: "key-1"
    })
}));

const { copyScopeValues } = await import("@/lib/deploy/env-values");

const row = (over: Record<string, unknown>) => ({
    key: "KEY",
    isSecret: false,
    sealed: false,
    generator: null,
    value: "plain",
    encryptedValue: null,
    valueNonce: null,
    valueKeyId: null,
    ...over
});

const FROM = { scopeType: "environment" as const, scopeId: "env-1" };
const TO = { scopeType: "environment" as const, scopeId: "env-2" };

describe("copyScopeValues", () => {
    beforeEach(() => {
        findMany.mockReset();
        create.mockReset();
    });

    it("leaves a sealed value behind, sealed and empty", async () => {
        findMany.mockResolvedValueOnce([
            row({
                key: "TOKEN",
                isSecret: true,
                sealed: true,
                value: null,
                encryptedValue: Buffer.from("x"),
                valueNonce: Buffer.from("n"),
                valueKeyId: "key-1"
            })
        ]);
        findMany.mockResolvedValueOnce([]);
        expect(await copyScopeValues(FROM, TO)).toEqual({ copied: 0, withheld: [] });
        expect(create).toHaveBeenCalledWith({
            data: {
                scopeType: "environment",
                scopeId: "env-2",
                key: "TOKEN",
                isSecret: true,
                sealed: true
            }
        });
    });

    it("draws a fresh value from a generator, even for a preview", async () => {
        findMany.mockResolvedValueOnce([
            row({
                key: "PASSWORD",
                isSecret: true,
                sealed: true,
                generator: '${{ secret(12, "ab") }}',
                value: null,
                encryptedValue: Buffer.from("old")
            })
        ]);
        findMany.mockResolvedValueOnce([]);
        expect(await copyScopeValues(FROM, TO, { secrets: false })).toEqual({
            copied: 1,
            withheld: []
        });
        const data = create.mock.calls[0]?.[0].data;
        expect(data.generator).toBe('${{ secret(12, "ab") }}');
        expect(data.sealed).toBe(true);
        expect(data.value).toBeNull();
        expect(String(data.encryptedValue)).toMatch(/^sealed:[ab]{12}$/);
        expect(String(data.encryptedValue)).not.toBe("old");
    });

    it("still copies a plain value and withholds a secret from a preview", async () => {
        findMany.mockResolvedValueOnce([
            row({ key: "PORT", value: "8080" }),
            row({ key: "SECRET", isSecret: true, value: null, encryptedValue: Buffer.from("x") })
        ]);
        findMany.mockResolvedValueOnce([]);
        expect(await copyScopeValues(FROM, TO, { secrets: false })).toEqual({
            copied: 1,
            withheld: ["SECRET"]
        });
    });
});
