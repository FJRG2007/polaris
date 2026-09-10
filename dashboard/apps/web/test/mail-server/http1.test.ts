/**
 * The HTTP/1.1 exchange a remote mail server is managed over, through an SSH
 * channel. Written by hand, so its two halves are pinned here: what goes out,
 * and how an answer - plain, chunked, or binary - is read back.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { exchangeOverStream, parseHttpResponse, serializeRequest } from "@/lib/mail-server/http1";

describe("the request", () => {
    it("carries the method, path, host, headers, a close and the body length", () => {
        const bytes = serializeRequest({
            method: "POST",
            path: "/jmap/",
            host: "127.0.0.1:8080",
            headers: { authorization: "Basic abc" },
            body: '{"a":"é"}'
        }).toString("utf8");
        expect(bytes.startsWith("POST /jmap/ HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n")).toBe(true);
        expect(bytes).toContain("authorization: Basic abc\r\n");
        expect(bytes).toContain("Connection: close\r\n");
        // Bytes, not characters: the accent is two of them.
        expect(bytes).toContain("Content-Length: 10\r\n\r\n");
    });

    it("refuses a line break in a header, which would start a header of its own", () => {
        expect(() =>
            serializeRequest({
                method: "GET",
                path: "/",
                host: "h",
                headers: { authorization: "x\r\nX-Injected: 1" }
            })
        ).toThrow();
    });
});

describe("the answer", () => {
    it("reads a body by its length", () => {
        const answer = parseHttpResponse(
            Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokEXTRA")
        );
        expect(answer.status).toBe(200);
        expect(answer.body).toBe("ok");
    });

    it("joins a chunked body", () => {
        const answer = parseHttpResponse(
            Buffer.from(
                "HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"
            )
        );
        expect(answer.status).toBe(401);
        expect(answer.body).toBe("Wikipedia");
    });

    it("keeps a binary body as it arrived", () => {
        const payload = Buffer.from([0x1f, 0x8b, 0x00, 0xff]);
        const answer = parseHttpResponse(
            Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n"), payload])
        );
        expect(Buffer.compare(answer.bytes, payload)).toBe(0);
    });

    it("refuses an answer with no end to its headers", () => {
        expect(() =>
            parseHttpResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2"))
        ).toThrow();
    });

    it("is read over a stream until the far side closes", async () => {
        const stream = new PassThrough();
        const written: Buffer[] = [];
        stream.write = ((chunk: Buffer) => {
            written.push(chunk);
            // The far side answers once it has the request, then closes.
            setImmediate(() => {
                stream.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong"));
                stream.push(null);
                stream.end();
            });
            return true;
        }) as typeof stream.write;
        const answer = await exchangeOverStream(stream, {
            method: "GET",
            path: "/.well-known/jmap",
            host: "x",
            headers: {}
        });
        expect(answer.body).toBe("pong");
        expect(Buffer.concat(written).toString("latin1")).toContain(
            "GET /.well-known/jmap HTTP/1.1"
        );
    });
});
