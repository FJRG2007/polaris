/**
 * Reading the command line: strict about options nobody defined, and strict
 * about what an address is before it is stored as a profile.
 */

import { describe, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import { normalizeUrl, parse } from "../../src/args.js";

describe("parse", () => {
    it("splits the command from its arguments and reads every flag", () => {
        const parsed = parse([
            "logs",
            "shop/web",
            "--follow",
            "--tail",
            "50",
            "--profile",
            "work",
            "--json"
        ]);
        expect(parsed.positionals).toEqual(["logs", "shop/web"]);
        expect(parsed.flags).toMatchObject({
            follow: true,
            tail: 50,
            profile: "work",
            json: true,
            browserless: false
        });
    });

    it("takes the short forms and --flag=value", () => {
        const parsed = parse(["deploy", "web", "-f", "--url=https://polaris.example.com"]);
        expect(parsed.flags.follow).toBe(true);
        expect(parsed.flags.url).toBe("https://polaris.example.com");
    });

    it("refuses an option it does not know rather than ignoring it", () => {
        expect(() => parse(["deploy", "web", "--folow"])).toThrow(CliError);
        try {
            parse(["deploy", "web", "--folow"]);
        } catch (caught) {
            expect((caught as CliError).exitCode).toBe(2);
            expect((caught as CliError).message).toContain("plr help");
        }
    });

    it("refuses a tail that is not a whole number in range", () => {
        for (const tail of ["0", "-3", "1.5", "abc", "5001"]) {
            expect(() => parse(["logs", "web", `--tail=${tail}`])).toThrow(
                /--tail takes a whole number/
            );
        }
        expect(parse(["logs", "web", "--tail", "5000"]).flags.tail).toBe(5000);
    });

    it("refuses an empty --url or --profile", () => {
        expect(() => parse(["login", "--url="])).toThrow(/--url needs a value/);
        expect(() => parse(["login", "--profile="])).toThrow(/--profile needs a value/);
    });
});

describe("normalizeUrl", () => {
    it("stores an origin with no trailing slash", () => {
        expect(normalizeUrl("https://polaris.example.com/")).toBe("https://polaris.example.com");
        expect(normalizeUrl("  http://polaris.local  ")).toBe("http://polaris.local");
        expect(normalizeUrl("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
    });

    it("assumes https for a bare host name", () => {
        expect(normalizeUrl("polaris.example.com")).toBe("https://polaris.example.com");
    });

    it("refuses anything that is not a plain Polaris address", () => {
        expect(() => normalizeUrl("ftp://polaris.example.com")).toThrow(/https:\/\//);
        expect(() => normalizeUrl("https://user:pass@polaris.example.com")).toThrow(
            /user name and password/
        );
        expect(() => normalizeUrl("https://polaris.example.com/account")).toThrow(/without a path/);
        expect(() => normalizeUrl("https://polaris.example.com/?x=1")).toThrow(/without a path/);
        expect(() => normalizeUrl("http://")).toThrow(CliError);
    });
});
