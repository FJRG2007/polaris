/**
 * MongoDB, read as databases of collections of documents.
 *
 * The awkward part of putting a document store in a grid is that there are no
 * columns: two documents in one collection can share nothing. So the columns are
 * inferred from a sample of the collection rather than declared - the fields of
 * the first page, in the order they were first seen - and every value that is
 * not a scalar is handed to the screen as JSON. That is honest about what it is:
 * a view of these documents, not a schema.
 *
 * `run` takes a command document rather than a query language. Mongo's shell
 * syntax is JavaScript, and the way to support it would be to evaluate what
 * somebody typed, which is not something this is going to do. A command document
 * is what the driver sends anyway, it covers find, aggregate, count and the
 * administrative reads, and it is data rather than code.
 */

import * as data from "../driver";
import { MongoClient, type Document } from "mongodb";

/** Databases that belong to the server rather than to anybody's application. */
const SYSTEM_DATABASES = ["admin", "local", "config"];

/** How many documents are read to work out what the columns are. Enough to see
 *  the optional fields, few enough to be one round trip. */
const SAMPLE = 50;

/** Commands that only read. Anything else is refused on a read-only connection -
 *  by name, because a command document has no grammar to inspect. */
const READ_COMMANDS = new Set([
    "find",
    "aggregate",
    "count",
    "distinct",
    "listcollections",
    "listindexes",
    "listdatabases",
    "dbstats",
    "collstats",
    "explain",
    "ping",
    "buildinfo",
    "hello",
    "serverstatus",
    "connectionstatus",
    "getparameter",
    "hostinfo",
    "currentop"
]);

export class MongoDriver implements data.DataDriver {
    readonly shape = "document" as const;
    private client: MongoClient | null = null;

    constructor(private readonly address: data.DataAddress) {}

    private async open(): Promise<MongoClient> {
        if (this.client) return this.client;
        const auth =
            this.address.username && this.address.password
                ? `${encodeURIComponent(this.address.username)}:${encodeURIComponent(this.address.password)}@`
                : "";
        // No `authSource` unless one was resolved: the driver then signs in
        // against `admin`, which is where an account somebody made by hand lives.
        // A database Polaris provisioned carries its own, because its user was
        // created inside it.
        const uri = `mongodb://${auth}${this.address.host}:${this.address.port}/?${new URLSearchParams({
            ...(this.address.authSource ? { authSource: this.address.authSource } : {}),
            ...(this.address.tls ? { tls: "true", tlsAllowInvalidCertificates: "true" } : {})
        }).toString()}`;
        const client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 8000,
            connectTimeoutMS: 8000,
            appName: "polaris-data-browser"
        });
        await client.connect();
        this.client = client;
        return client;
    }

    async version(): Promise<string> {
        const client = await this.open();
        const info = await client.db("admin").command({ buildInfo: 1 });
        return `MongoDB ${String(info.version ?? "")}`.trim();
    }

    async namespaces(): Promise<data.DataNamespace[]> {
        const client = await this.open();
        try {
            const listed = await client.db("admin").admin().listDatabases();
            return listed.databases
                .filter((entry) => !SYSTEM_DATABASES.includes(entry.name))
                .map((entry) => ({ name: entry.name, kind: "database" as const }));
        } catch {
            // An account scoped to one database may not list the server's. The
            // one it was given is still worth showing, and is the only one it
            // was ever going to be able to open.
            return this.address.database
                ? [{ name: this.address.database, kind: "database" as const }]
                : [];
        }
    }

    async relations(namespace: string | null): Promise<data.DataRelation[]> {
        const client = await this.open();
        const name = namespace ?? this.address.database;
        if (!name) return [];
        const collections = await client.db(name).listCollections().toArray();
        return collections
            .map((entry) => ({
                name: entry.name,
                namespace: name,
                kind: entry.type === "view" ? ("view" as const) : ("collection" as const),
                rows: null
            }));
    }

    async columns(namespace: string | null, relation: string): Promise<data.DataColumn[]> {
        const documents = await this.sample(namespace, relation);
        return fieldsOf(documents);
    }

    async rows(
        namespace: string | null,
        relation: string,
        query: data.RowQuery
    ): Promise<data.DataPage> {
        const client = await this.open();
        const name = namespace ?? this.address.database;
        if (!name) throw new data.DataRequestError("Open a database first.");
        const collection = client.db(name).collection(relation);

        // A typed filter would need a query language in the box above the grid.
        // What is there is a search, so it is applied as a case-insensitive
        // regular expression over the fields the sample found, which is what
        // "find this" means in a collection nobody has described.
        let filter: Document = {};
        if (query.filter?.trim()) {
            const fields = (await this.columns(namespace, relation)).map((column) => column.name);
            const needle = new RegExp(escapeRegExp(query.filter.trim()), "i");
            filter = fields.length ? { $or: fields.map((field) => ({ [field]: needle })) } : {};
        }

        const cursor = collection
            .find(filter)
            .skip(query.offset)
            .limit(query.limit)
            .maxTimeMS(30_000);
        if (query.orderBy) cursor.sort({ [query.orderBy]: query.descending ? -1 : 1 });
        const documents = await cursor.toArray();

        return {
            columns: fieldsOf(documents),
            rows: documents.map(readable),
            // Cheap when nothing is being filtered, and skipped when something
            // is: a count behind a regular expression over every field is a
            // collection scan somebody did not ask for.
            total: Object.keys(filter).length
                ? null
                : await collection.estimatedDocumentCount().catch(() => null)
        };
    }

    async run(command: string): Promise<data.QueryResult[]> {
        const parsed = parseCommand(command);
        const name = Object.keys(parsed)[0]?.toLowerCase() ?? "";
        if (this.address.readOnly && !READ_COMMANDS.has(name)) {
            throw new data.ReadOnlyError(`\`${name}\``);
        }
        const client = await this.open();
        const database = this.address.database ?? "admin";
        const started = Date.now();
        const answer = await client.db(database).command(parsed);

        // A find or an aggregate answers with a cursor's first batch; anything
        // else answers with one document about what it did. Both are drawn as
        // rows, because a grid with one row in it is still the answer.
        const batch = (answer.cursor?.firstBatch ?? answer.cursor?.nextBatch) as
            | Document[]
            | undefined;
        const documents = batch ?? [answer];
        return [
            {
                statement: command,
                columns: fieldsOf(documents).map((column) => column.name),
                rows: documents.map((document) => {
                    const row = readable(document);
                    return fieldsOf(documents).map((column) => row[column.name]);
                }),
                affected: typeof answer.n === "number" ? answer.n : null,
                ms: Date.now() - started
            }
        ];
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) await client.close().catch(() => undefined);
    }

    private async sample(namespace: string | null, relation: string): Promise<Document[]> {
        const client = await this.open();
        const name = namespace ?? this.address.database;
        if (!name) return [];
        return client
            .db(name)
            .collection(relation)
            .find({})
            .limit(SAMPLE)
            .maxTimeMS(15_000)
            .toArray();
    }
}

