/**
 * The search panel's calculator: arithmetic in, a number out, and anything that
 * is not arithmetic left alone so the panel goes on searching for it.
 */

import { describe, expect, it } from "vitest";
import { calculate, calculationText } from "@/lib/search/calculate";

describe("calculate", () => {
    it.each([
        ["1 + 2", 3],
        ["10 - 4 - 3", 3],
        ["2 * 3 + 4", 10],
        ["2 * (3 + 4)", 14],
        ["7 / 2", 3.5],
        ["7 % 3", 1],
        ["2 ^ 10", 1024],
        ["2 ** 3", 8],
        ["2 ^ 3 ^ 2", 512],
        ["-2 ^ 2", -4],
        ["(-2) ^ 2", 4],
        ["2 ^ -1", 0.5],
        ["-3 + 5", 2],
        ["--3 + 1", 4],
        ["1.5 * 4", 6],
        [".5 + .25", 0.75],
        ["0.1 + 0.2", 0.3],
        ["sqrt(16)", 4],
        ["abs(-7)", 7],
        ["round(2.5)", 3],
        ["floor(2.9)", 2],
        ["ceil(2.1)", 3],
        ["log(1000)", 3],
        ["ln(e)", 1],
        ["sin(0)", 0],
        ["cos(0)", 1],
        ["tan(0)", 0],
        ["sin(pi / 2)", 1],
        ["2pi", Number((2 * Math.PI).toPrecision(10))],
        ["3(4 + 1)", 15],
        ["3 x 4", 12],
        ["7/2", 3.5],
        ["2*3", 6],
        ["6 ÷ 3 × 2", 4],
        ["SQRT(9) + PI - pi", 3],
        ["12*3+4", 40],
        ["(2+3)^2", 25],
        ["10/4", 2.5],
        ["1,5 + 1,25", 2.75],
        ["2,5*2", 5],
        ["-3*-2", 6],
        ["15% of 200", 30],
        ["15 % OF 200 + 1", 31],
        ["50% of (10 + 10)", 10],
        ["1/3", 0.3333333333],
        ["2/3", 0.6666666667],
        ["0.1 * 3", 0.3]
    ])("%s = %d", (input, expected) => {
        expect(calculate(input)).toBe(expected);
    });

    it.each([
        "",
        "   ",
        "42",
        "-5",
        "(5)",
        "pi",
        "e",
        "hello",
        "deploy app 2",
        "1 +",
        "(1 + 2",
        "1 + 2)",
        "2 3",
        "1 / 0",
        "sqrt(-1)",
        "constructor(1)",
        "toString(1) + 1",
        "foo(2) + 1",
        "1 + 2; alert(1)",
        "process.exit(1)",
        "1 + 2 = 3",
        "2024-10-13",
        "555-1234",
        "1.2.3-4",
        "3x4",
        "1920x1080",
        "10/13/2024",
        "12*",
        "abc",
        "/tasks",
        "/2",
        "@ana",
        "@1 + 1",
        "1,000",
        "1,2,3",
        "15 of 200",
        "% of 200",
        "0 / 0"
    ])("leaves %j alone", (input) => {
        expect(calculate(input)).toBeNull();
    });

    it("refuses input too long or too deep instead of working on it", () => {
        expect(calculate(`${"1 + ".repeat(60)}1`)).toBeNull();
        expect(calculate(`${"(".repeat(90)}1 + 1${")".repeat(90)}`)).toBeNull();
        expect(calculate(`${"-".repeat(150)}1 + 1`)).toBeNull();
    });

    it("copies plain digits", () => {
        expect(calculationText(calculate("1000 * 1000")!)).toBe("1000000");
        expect(calculationText(calculate("1 / 4")!)).toBe("0.25");
        expect(calculationText(calculate("12345 * 1000")!)).toBe("12345000");
        expect(calculationText(calculate("-5 * 2")!)).toBe("-10");
    });

    it("copies text that reads back as the same number, never an exponent", () => {
        for (const input of ["10 ^ 21 * 3", "10 ^ -7 * 4", "2 / 3", "123456789 * 987654321"]) {
            const value = calculate(input)!;
            const text = calculationText(value);
            expect(text).not.toMatch(/e/i);
            expect(calculate(`${text} * 1`)).toBe(value);
        }
    });
});
