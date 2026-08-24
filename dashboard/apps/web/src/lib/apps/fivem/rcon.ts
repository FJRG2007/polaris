/**
 * The console protocol a FiveM server speaks, as bytes.
 *
 * FXServer has no console socket of the kind the other games here have: its own
 * console is the process' standard input, which is not something a container can
 * be asked for from outside. What it does have is the Quake console protocol its
 * engine inherited - one UDP datagram carrying `rcon <password> <command>`, and
 * one back carrying whatever the server printed. It is off until the server is
 * given an `rcon_password`, which is minted per server here and never left at
 * the image's own.
 *
 * Pure and byte-level on purpose. The datagram is built here and handed to the
 * transport already encoded, so a command an operator typed is never interpolated
 * into a shell command on the way to the server - and the reply is parsed from the
 * bytes rather than from a string, because the four leading `0xFF`s are not valid
 * UTF-8 and do not survive being decoded as text.
 */

/** Every datagram of this protocol begins with this, request and reply alike. */
const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** What the server puts in front of what it printed. */
const PRINT_PREFIX = "print\n";

/**
 * The colour codes the game console marks its own output with.
 *
 * `^1` through `^9` and `^0`, which are how FXServer says "this part is red".
 * They belong on a terminal that understands them and read as noise anywhere
 * else, which here is a web page.
 */
const COLOR_CODE = /\^\d/g;

/** How the server names a password it did not accept. Either half is enough: the
 *  wording has changed between builds and the point is the same both times. */
const REFUSAL = /invalid password|rcon_password/i;

/** The longest command Polaris will send. A datagram has to fit in one packet,
 *  and no screen here composes anything close to this. */
export const MAX_COMMAND_LENGTH = 512;

/**
 * The datagram that asks a server to run one command.
 *
 * The password rides in the clear, which is the protocol and not a choice - so
 * this is only ever sent from inside the server's own container, never across a
 * network. See `transport.ts`.
 */
export function rconRequest(password: string, command: string): Buffer {
    return Buffer.concat([HEADER, Buffer.from(`rcon ${password} ${command}\n`, "utf8")]);
}

/**
 * What the server said, out of one or more reply datagrams.
 *
 * More than one because a long answer - the resource list, a player dump - does
 * not fit in a single packet, and the transport hands back everything that
 * arrived within its window concatenated. Each datagram carries its own header
 * and its own `print`, so the split is on the header rather than at the front.
 */
export function parseRconReply(raw: Buffer): string {
    const parts: string[] = [];
    let at = 0;
    while (at < raw.length) {
        const next = raw.indexOf(HEADER, at + 1);
        const end = next === -1 ? raw.length : next;
        parts.push(oneReply(raw.subarray(at, end)));
        at = end;
    }
    // A reply that carried no header at all is still worth showing: it is the only
    // thing there is to say when something other than the server answered.
    return (parts.length > 0 ? parts.join("") : raw.toString("utf8")).trim();
}

/** One datagram, without its header and its `print`. */
function oneReply(datagram: Buffer): string {
    const body = datagram.subarray(0, 4).equals(HEADER) ? datagram.subarray(4) : datagram;
    const text = body.toString("utf8");
    return stripColorCodes(text.startsWith(PRINT_PREFIX) ? text.slice(PRINT_PREFIX.length) : text);
}

/** The same text with the console's own colouring taken out. */
export function stripColorCodes(text: string): string {
    return text.replace(COLOR_CODE, "");
}

/** Whether what came back is the server refusing the password rather than
 *  answering the command. */
export function isRconRefusal(text: string): boolean {
    return REFUSAL.test(text);
}

/** Whether a command is one Polaris will send at all. A newline would turn one
 *  command into two, and a null byte would truncate the datagram. */
export function isSafeCommand(command: string): boolean {
    return command.length > 0 && command.length <= MAX_COMMAND_LENGTH && !/[\0\r\n]/.test(command);
}

/**
 * One argument as the console tokenizer will read it back.
 *
 * FXServer splits a console line on whitespace and treats a double quote as the
 * start of a run that ignores it. There is no escape inside that run, so a value
 * containing a quote cannot be expressed - it is refused rather than mangled,
 * which is the difference between a rejected name and a command that silently
 * means something else.
 */
export function quoteArgument(value: string): string {
    if (value.includes('"')) throw new Error("A double quote is not something the game console can carry");
    return /[\s;]/.test(value) || value.length === 0 ? `"${value}"` : value;
}
