import { describe, expect, it } from "vitest";
import { replaceInStoredText, replaceInStoredValue } from "./php-serialize.js";

const FROM = "//staging.example.test";
const TO = "//www.example.test";

/** A PHP string as `serialize()` writes it, counting bytes. */
const s = (text: string) => `s:${Buffer.byteLength(text, "utf8")}:"${text}";`;

describe("replaceInStoredText", () => {
    it("replaces a plain value plainly", () => {
        expect(replaceInStoredText(`https:${FROM}/a`, FROM, TO)).toBe(`https:${TO}/a`);
    });

    it("leaves a value without the address byte for byte", () => {
        const value = `a:1:{i:0;${s("nothing here")}}`;
        expect(replaceInStoredText(value, FROM, TO)).toBe(value);
    });

    it("recounts a serialized string's length", () => {
        expect(replaceInStoredText(s(`https:${FROM}/`), FROM, TO)).toBe(s(`https:${TO}/`));
    });

    it("walks nested arrays and keeps keys, numbers, booleans and nulls", () => {
        const before = `a:3:{s:3:"url";${s(`http:${FROM}`)}i:7;a:2:{i:0;${s(`x ${FROM} y ${FROM}`)}i:1;b:1;}s:4:"rest";a:3:{i:0;N;i:1;d:0.5;i:2;i:-4;}}`;
        const after = `a:3:{s:3:"url";${s(`http:${TO}`)}i:7;a:2:{i:0;${s(`x ${TO} y ${TO}`)}i:1;b:1;}s:4:"rest";a:3:{i:0;N;i:1;d:0.5;i:2;i:-4;}}`;
        expect(replaceInStoredText(before, FROM, TO)).toBe(after);
    });

    it("counts multibyte UTF-8 in bytes", () => {
        const before = `a:1:{s:5:"title";${s(`Café ñandú ${FROM} 日本`)}}`;
        const after = replaceInStoredText(before, FROM, TO);
        expect(after).toBe(`a:1:{s:5:"title";${s(`Café ñandú ${TO} 日本`)}}`);
        expect(after).toContain(`s:${Buffer.byteLength(`Café ñandú ${TO} 日本`, "utf8")}:`);
    });

    it("walks objects, keeping the class and private property names", () => {
        const property = "\0Widget\0link";
        const before = `O:6:"Widget":2:{s:${property.length}:"${property}";${s(`https:${FROM}`)}s:4:"size";i:3;}`;
        const after = `O:6:"Widget":2:{s:${property.length}:"${property}";${s(`https:${TO}`)}s:4:"size";i:3;}`;
        expect(replaceInStoredText(before, FROM, TO)).toBe(after);
    });

    it("walks a serialized value stored inside a serialized string", () => {
        const inner = `a:1:{i:0;${s(`https:${FROM}`)}}`;
        const innerAfter = `a:1:{i:0;${s(`https:${TO}`)}}`;
        expect(replaceInStoredText(`a:1:{i:0;${s(inner)}}`, FROM, TO)).toBe(`a:1:{i:0;${s(innerAfter)}}`);
    });

    it("leaves a malformed serialized value untouched", () => {
        const wrongLength = `a:1:{i:0;s:99:"https:${FROM}";}`;
        const truncated = `a:2:{i:0;${s(`https:${FROM}`)}`;
        const custom = `C:3:"Foo":22:{https:${FROM}};`;
        const trailing = `${s(`https:${FROM}`)}junk;`;
        for (const value of [wrongLength, truncated, custom, trailing]) {
            expect(replaceInStoredText(value, FROM, TO), value).toBe(value);
        }
    });

    it("keeps bytes that are not UTF-8", () => {
        const latin = Buffer.concat([Buffer.from(`s:${FROM.length + 2}:"`, "latin1"), Buffer.from([0xe9, 0xff]), Buffer.from(`${FROM}";`, "latin1")]);
        const out = replaceInStoredValue(latin, FROM, TO);
        expect(out.subarray(0, 4).toString("latin1")).toBe(`s:${TO.length + 2}`.slice(0, 4));
        expect(out.includes(Buffer.from([0xe9, 0xff]))).toBe(true);
        expect(out.toString("latin1").endsWith(`${TO}";`)).toBe(true);
    });

    it("refuses nesting deep enough to exhaust the stack, untouched", () => {
        let value = s(`https:${FROM}`);
        for (let index = 0; index < 400; index += 1) value = `a:1:{i:0;${value}}`;
        expect(replaceInStoredText(value, FROM, TO)).toBe(value);
    });
});
