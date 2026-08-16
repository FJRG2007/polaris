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
    return parts.filter((part): part is string => Boolean(part)).map(quote).join(".");
}

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
 * A statement whose leading keyword reads, and which does not carry a writing
 * one behind it.
 *
 * `WITH` is the awkward one: a common table expression reads, right up until it
 * ends in `INSERT`, `UPDATE` or `DELETE`, which PostgreSQL allows. `EXPLAIN
 * ANALYZE` is worse - it runs the statement it is explaining. So a leading
 * keyword that reads is not enough on its own: the body is searched for a
 * writing keyword standing on its own, and finding one makes the whole thing a
 * write.
 */
export function statementWrites(statement: string): boolean {
    const bare = stripComments(statement).trim();
    if (!bare) return false;
    const leading = bare.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? "";
    if (!READ_KEYWORDS.has(leading)) return true;
    if (leading === "explain" && /\banalyz[es]e?\b/i.test(bare)) return true;
    return /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|do|vacuum|reindex|copy|replace|rename|set|lock|refresh|comment|import|load|flush|kill|shutdown)\b/i.test(
        bare
    );
}

/** Whether anything in this box writes. What a read-only connection refuses on. */
export function anyStatementWrites(sql: string): boolean {
    return splitStatements(sql).some(statementWrites);
}

/**
 * One box of SQL, split into statements.
 *
 * Semicolons inside a string, an identifier or a dollar-quoted body are not
 * separators, and treating them as one splits a perfectly good function
 * definition into three broken ones. Comments are left in place: they are part
 * of the statement somebody typed and the engine reads them fine.
 */
export function splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = "";
    let index = 0;
    while (index < sql.length) {
        const char = sql[index] as string;
        const rest = sql.slice(index);

        // A line comment runs to the newline; a block comment to its close.
        // Copied across rather than skipped, so what is sent is what was typed.
        const line = rest.match(/^(--|#)[^\n]*/);
        if (line) {
            current += line[0];
            index += line[0].length;
            continue;
        }
        if (rest.startsWith("/*")) {
            const end = sql.indexOf("*/", index + 2);
            const stop = end === -1 ? sql.length : end + 2;
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }

        // Dollar quoting: $tag$ ... $tag$, which is how a PL/pgSQL body is
        // written and the one place a semicolon is certainly not a separator.
        const dollar = rest.match(/^\$[A-Za-z_]*\$/);
        if (dollar) {
            const tag = dollar[0];
            const end = sql.indexOf(tag, index + tag.length);
            const stop = end === -1 ? sql.length : end + tag.length;
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }

        if (char === "'" || char === '"' || char === "`") {
            const stop = closingQuote(sql, index, char);
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }

        if (char === ";") {
            if (current.trim()) statements.push(current.trim());
            current = "";
            index += 1;
            continue;
        }

        current += char;
        index += 1;
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

/** Where the quoted run starting at `from` ends, past the closing quote. A
 *  doubled quote is an escaped one and does not close it. */
function closingQuote(sql: string, from: number, quote: string): number {
    let index = from + 1;
    while (index < sql.length) {
        if (sql[index] === "\\" && quote === "'") {
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
 *  for sending: what is sent is what was typed. */
function stripComments(statement: string): string {
    return statement
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|\s)(--|#)[^\n]*/g, "$1 ");
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
    if (name === "client" && !["list", "info", "getname", "id", "no-evict"].includes(sub)) return true;
    if (name === "object" && !["encoding", "freq", "idletime", "refcount", "help"].includes(sub)) return true;
    if (name === "memory" && !["usage", "stats", "doctor", "help"].includes(sub)) return true;
    if (name === "xinfo" && !["stream", "groups", "consumers", "help"].includes(sub)) return true;
    return false;
}
