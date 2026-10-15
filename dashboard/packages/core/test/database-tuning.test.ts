import { describe, expect, it } from "vitest";
import * as tuning from "../src/schemas/database-tuning.js";

const pg = { engine: "postgres", adminUser: "app", adminPassword: "secret" } as const;
const my = { engine: "mysql", adminUser: "app", adminPassword: "secret" } as const;
const maria = { engine: "mariadb", adminUser: "app", adminPassword: "secret" } as const;

function byName(list: readonly tuning.TuningSuggestion[]): Record<string, string> {
    return Object.fromEntries(list.map((entry) => [entry.name, entry.value]));
}

describe("suggestTuning", () => {
    it("gives PostgreSQL a quarter for shared buffers and three quarters as cache", () => {
        expect(byName(tuning.suggestTuning("postgres", 4096))).toEqual({
            shared_buffers: "1024MB",
            effective_cache_size: "3072MB",
            work_mem: "5MB",
            maintenance_work_mem: "256MB",
            max_connections: "200"
        });
    });

    it("keeps PostgreSQL's floors and ceilings on a small and a huge machine", () => {
        const small = byName(tuning.suggestTuning("postgres", 100));
        expect(small.shared_buffers).toBe("64MB");
        expect(small.work_mem).toBe("4MB");
        expect(small.maintenance_work_mem).toBe("16MB");
        expect(byName(tuning.suggestTuning("postgres", 262144)).maintenance_work_mem).toBe("2048MB");
    });

    it("sizes InnoDB's pool in 128 MB chunks", () => {
        const values = byName(tuning.suggestTuning("mysql", 8192));
        expect(Number(values.innodb_buffer_pool_size) / (1024 * 1024)).toBe(5632);
        expect(Number(values.innodb_buffer_pool_size) % (128 * 1024 * 1024)).toBe(0);
        expect(byName(tuning.suggestTuning("mysql", 512)).innodb_buffer_pool_size).toBe(String(256 * 1024 * 1024));
    });
});

describe("reading", () => {
    it("parses /proc/meminfo", () => {
        expect(tuning.parseMemInfo("MemTotal:       16303740 kB\nMemFree: 1 kB\n")).toBe(15921);
        expect(tuning.parseMemInfo("nothing")).toBeNull();
    });

    it("reads only the tuned settings", () => {
        expect(tuning.readTuningCommand(pg).argv.at(-1)).toContain("'shared_buffers'");
        expect(tuning.parseTuning("postgres", "shared_buffers|128MB\nfsync|on\n")).toEqual({ shared_buffers: "128MB" });
        expect(tuning.parseTuning("mysql", "max_connections\t151\n")).toEqual({ max_connections: "151" });
    });
});

describe("applyTuningCommands", () => {
    it("uses ALTER SYSTEM one statement at a time on PostgreSQL", () => {
        const commands = tuning.applyTuningCommands(pg, [
            { name: "shared_buffers", value: "1024MB" },
            { name: "max_connections", value: "200" }
        ]);
        expect(commands.map((command) => command.argv.at(-1))).toEqual([
            "ALTER SYSTEM SET shared_buffers = '1024MB'",
            "ALTER SYSTEM SET max_connections = '200'"
        ]);
    });

    it("uses SET PERSIST_ONLY on MySQL and refuses MariaDB", () => {
        const [command] = tuning.applyTuningCommands(my, [{ name: "max_connections", value: "151" }]);
        expect(command.argv.at(-1)).toBe("SET PERSIST_ONLY max_connections = 151;");
        expect(() => tuning.applyTuningCommands(maria, [{ name: "max_connections", value: "151" }])).toThrow(/MariaDB/);
    });

    it("refuses names it does not tune and values of the wrong shape", () => {
        expect(() => tuning.applyTuningCommands(pg, [{ name: "archive_command", value: "1" }])).toThrow();
        expect(() => tuning.applyTuningCommands(pg, [{ name: "work_mem", value: "4MB'; DROP" }])).toThrow();
        expect(() => tuning.applyTuningCommands(my, [{ name: "max_connections", value: "1; DROP" }])).toThrow();
        expect(() => tuning.applyTuningCommands(my, [{ name: "max_connections", value: "64MB" }])).toThrow();
    });
});
