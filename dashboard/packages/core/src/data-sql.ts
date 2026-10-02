/**
 * The two rules that keep a database browser from being a way to break a
 * database: how a name is put into a statement, and how a statement typed by a
 * person is judged before it is sent.
 *
 * Pure on purpose, and here rather than beside the drivers, because both are
 * decisions rather than plumbing - the kind that has to be readable in a test
 * next to the input that would have got it wrong.
 *
 * **Names.** A table, a schema and a column arrive from a browser and go into a
 * statement in a position no parameter can occupy, so each is quoted the way its
 * engine quotes one and the quote character inside it is doubled. That is the
 * standard escape and it is what the engine's own tooling does. It is the second
 * gate, not the only one: a name that came from a list Polaris itself read is
 * checked against that list before it gets here.
 *
 * **Statements.** A read-only connection has to refuse a write, and the honest
 * way to do that is to ask the engine (a read-only transaction, a replica) - so
 * that is what the drivers do. This is the gate in front of it: it reads the
 * leading keyword of every statement in the box and refuses the ones that
 * obviously write, so the common mistake is caught before a socket is opened and
 * with a sentence about the connection rather than a syntax error from Postgres.
 * It is deliberately not a SQL parser. Anything it is unsure about it calls a
 * write, because the failure it exists to prevent is a write that got through.
 */

/** Double-quoted identifier: PostgreSQL, and standard SQL. */
export function quoteSqlIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Backtick-quoted identifier: MySQL and MariaDB. */
export function quoteBacktickIdent(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * A dotted name, quoted part by part.
 *
 * `public.users` is two identifiers and one separator, and quoting the whole
 * thing as one produces a table nobody has called "public.users". Absent parts
 * are dropped, so a table with no schema is just the table.
 */
export function quoteQualified(
    parts: readonly (string | null | undefined)[],
    quote: (name: string) => string
): string {
    return parts
        .filter((part): part is string => Boolean(part))
        .map(quote)
        .join(".");
}

/**
 * Which engine's grammar a statement is read in. They disagree on exactly the
 * characters that decide where a comment starts: `#` is a comment in MySQL and
 * the XOR operator in PostgreSQL, `-- ` needs a space after it in MySQL, a
 * backslash escapes a quote in a MySQL string and only in an `E'...'` string in
 * PostgreSQL, and a MySQL comment that opens with `/*!` is not a comment at
 * all - it is code the server runs. Reading one engine's statement with the
 * other's rules is how a write ends up inside what the gate took for a comment.
 */
export type SqlDialect = "postgres" | "mysql";

/** The statements a read-only connection is allowed to send. Anything not on
 *  this list is treated as a write. */
const READ_KEYWORDS = new Set([
    "select",
    "show",
    "explain",
    "describe",
    "desc",
    "with",
    "table",
    "values",
    "analyze"
]);

/**
 * Words that make a statement a write wherever they stand in it.
 *
 * The keywords are the obvious ones. The functions are the ones a read-only
 * transaction does not stop, because what they change is not a table: ending
 * somebody else's session, reloading the server's configuration, writing a
 * file on the database server, reaching another database through `dblink`, or
 * changing a setting the rest of the session runs under.
 */
const WRITE_WORDS =
    /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|do|vacuum|reindex|copy|replace|rename|set|lock|refresh|comment|import|load|flush|kill|shutdown|handler|outfile|dumpfile|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_file_write|pg_file_rename|pg_file_unlink|pg_file_sync|lo_export|lo_import|lo_unlink|lo_create|lo_from_bytea|lo_put|lo_truncate|dblink\w*|pg_notify|nextval|setval|pg_stat_reset\w*|pg_advisory\w*|pg_try_advisory\w*|pg_log_backend_memory_contexts)\b/i;

/**
 * A statement whose leading keyword reads, and which does not carry a writing
 * one behind it.
 *
 * `WITH` is the awkward one: a common table expression reads, right up until it
 * ends in `INSERT`, `UPDATE` or `DELETE`, which PostgreSQL allows. `EXPLAIN
 * ANALYZE` is worse - it runs the statement it is explaining. So a leading
 * keyword that reads is not enough on its own: the body is searched for a
 * writing keyword standing on its own, and finding one makes the whole thing a
 * write. String contents are searched too, on purpose: a word that only looks
 * like a write inside a string costs a refusal, and a string this reader got
 * wrong would otherwise cost a write.
 */
