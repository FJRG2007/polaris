/**
 * The audit log's pure parts: the query a screen may send, the days it picks
 * turned into instants, and the CSV file a reader downloads.
 */

import { describe, expect, it } from "vitest";
import { FIELDS } from "@polaris-app/crm/src/model/objects";
import { auditCsv, auditQuerySchema, auditRange, EMPTY_AUDIT_QUERY } from "@polaris-app/crm/src/model/audit";

const labels = {
    header: ["When", "Who", "Object", "Record", "What", "Field", "Before", "After"] as const,
    someone: "Someone",
    object: (object: string) => object,
    kind: (kind: string) => kind,
    field: (_: string, field: { key: string }) => field.key
};

describe("auditQuerySchema", () => {
    it("takes the empty query and refuses an unknown kind or a bad id", () => {
        expect(auditQuerySchema.parse(EMPTY_AUDIT_QUERY)).toEqual(EMPTY_AUDIT_QUERY);
        expect(auditQuerySchema.safeParse({ ...EMPTY_AUDIT_QUERY, kind: "deleted" }).success).toBe(false);
        expect(auditQuerySchema.safeParse({ ...EMPTY_AUDIT_QUERY, cursor: "1 OR 1" }).success).toBe(false);
        expect(auditQuerySchema.safeParse({ ...EMPTY_AUDIT_QUERY, object: "users" }).success).toBe(false);
    });
});

describe("auditRange", () => {
    it("runs from the start of the first day to the start of the day after the last, locally", () => {
        expect(auditRange("2026-10-01", "2026-10-03")).toEqual({
            since: new Date(2026, 9, 1).toISOString(),
            until: new Date(2026, 9, 4).toISOString()
        });
    });

    it("leaves an empty or malformed end open", () => {
        expect(auditRange("", "nope")).toEqual({ since: null, until: null });
        expect(auditRange("2026-12-31", "").until).toBeNull();
    });
});

describe("auditCsv", () => {
    const fieldsOf = (object: "companies" | "people" | "opportunities") => FIELDS[object];

    it("writes a line per change, one for an event with none, and skips a field that is gone", () => {
        const csv = auditCsv(
            [
                {
                    id: "e2",
                    object: "companies",
                    recordId: "r1",
                    recordName: "=Acme",
                    kind: "updated",
                    actor: { id: "u1", name: "Test User" },
                    at: "2026-10-13T10:00:00.000Z",
                    changes: [
                        { key: "name", before: "Old, Co", after: "=Acme" },
                        { key: "idealCustomer", before: false, after: true },
                        { key: "gone", before: "a", after: "b" }
                    ]
                },
                {
                    id: "e1",
                    object: "companies",
                    recordId: "r2",
                    recordName: null,
                    kind: "trashed",
                    actor: null,
                    at: "2026-10-12T10:00:00.000Z",
                    changes: []
                }
            ],
            fieldsOf,
            labels
        );
        expect(csv.startsWith("﻿")).toBe(true);
        expect(csv.slice(1).split("\r\n")).toEqual([
            "When,Who,Object,Record,What,Field,Before,After",
            `2026-10-13T10:00:00.000Z,Test User,companies,'=Acme,updated,name,"Old, Co",'=Acme`,
            "2026-10-13T10:00:00.000Z,Test User,companies,'=Acme,updated,idealCustomer,false,true",
            "2026-10-12T10:00:00.000Z,Someone,companies,,trashed,,,",
            ""
        ]);
    });
});
