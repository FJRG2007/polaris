import { describe, expect, it } from "vitest";
import { changePasswordCommands, type PasswordChange } from "../src/index.js";

const base: PasswordChange = {
    engine: "postgres",
    username: "polaris",
    database: "shop",
    newPassword: "Gk2_x-9ZqLmN4pRsTuVwXyZ01234abcd",
    adminUser: "polaris",
    adminPassword: "old-password",
    hosted: false
};

describe("changing a password", () => {
    it("alters the PostgreSQL role, quoted, through psql with no shell", () => {
        const [command] = changePasswordCommands(base);
        expect(command?.argv).toEqual([
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "polaris",
            "-d",
            "postgres",
            "-c",
            `ALTER ROLE "polaris" WITH PASSWORD 'Gk2_x-9ZqLmN4pRsTuVwXyZ01234abcd'`
        ]);
    });

    it("moves root with a dedicated MySQL instance, and only the account on a hosted one", () => {
        const dedicated = changePasswordCommands({ ...base, engine: "mysql" })[0]?.argv ?? [];
        expect(dedicated.slice(0, 3)).toEqual(["mysql", "-uroot", "-pold-password"]);
        expect(dedicated[4]).toContain("'root'@'localhost'");
        const hosted =
            changePasswordCommands({ ...base, engine: "mariadb", hosted: true })[0]?.argv ?? [];
        expect(hosted[0]).toBe("mariadb");
        expect(hosted[4]).not.toContain("root");
    });

    it("changes a MongoDB user where it lives, and Redis' requirepass", () => {
        expect(changePasswordCommands({ ...base, engine: "mongo" })[0]?.argv.at(-1)).toBe(
            'db.getSiblingDB("admin").changeUserPassword("polaris", "Gk2_x-9ZqLmN4pRsTuVwXyZ01234abcd")'
        );
        expect(
            changePasswordCommands({ ...base, engine: "mongo", hosted: true })[0]?.argv.at(-1)
        ).toContain('getSiblingDB("shop")');
        expect(changePasswordCommands({ ...base, engine: "redis" })[0]?.argv.slice(-3)).toEqual([
            "SET",
            "requirepass",
            "Gk2_x-9ZqLmN4pRsTuVwXyZ01234abcd"
        ]);
    });

    it("refuses a password Polaris did not generate, so a literal cannot be ended", () => {
        expect(() =>
            changePasswordCommands({ ...base, newPassword: "abc'; DROP ROLE x; --abcdefgh" })
        ).toThrow(/generated/);
        expect(() => changePasswordCommands({ ...base, newPassword: "short" })).toThrow(
            /generated/
        );
    });
});