export function statementWrites(statement: string, dialect: SqlDialect = "mysql"): boolean {
    const bare = stripComments(statement, dialect).trim();
    if (!bare) return false;
    const leading = bare.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? "";
    if (!READ_KEYWORDS.has(leading)) return true;
    if (leading === "explain" && /\banalyz[es]e?\b/i.test(bare)) return true;
    return WRITE_WORDS.test(bare);
}

/** Whether anything in this box writes. What a read-only connection refuses on. */
export function anyStatementWrites(sql: string, dialect: SqlDialect = "mysql"): boolean {
    return splitStatements(sql, dialect).some((statement) => statementWrites(statement, dialect));
}

/** One run of a statement, as the engine would read it. */
interface SqlPiece {
    readonly kind: "code" | "quoted" | "comment" | "separator";
    readonly text: string;
}

/** A dollar-quote tag: `$$`, or `$name$` where the name reads as an identifier. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/;

/**
 * A box of SQL cut into code, quoted runs, comments and separators, by the
 * rules of one engine.
 *
 * Where this cannot be sure, it leans towards calling something code: code is
 * searched for writing keywords and a comment is not, so the safe mistake is
 * the one that leaves more text in view.
 */
function pieces(sql: string, dialect: SqlDialect): SqlPiece[] {
    const out: SqlPiece[] = [];
    let code = "";
    const flush = () => {
        if (code) out.push({ kind: "code", text: code });
        code = "";
    };
    let index = 0;
    while (index < sql.length) {
        const char = sql[index] as string;
        const next = sql[index + 1] ?? "";

        // A line comment runs to the newline. MySQL only reads `--` as one when
        // whitespace or a control character follows it: `1--1` is arithmetic.
        const dashes =
            char === "-" &&
            next === "-" &&
            (dialect === "postgres" ||
                index + 2 >= sql.length ||
                /[\s\x00-\x1f]/.test(sql[index + 2] as string));
        if (dashes || (char === "#" && dialect === "mysql")) {
            const end = sql.indexOf("\n", index);
            const stop = end === -1 ? sql.length : end;
            flush();
            out.push({ kind: "comment", text: sql.slice(index, stop) });
            index = stop;
            continue;
        }

        if (char === "/" && next === "*") {
            const end = sql.indexOf("*/", index + 2);
            const stop = end === -1 ? sql.length : end + 2;
            const body = sql.slice(index, stop);
            // MySQL runs what is inside `/*! ... */` (and MariaDB `/*M! ... */`),
            // so it is code, markers and all.
            if (dialect === "mysql" && /^\/\*(!|M!)/.test(body)) {
                code += body;
            } else {
                flush();
                out.push({ kind: "comment", text: body });
            }
            index = stop;
            continue;
        }

        // Dollar quoting: $tag$ ... $tag$, which is how a PL/pgSQL body is
        // written and the one place a semicolon is certainly not a separator.
        if (dialect === "postgres" && char === "$" && !/[A-Za-z0-9_]$/.test(code)) {
            const dollar = sql.slice(index, index + 128).match(DOLLAR_TAG);
            if (dollar) {
                const tag = dollar[0];
                const end = sql.indexOf(tag, index + tag.length);
                const stop = end === -1 ? sql.length : end + tag.length;
                flush();
                out.push({ kind: "quoted", text: sql.slice(index, stop) });
                index = stop;
                continue;
            }
        }

        if (char === "'" || char === '"' || (char === "`" && dialect === "mysql")) {
            // PostgreSQL reads a backslash as an escape only in an E'' string.
            const backslash =
                char === "'" &&
                (dialect === "mysql" || (/[eE]$/.test(code) && !/[A-Za-z0-9_][eE]$/.test(code)));
            const stop = closingQuote(sql, index, char, backslash);
            flush();
            out.push({ kind: "quoted", text: sql.slice(index, stop) });
            index = stop;
            continue;
        }

        if (char === ";") {
            flush();
            out.push({ kind: "separator", text: ";" });
            index += 1;
            continue;
        }

        code += char;
        index += 1;
    }
    flush();
    return out;
}

