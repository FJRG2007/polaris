/**
 * The Tuning tab: settings sized to the memory a database actually has, and
 * the commands that read what it runs with now and write the suggestion.
 *
 * Pure: the sizing is arithmetic on a number of megabytes, and the commands
 * are argument vectors built only from a fixed list of setting names and
 * values this module produced or checked. The sizing follows the rules of
 * thumb the engines' own documentation gives - a quarter of the memory for
 * PostgreSQL's shared buffers and three quarters as the cache it can expect,
 * most of the memory for InnoDB's buffer pool on a machine that runs MySQL
 * alone.
 */

import type { AccountCommand, AccountTarget } from "./database-accounts.js";

export const TUNING_SETTINGS = {
    postgres: ["shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem", "max_connections"],
    mysql: ["innodb_buffer_pool_size", "innodb_log_buffer_size", "max_connections", "tmp_table_size", "max_heap_table_size"],
    mariadb: ["innodb_buffer_pool_size", "innodb_log_buffer_size", "max_connections", "tmp_table_size", "max_heap_table_size"]
} as const;

export interface TuningSuggestion {
    readonly name: string;
    /** As the engine takes it: `512MB` for PostgreSQL, bytes or a count for MySQL. */
    readonly value: string;
}

const MB = 1024 * 1024;

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

/** Suggested settings for an engine given the memory it may use, in megabytes. */
export function suggestTuning(engine: AccountTarget["engine"], ramMb: number): TuningSuggestion[] {
    const ram = Math.max(256, Math.floor(ramMb));
    if (engine === "postgres") {
        const connections = ram < 1024 ? 50 : ram < 4096 ? 100 : 200;
        const shared = Math.floor(ram / 4);
        const cache = Math.floor((ram * 3) / 4);
        const maintenance = clamp(Math.floor(ram / 16), 16, 2048);
        const work = clamp(Math.floor((ram - shared) / (connections * 3)), 4, 256);
        return [
            { name: "shared_buffers", value: `${shared}MB` },
            { name: "effective_cache_size", value: `${cache}MB` },
            { name: "work_mem", value: `${work}MB` },
            { name: "maintenance_work_mem", value: `${maintenance}MB` },
            { name: "max_connections", value: String(connections) }
        ];
    }
    // The pool is sized in 128 MB chunks, so the suggestion is too.
    const share = ram >= 2048 ? 0.7 : 0.5;
    const pool = Math.max(128, Math.floor((ram * share) / 128) * 128);
    const temp = ram >= 4096 ? 64 : ram >= 1024 ? 32 : 16;
    return [
        { name: "innodb_buffer_pool_size", value: String(pool * MB) },
        { name: "innodb_log_buffer_size", value: String((ram >= 2048 ? 32 : 16) * MB) },
        { name: "max_connections", value: String(ram < 1024 ? 75 : ram < 4096 ? 151 : 300) },
        { name: "tmp_table_size", value: String(temp * MB) },
        { name: "max_heap_table_size", value: String(temp * MB) }
    ];
}

/** Total memory from `/proc/meminfo`, in megabytes, or null when it says nothing usable. */
export function parseMemInfo(output: string): number | null {
    const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(output);
    if (!match) return null;
    const mb = Math.floor(Number(match[1]) / 1024);
    return mb > 0 ? mb : null;
}

export const MEMINFO_COMMAND: AccountCommand = { argv: ["cat", "/proc/meminfo"], describe: "Reading the memory" };

/** What MariaDB cannot do that the apply needs. */
export const MARIADB_APPLY_REFUSAL =
    "MariaDB has no way to save a setting from a connection (MySQL's SET PERSIST), so these can only be read here.";

export function readTuningCommand(target: AccountTarget): AccountCommand {
    const names = TUNING_SETTINGS[target.engine];
    const list = names.map((name) => `'${name}'`).join(", ");
    if (target.engine === "postgres") {
        return {
            argv: [
                "env",
                `PGPASSWORD=${target.adminPassword}`,
                "psql",
                "-tA",
                "-U",
                target.adminUser,
                "-d",
                "postgres",
                "-c",
                `SELECT name, current_setting(name) FROM pg_settings WHERE name IN (${list}) ORDER BY name`
            ],
            describe: "Reading the settings"
        };
    }
    return {
        argv: [
            target.engine === "mysql" ? "mysql" : "mariadb",
            "-uroot",
            `-p${target.adminPassword}`,
            "-N",
            "-B",
            "-e",
            `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${list})`
        ],
        describe: "Reading the settings"
    };
}

export function parseTuning(engine: AccountTarget["engine"], output: string): Record<string, string> {
    const separator = engine === "postgres" ? "|" : "\t";
    const known = new Set<string>(TUNING_SETTINGS[engine]);
    const current: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
        const [name = "", value = ""] = line.trim().split(separator);
        if (known.has(name)) current[name] = value.trim();
    }
    return current;
}

const POSTGRES_VALUE = /^\d{1,9}(kB|MB|GB)?$/;
const MYSQL_VALUE = /^\d{1,15}$/;

/**
 * Write settings so they hold after a restart: `ALTER SYSTEM` for PostgreSQL,
 * `SET PERSIST_ONLY` for MySQL 8. Only the names this module tunes, with
 * values of the shape the engine takes, reach a statement.
 */
export function applyTuningCommands(target: AccountTarget, settings: readonly TuningSuggestion[]): AccountCommand[] {
    if (target.engine === "mariadb") throw new Error(MARIADB_APPLY_REFUSAL);
    const known = new Set<string>(TUNING_SETTINGS[target.engine]);
    const shape = target.engine === "postgres" ? POSTGRES_VALUE : MYSQL_VALUE;
    for (const setting of settings) {
        if (!known.has(setting.name)) throw new Error(`Polaris does not tune ${setting.name.slice(0, 64)}.`);
        if (!shape.test(setting.value)) throw new Error(`That is not a value for ${setting.name}.`);
    }
    if (target.engine === "postgres") {
        // ALTER SYSTEM refuses to run inside a transaction, so each is its own command.
        return settings.map((setting) => ({
            argv: [
                "env",
                `PGPASSWORD=${target.adminPassword}`,
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                target.adminUser,
                "-d",
                "postgres",
                "-c",
                `ALTER SYSTEM SET ${setting.name} = '${setting.value}'`
            ],
            describe: `Saving ${setting.name}`
        }));
    }
    return [
        {
            argv: [
                "mysql",
                "-uroot",
                `-p${target.adminPassword}`,
                "-e",
                settings.map((setting) => `SET PERSIST_ONLY ${setting.name} = ${setting.value};`).join(" ")
            ],
            describe: "Saving the settings"
        }
    ];
}
