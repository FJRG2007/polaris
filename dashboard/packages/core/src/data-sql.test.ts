/**
 * The two gates in front of somebody else's database.
 *
 * Both are refusals, so the cases that matter are the ones that would have got
 * through: a name carrying a quote out of its own identifier, a write hiding
 * behind a keyword that reads, a semicolon inside a string being read as the end
 * of a statement.
 */

import { describe, expect, it } from "vitest";
import {
    anyStatementWrites,
    quoteBacktickIdent,
    quoteQualified,
    quoteSqlIdent,
    redisCommandWrites,
    splitStatements,
    statementWrites
} from "./data-sql.js";

describe("putting a name in a statement", () => {
    it("doubles the quote that would have closed it", () => {
        expect(quoteSqlIdent('users"; DROP TABLE users; --')).toBe(
            '"users""; DROP TABLE users; --"'
        );
        expect(quoteBacktickIdent("users`; DROP TABLE users; --")).toBe(
            "`users``; DROP TABLE users; --`"
        );
    });

    it("quotes each part of a dotted name on its own", () => {
        expect(quoteQualified(["public", "users"], quoteSqlIdent)).toBe('"public"."users"');
    });

    it("drops the part that is not there", () => {
        expect(quoteQualified([null, "users"], quoteSqlIdent)).toBe('"users"');
    });
});

describe("judging a statement", () => {
    it("lets a read through", () => {
        expect(statementWrites("SELECT * FROM users")).toBe(false);
        expect(statementWrites("  select 1  ")).toBe(false);
        expect(statementWrites("SHOW TABLES")).toBe(false);
        expect(statementWrites("EXPLAIN SELECT * FROM users")).toBe(false);
    });

    it("catches the obvious writes", () => {
        expect(statementWrites("DELETE FROM users")).toBe(true);
        expect(statementWrites("update users set name = 'x'")).toBe(true);
        expect(statementWrites("DROP TABLE users")).toBe(true);
        expect(statementWrites("TRUNCATE users")).toBe(true);
    });

    it("catches a write hiding behind a CTE", () => {
        expect(
            statementWrites("WITH gone AS (SELECT id FROM users) DELETE FROM logs USING gone")
        ).toBe(true);
    });

    it("catches EXPLAIN ANALYZE, which runs what it explains", () => {
        expect(statementWrites("EXPLAIN ANALYZE DELETE FROM users")).toBe(true);
    });

    it("treats anything it cannot read as a write", () => {
        expect(statementWrites("CALL do_something()")).toBe(true);
        expect(statementWrites("$$ weird $$")).toBe(true);
    });

    it("is not fooled by a comment in front of it", () => {
        expect(statementWrites("-- harmless\nDELETE FROM users")).toBe(true);
        expect(statementWrites("/* nothing to see */ SELECT 1")).toBe(false);
    });

    it("answers for a whole box at once", () => {
        expect(anyStatementWrites("SELECT 1; SELECT 2")).toBe(false);
        expect(anyStatementWrites("SELECT 1; DELETE FROM users")).toBe(true);
    });
});

describe("splitting a box of SQL", () => {
    it("splits on the semicolons between statements", () => {
        expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("does not split on one inside a string", () => {
        expect(splitStatements("SELECT ';' AS x; SELECT 2")).toEqual([
            "SELECT ';' AS x",
            "SELECT 2"
        ]);
    });

    it("does not split on one inside a quoted name", () => {
        expect(splitStatements('SELECT * FROM "odd;name"')).toEqual(['SELECT * FROM "odd;name"']);
    });

    it("keeps a dollar-quoted body whole", () => {
        const body = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql";
        expect(splitStatements(body)).toEqual([body]);
    });

    it("ignores the empty space between semicolons", () => {
        expect(splitStatements(" ; ; SELECT 1 ; ")).toEqual(["SELECT 1"]);
    });
});

describe("judging a Redis command", () => {
    it("lets the reads through", () => {
        expect(redisCommandWrites("GET foo")).toBe(false);
        expect(redisCommandWrites("scan 0 MATCH user:*")).toBe(false);
        expect(redisCommandWrites("INFO keyspace")).toBe(false);
    });

    it("refuses the writes", () => {
        expect(redisCommandWrites("SET foo bar")).toBe(true);
        expect(redisCommandWrites("del foo")).toBe(true);
        expect(redisCommandWrites("FLUSHALL")).toBe(true);
        expect(redisCommandWrites("expire foo 10")).toBe(true);
    });

    it("reads the second word where it decides the answer", () => {
        expect(redisCommandWrites("CONFIG GET maxmemory")).toBe(false);
        expect(redisCommandWrites("CONFIG SET maxmemory 0")).toBe(true);
        expect(redisCommandWrites("CLIENT LIST")).toBe(false);
        expect(redisCommandWrites("CLIENT KILL ID 4")).toBe(true);
    });

    it("treats a command it does not know as a write", () => {
        expect(redisCommandWrites("SOMETHING.NEW key")).toBe(true);
    });
});
