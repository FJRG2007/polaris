/**
 * Moving an instance: the real schema can be written back in some order, and a
 * row survives the trip with its secrets re-sealed under the other instance's key.
 */

import { Prisma } from "@polaris/db";
import { describe, expect, it } from "vitest";
import { writePlan, type SchemaModel } from "@/lib/instance-transfer/plan";
import {
    decodeRow,
    encodeRow,
    envelopeTriples,
    type SecretCodec
} from "@/lib/instance-transfer/codec";

const real = Prisma.dmmf.datamodel.models as unknown as SchemaModel[];

describe("the write order", () => {
    it("exists for the schema as it is, with every required reference written first", () => {
        const plan = writePlan(real);
        expect(plan.order).toHaveLength(real.length);
        const position = new Map(plan.order.map((name, index) => [name, index]));
        for (const model of real) {
            for (const field of model.fields) {
                if (field.kind !== "object" || !field.relationFromFields?.length) continue;
                const deferred = plan.deferred.get(model.name) ?? [];
                const isDeferred = field.relationFromFields.every((column) =>
                    deferred.includes(column)
                );
                if (isDeferred) {
                    // Only ever an optional column, written empty and filled in later.
                    for (const column of field.relationFromFields) {
                        expect(
                            model.fields.find((candidate) => candidate.name === column)?.isRequired
                        ).toBe(false);
                    }
                    continue;
                }
                expect(
                    position.get(field.type)!,
                    `${model.name}.${field.name}`
                ).toBeLessThanOrEqual(position.get(model.name)!);
            }
        }
    });

    it("refuses a loop of required references by name", () => {
        const loop: SchemaModel[] = [
            {
                name: "A",
                fields: [
                    {
                        name: "id",
                        kind: "scalar",
                        type: "String",
                        isRequired: true,
                        isList: false,
                        isId: true
                    },
                    {
                        name: "bId",
                        kind: "scalar",
                        type: "String",
                        isRequired: true,
                        isList: false
                    },
                    {
                        name: "b",
                        kind: "object",
                        type: "B",
                        isRequired: true,
                        isList: false,
                        relationFromFields: ["bId"]
                    }
                ]
            },
            {
                name: "B",
                fields: [
                    {
                        name: "id",
                        kind: "scalar",
                        type: "String",
                        isRequired: true,
                        isList: false,
                        isId: true
                    },
                    {
                        name: "aId",
                        kind: "scalar",
                        type: "String",
                        isRequired: true,
                        isList: false
                    },
                    {
                        name: "a",
                        kind: "object",
                        type: "A",
                        isRequired: true,
                        isList: false,
                        relationFromFields: ["aId"]
                    }
                ]
            }
        ];
        expect(() => writePlan(loop)).toThrow(/A, B/);
    });
});

/** A stand-in for one instance's keys: "sealing" is reversible and names its key. */
function codecFor(key: string): SecretCodec {
    return {
        open: (blob) =>
            blob.keyId === key ? blob.ciphertext.toString("utf8").replace(`${key}:`, "") : null,
        seal: (plain) => ({
            ciphertext: Buffer.from(`${key}:${plain}`),
            nonce: Buffer.from("n"),
            keyId: key
        }),
        openAuth: async (value) =>
            value.startsWith(`${key}!`) ? value.slice(key.length + 1) : null,
        sealAuth: async (plain) => `${key}!${plain}`
    };
}

const envVar = real.find((model) => model.name === "EnvVar")!;
const twoFactor = real.find((model) => model.name === "TwoFactor")!;

describe("a row on its way between instances", () => {
    it("finds the envelopes a table keeps in three columns", () => {
        expect(envelopeTriples(envVar)).toEqual([
            { ciphertext: "encryptedValue", nonce: "valueNonce", keyId: "valueKeyId" }
        ]);
        const mail = real.find((model) => model.name === "MailServer")!;
        expect(envelopeTriples(mail).map((triple) => triple.ciphertext)).toContain("adminSecret");
    });

    it("arrives re-sealed under the other instance's key", async () => {
        const row = {
            id: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
            encryptedValue: Buffer.from("source:hunter2"),
            valueNonce: Buffer.from("n"),
            valueKeyId: "source",
            createdAt: new Date("2026-09-10T10:00:00Z")
        };
        const tally = { carried: 0, unreadable: 0 };
        const encoded = await encodeRow(envVar, row, codecFor("source"), tally);
        const wire = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
        expect(JSON.stringify(wire)).toContain("hunter2");
        expect(wire).not.toHaveProperty("valueNonce");
        const decoded = await decodeRow(envVar, wire, codecFor("target"));
        expect(Buffer.from(decoded.encryptedValue as Buffer).toString("utf8")).toBe(
            "target:hunter2"
        );
        expect(decoded.valueKeyId).toBe("target");
        expect(decoded.createdAt).toEqual(row.createdAt);
        expect(tally).toEqual({ carried: 1, unreadable: 0 });
    });

    it("carries a secret that does not open as it is, and counts it", async () => {
        const tally = { carried: 0, unreadable: 0 };
        const row = {
            encryptedValue: Buffer.from("x"),
            valueNonce: Buffer.from("n"),
            valueKeyId: "gone"
        };
        const decoded = await decodeRow(
            envVar,
            JSON.parse(JSON.stringify(await encodeRow(envVar, row, codecFor("source"), tally))),
            codecFor("target")
        );
        expect(Buffer.from(decoded.encryptedValue as Buffer).toString()).toBe("x");
        expect(decoded.valueKeyId).toBe("gone");
        expect(tally.unreadable).toBe(1);
    });

    it("re-seals the sign-in library's two-factor secrets", async () => {
        const tally = { carried: 0, unreadable: 0 };
        const row = {
            id: "t1",
            secret: "source!TOTPSEED",
            backupCodes: "source![1,2]",
            verified: true
        };
        const wire = JSON.parse(
            JSON.stringify(await encodeRow(twoFactor, row, codecFor("source"), tally))
        );
        const decoded = await decodeRow(twoFactor, wire, codecFor("target"));
        expect(decoded.secret).toBe("target!TOTPSEED");
        expect(decoded.backupCodes).toBe("target![1,2]");
    });

    it("re-seals an envelope kept as one JSON string", async () => {
        const setting = real.find((model) => model.name === "Setting")!;
        const sealed = JSON.stringify({
            c: Buffer.from("source:tok").toString("base64"),
            n: "bg==",
            k: "source"
        });
        const tally = { carried: 0, unreadable: 0 };
        const wire = JSON.parse(
            JSON.stringify(
                await encodeRow(setting, { key: "k", value: sealed }, codecFor("source"), tally)
            )
        );
        const decoded = await decodeRow(setting, wire, codecFor("target"));
        const stored = JSON.parse(decoded.value as string) as { c: string; k: string };
        expect(Buffer.from(stored.c, "base64").toString()).toBe("target:tok");
        expect(stored.k).toBe("target");
    });
});
