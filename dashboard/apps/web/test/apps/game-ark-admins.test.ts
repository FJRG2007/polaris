import { describe, expect, it } from "vitest";
import {
    MAX_ADMINS,
    formatAdminList,
    parseAdminList,
    withAdmin,
    withoutAdmin
} from "@/lib/apps/ark/admins";

const ONE = "76561198012345678";
const TWO = "76561198087654321";

describe("parseAdminList", () => {
    it("reads the ids in the order the file holds them", () => {
        expect(parseAdminList(`${ONE}\n${TWO}\n`)).toEqual([ONE, TWO]);
    });

    it("survives a file somebody edited by hand", () => {
        // Blank lines, a comment, Windows line endings and a stray space are all
        // things a hand-edited file has in it.
        expect(parseAdminList(`\r\n# the admins\r\n  ${ONE}  \r\n\r\n${TWO}`)).toEqual([ONE, TWO]);
    });

    it("drops anything that is not a Steam id", () => {
        expect(parseAdminList(`123\nnotanid\n${ONE}`)).toEqual([ONE]);
    });

    it("lists somebody once even when the file names them twice", () => {
        expect(parseAdminList(`${ONE}\n${ONE}`)).toEqual([ONE]);
    });

    it("reads an empty file as nobody", () => {
        expect(parseAdminList("")).toEqual([]);
    });
});

describe("formatAdminList", () => {
    it("ends the file with a newline, so an appended id is its own line", () => {
        expect(formatAdminList([ONE, TWO])).toBe(`${ONE}\n${TWO}\n`);
    });

    it("writes an empty file for nobody rather than a blank line", () => {
        expect(formatAdminList([])).toBe("");
    });

    it("round-trips", () => {
        expect(parseAdminList(formatAdminList([ONE, TWO]))).toEqual([ONE, TWO]);
    });
});

describe("withAdmin", () => {
    it("adds somebody", () => {
        expect(withAdmin([ONE], TWO)).toEqual([ONE, TWO]);
    });

    it("changes nothing for somebody who is already one", () => {
        expect(withAdmin([ONE], ONE)).toEqual([ONE]);
    });

    it("refuses anything that is not a Steam id", () => {
        expect(() => withAdmin([], "12345")).toThrow();
    });

    it("refuses to grow past the ceiling", () => {
        const full = Array.from({ length: MAX_ADMINS }, (_, index) => `7656119${String(index).padStart(10, "0")}`);
        expect(() => withAdmin(full, ONE)).toThrow();
    });
});

describe("withoutAdmin", () => {
    it("takes one off and leaves the rest", () => {
        expect(withoutAdmin([ONE, TWO], ONE)).toEqual([TWO]);
    });

    it("changes nothing for somebody who was never one", () => {
        expect(withoutAdmin([ONE], TWO)).toEqual([ONE]);
    });
});
