/**
 * What a saved connection may be. The form and the action parse with this same
 * schema, so what is asserted here is what both of them do.
 */

import { describe, expect, it } from "vitest";
import {
    connectionIssues,
    saveConnectionSchema,
    type SaveConnectionInput
} from "@/lib/data/connection-schema";

const HOST_ID = "22222222-2222-4222-8222-222222222222";

function draft(over: Partial<SaveConnectionInput> = {}): SaveConnectionInput {
    return { name: "Production", engine: "postgres", host: "db.example.com", port: 5432, ...over };
}

describe("a connection somewhere else", () => {
    it("is read-write unless the reader ticks read-only", () => {
        const parsed = saveConnectionSchema.parse(draft());
        expect(parsed.readOnly).toBe(false);
        expect(saveConnectionSchema.parse(draft({ readOnly: true })).readOnly).toBe(true);
    });

    it("trims the name and refuses an empty one", () => {
        expect(saveConnectionSchema.parse(draft({ name: "  Shop  " })).name).toBe("Shop");
        expect(connectionIssues(draft({ name: "   " })).name).toBe("Give the connection a name.");
    });

    it("refuses a whole connection string in the host field", () => {
        expect(
            connectionIssues(draft({ host: "postgres://user@db.example.com:5432/app" })).host
        ).toContain("without the rest of a URL");
    });

    it("refuses a port that is not one", () => {
        expect(connectionIssues(draft({ port: 0 })).port).toBe("That is not a port.");
        expect(connectionIssues(draft({ port: 70000 })).port).toBe("That is not a port.");
    });

    it("reads a blank optional field as nothing at all", () => {
        const parsed = saveConnectionSchema.parse(
            draft({ database: "  ", username: "", password: "" })
        );
        expect(parsed.database).toBeNull();
        expect(parsed.username).toBeNull();
        expect(parsed.password).toBeNull();
    });

    it("keeps a password exactly as it was typed", () => {
        expect(saveConnectionSchema.parse(draft({ password: " s p " })).password).toBe(" s p ");
    });
});

describe("a database Polaris runs", () => {
    it("needs no address", () => {
        expect(
            connectionIssues({ name: "App", engine: "postgres", managedDatabaseId: HOST_ID })
        ).toEqual({});
    });
});

describe("the SSH tunnel", () => {
    it("takes a server Polaris already has", () => {
        const parsed = saveConnectionSchema.parse(
            draft({ ssh: { mode: "server", hostId: HOST_ID } })
        );
        expect(parsed.ssh).toEqual({ mode: "server", hostId: HOST_ID });
    });

    it("says which server when none was picked", () => {
        expect(connectionIssues(draft({ ssh: { mode: "server", hostId: "" } }))["ssh.hostId"]).toBe(
            "Pick the server to tunnel through."
        );
    });

    it("defaults the SSH port to 22 and keeps the secret optional", () => {
        const parsed = saveConnectionSchema.parse(
            draft({
                ssh: {
                    mode: "manual",
                    host: "ssh.example.com",
                    username: "root",
                    authMethod: "key"
                }
            })
        );
        expect(parsed.ssh).toMatchObject({
            mode: "manual",
            port: 22,
            privateKey: null,
            jumpHostId: null
        });
    });

    it("checks the SSH host and user the same way", () => {
        const issues = connectionIssues(
            draft({
                ssh: {
                    mode: "manual",
                    host: "root@ssh.example.com",
                    port: 22,
                    username: "",
                    authMethod: "password"
                }
            })
        );
        expect(issues["ssh.host"]).toContain("without the rest of a URL");
        expect(issues["ssh.username"]).toBe("Enter the SSH user.");
    });

    it("takes a jump server, and refuses one that is not an id", () => {
        const parsed = saveConnectionSchema.parse(
            draft({
                ssh: {
                    mode: "manual",
                    host: "ssh.example.com",
                    port: 2222,
                    username: "root",
                    authMethod: "password",
                    password: "hunter2",
                    jumpHostId: HOST_ID
                }
            })
        );
        expect(parsed.ssh).toMatchObject({ jumpHostId: HOST_ID, port: 2222 });
        expect(
            connectionIssues(
                draft({
                    ssh: {
                        mode: "manual",
                        host: "ssh.example.com",
                        username: "root",
                        authMethod: "password",
                        jumpHostId: "the-bastion"
                    }
                })
            )["ssh.jumpHostId"]
        ).toBe("Pick the server to jump through.");
    });
});
