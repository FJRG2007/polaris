import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readInstances, readStoredInstance, writeStoredInstance } from "@/main/instance-store";

const SERVER = "https://polaris.example.com";
const record = {
    id: "inst_0123456789abcdef",
    publicKey: "A".repeat(43),
    addresses: [SERVER, "https://polaris.local", "https://192.168.1.20"]
};

function file(): string {
    return join(mkdtempSync(join(tmpdir(), "polaris-instances-")), "instances.json");
}

describe("instance store", () => {
    it("keeps what was learned across a restart", () => {
        const path = file();
        writeStoredInstance(path, SERVER, record, 1000);
        expect(readStoredInstance(path, SERVER)).toEqual({ record, learnedAt: 1000 });
    });

    it("keeps other servers when one is written", () => {
        const path = file();
        writeStoredInstance(path, "https://other.example.com", record);
        writeStoredInstance(path, SERVER, record);
        expect([...readInstances(path).keys()].sort()).toEqual(["https://other.example.com", SERVER]);
    });

    it("has nothing for a missing or malformed file, and drops a malformed record", () => {
        const path = file();
        expect(readStoredInstance(path, SERVER)).toBeNull();
        writeFileSync(path, "not json");
        expect(readInstances(path).size).toBe(0);
        writeFileSync(path, JSON.stringify({ [SERVER]: { record: { ...record, publicKey: "short" }, learnedAt: 1 } }));
        expect(readStoredInstance(path, SERVER)).toBeNull();
    });
});