/**
 * One box of SQL, split into statements.
 *
 * Semicolons inside a string, an identifier or a dollar-quoted body are not
 * separators, and treating them as one splits a perfectly good function
 * definition into three broken ones. Comments are left in place: they are part
 * of the statement somebody typed and the engine reads them fine.
 */
export function splitStatements(sql: string, dialect: SqlDialect = "mysql"): string[] {
    const statements: string[] = [];
    let current = "";
    for (const piece of pieces(sql, dialect)) {
        if (piece.kind === "separator") {
            if (current.trim()) statements.push(current.trim());
            current = "";
            continue;
        }
        current += piece.text;
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

/** Where the quoted run starting at `from` ends, past the closing quote. A
 *  doubled quote is an escaped one and does not close it, and so is a quote
 *  after a backslash where the engine reads a backslash as an escape. */
function closingQuote(sql: string, from: number, quote: string, backslash: boolean): number {
    let index = from + 1;
    while (index < sql.length) {
        if (backslash && sql[index] === "\\") {
            index += 2;
            continue;
        }
        if (sql[index] === quote) {
            if (sql[index + 1] === quote) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    return sql.length;
}

/** The statement with its comments taken out, for reading its keywords. Never
 *  for sending: what is sent is what was typed. A comment marker inside a
 *  string is part of the string, and stays. */
function stripComments(statement: string, dialect: SqlDialect): string {
    return pieces(statement, dialect)
        .map((piece) => (piece.kind === "comment" ? " " : piece.text))
        .join("");
}
/** The Redis commands a read-only connection may send. Everything else writes,
 *  including the ones that only look administrative - FLUSHALL is not a read. */
const REDIS_READS = new Set([
    "get",
    "mget",
    "strlen",
    "exists",
    "ttl",
    "pttl",
    "type",
    "keys",
    "scan",
    "randomkey",
    "dbsize",
    "hget",
    "hmget",
    "hgetall",
    "hkeys",
    "hvals",
    "hlen",
    "hexists",
    "hscan",
    "hrandfield",
    "hstrlen",
    "lrange",
    "llen",
    "lindex",
    "lpos",
    "smembers",
    "sismember",
    "smismember",
    "scard",
    "srandmember",
    "sscan",
    "sinter",
    "sunion",
    "sdiff",
    "zrange",
    "zrangebyscore",
    "zrangebylex",
    "zrevrange",
    "zscore",
    "zmscore",
    "zcard",
    "zcount",
    "zrank",
    "zrevrank",
    "zscan",
    "xrange",
    "xrevrange",
    "xlen",
    "xinfo",
    "getrange",
    "bitcount",
    "getbit",
    "object",
    "memory",
    "info",
    "ping",
    "echo",
    "time",
    "command",
    "config",
    "client",
    "lolwut",
    "json.get",
    "json.type",
    "json.arrlen",
    "geodist",
    "geopos",
    "geosearch",
    "geohash",
    "pfcount",
    "lcs",
    "sintercard",
    "expiretime",
    "pexpiretime"
]);

/**
 * Whether a Redis command writes.
 *
 * By name rather than by class, because Redis has no statement grammar to read:
 * the first word is the command and the rest are arguments. `CONFIG` and
 * `CLIENT` are on the read list for their `GET`/`LIST` forms and are refused
 * below when they carry a subcommand that sets something - which is the one
 * place a command's second word decides the answer.
 */
export function redisCommandWrites(command: string): boolean {
    const words = command.trim().split(/\s+/);
    const name = (words[0] ?? "").toLowerCase();
    if (!name) return false;
    if (!REDIS_READS.has(name)) return true;
    const sub = (words[1] ?? "").toLowerCase();
    if (name === "config" && sub !== "get") return true;
    if (name === "client" && !["list", "info", "getname", "id", "no-evict"].includes(sub))
        return true;
    if (name === "object" && !["encoding", "freq", "idletime", "refcount", "help"].includes(sub))
        return true;
    if (name === "memory" && !["usage", "stats", "doctor", "help"].includes(sub)) return true;
    if (name === "xinfo" && !["stream", "groups", "consumers", "help"].includes(sub)) return true;
    return false;
}