/** The fields these documents have, in the order they were first seen. `_id`
 *  first, because it is the one field every document has and the one anybody
 *  looks for. */
function fieldsOf(documents: readonly Document[]): data.DataColumn[] {
    const seen = new Map<string, data.DataColumn>();
    for (const document of documents) {
        for (const [key, value] of Object.entries(document)) {
            if (seen.has(key)) continue;
            seen.set(key, {
                name: key,
                type: typeName(value),
                nullable: true,
                primaryKey: key === "_id"
            });
        }
    }
    const columns = [...seen.values()];
    return columns.sort((left, right) => Number(right.primaryKey) - Number(left.primaryKey));
}

/** A document with everything that is not a scalar turned into something a grid
 *  can print: an ObjectId as its hex, a date as an ISO string, anything nested
 *  as JSON. */
function readable(document: Document): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) row[key] = printable(value);
    return row;
}

function printable(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object") {
        const asId = value as { _bsontype?: string; toHexString?: () => string };
        if (asId._bsontype === "ObjectId" && typeof asId.toHexString === "function") {
            return asId.toHexString();
        }
        return JSON.stringify(value, (_key, nested) =>
            typeof nested === "bigint" ? nested.toString() : nested
        );
    }
    if (typeof value === "bigint") return value.toString();
    return value;
}

function typeName(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (typeof value === "object") {
        return (value as { _bsontype?: string })._bsontype ?? "object";
    }
    return typeof value;
}

/** The command somebody typed, as a document. JSON rather than shell syntax:
 *  the shell's syntax is JavaScript, and running that is not something a browser
 *  gets to ask a server to do. */
function parseCommand(command: string): Document {
    const text = command.trim();
    if (!text) throw new data.DataRequestError("Type a command document, for example { find: \"users\", limit: 20 }.");
    try {
        return JSON.parse(text) as Document;
    } catch {
        throw new data.DataRequestError(
            "That is not a command document. Mongo takes JSON here, for example { find: \"users\", filter: { active: true }, limit: 20 } - with the field names quoted."
        );
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
