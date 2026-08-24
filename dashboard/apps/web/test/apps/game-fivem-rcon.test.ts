/**
 * The console protocol a FiveM server speaks.
 *
 * Worth pinning down here rather than trusting to a live server, because every
 * part of it is bytes nobody can eyeball: the request has four `0xFF`s in front of
 * it, the reply has the same four plus the word `print` and a newline, and a long
 * answer arrives as several datagrams concatenated with a header in the middle.
 * Reading that wrongly does not fail loudly - it prints a console answer with four
 * replacement characters and the word "print" glued to the front of it.
 *
 * The other half is refusal. A server that did not accept the password answers
 * exactly like one that ran the command and had nothing to say, and telling those
 * apart is the difference between "the console is not working" and a message that
 * names the password.
 */

import { describe, expect, it } from "vitest";
import * as rcon from "@/lib/apps/fivem/rcon";

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** One reply datagram, as the server builds it. */
function reply(body: string): Buffer {
    return Buffer.concat([HEADER, Buffer.from(`print\n${body}`, "utf8")]);
}

describe("the request", () => {
    it("is the four header bytes and then the command", () => {
        const packet = rcon.rconRequest("hunter2", "status");
        expect([...packet.subarray(0, 4)]).toEqual([0xff, 0xff, 0xff, 0xff]);
        expect(packet.subarray(4).toString("utf8")).toBe("rcon hunter2 status\n");
    });
});

describe("the reply", () => {
    it("drops the header and the print that comes with it", () => {
        expect(rcon.parseRconReply(reply("2 players"))).toBe("2 players");
    });

    it("joins several datagrams, each with a header of its own", () => {
        const long = Buffer.concat([reply("first line\n"), reply("second line")]);
        expect(rcon.parseRconReply(long)).toBe("first line\nsecond line");
    });

    it("takes the console's own colour codes out", () => {
        expect(rcon.parseRconReply(reply("^2started ^7resource"))).toBe("started resource");
    });

    it("hands back whatever arrived when it carried no header at all", () => {
        expect(rcon.parseRconReply(Buffer.from("something else", "utf8"))).toBe("something else");
    });
});

describe("a refusal", () => {
    it("is recognised however the build words it", () => {
        expect(rcon.isRconRefusal("Invalid password.")).toBe(true);
        expect(rcon.isRconRefusal("The server must set rcon_password to use this command")).toBe(true);
    });

    it("is not an ordinary answer", () => {
        expect(rcon.isRconRefusal("2 players")).toBe(false);
        expect(rcon.isRconRefusal("")).toBe(false);
    });
});

describe("a command", () => {
    it("is refused when it would become two", () => {
        expect(rcon.isSafeCommand("say hello")).toBe(true);
        expect(rcon.isSafeCommand("say hello\nquit")).toBe(false);
        expect(rcon.isSafeCommand("say hello\r\nquit")).toBe(false);
        expect(rcon.isSafeCommand("say \0quit")).toBe(false);
    });

    it("is refused when it is empty or longer than a datagram should carry", () => {
        expect(rcon.isSafeCommand("")).toBe(false);
        expect(rcon.isSafeCommand("x".repeat(rcon.MAX_COMMAND_LENGTH + 1))).toBe(false);
    });
});

describe("an argument", () => {
    it("is quoted only when the console would otherwise split it", () => {
        expect(rcon.quoteArgument("hello")).toBe("hello");
        expect(rcon.quoteArgument("hello there")).toBe('"hello there"');
        expect(rcon.quoteArgument("")).toBe('""');
    });

    it("is refused rather than mangled when it holds a quote of its own", () => {
        // The console's tokenizer has no escape inside a quoted run, so there is no
        // honest way to express this - and a mangled one is a different command.
        expect(() => rcon.quoteArgument('say "hi"')).toThrow();
    });
});
