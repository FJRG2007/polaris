"use client";

/**
 * Getting a vault in and out, in the formats other managers actually write.
 *
 * A password manager nobody can leave is a password manager nobody should
 * adopt, so this is deliberately generous in both directions: what somebody
 * has is whatever their old manager produced, and what they will want next is
 * whatever their next one reads.
 *
 * Everything here runs in the browser. The file holds passwords in the clear
 * either way, and handing it to a server that has spent this whole feature
 * being unable to read them would undo the point of it.
 *
 * Formats, and why these:
 *
 *  - **Bitwarden JSON** is the richest of them - types, custom fields, folders -
 *    and it is what the clients of this vault's own protocol export.
 *  - **KeePass 2 XML** is what KeePass and KeePassXC call an export, and it
 *    keeps groups, notes and one-time secrets that a CSV loses. A `.kdbx` is a
 *    database rather than an export and is not read here; KeePass writes this
 *    from File > Export.
 *  - **CSV** is everything else. Every manager writes one and every one of them
 *    names the columns differently, so the columns are matched by vocabulary
 *    rather than by position.
 */

import * as core from "@polaris/core";
import { emptyItem, type VaultItem } from "@/app/(app)/vault/vault-model";

/** A file read into something that can be encrypted and sent. */
export interface ImportedVault {
    items: VaultItem[];
    /** Folder names, in the order items refer to them. */
    folders: string[];
    /** Index into `folders` for each item, or -1. */
    itemFolder: number[];
}

/** One row of a CSV, honouring quotes and the newlines inside them. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]!;
        if (quoted) {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += character;
            }
            continue;
        }
        if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            row.push(field);
            field = "";
        } else if (character === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (character !== "\r") {
            field += character;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((entry) => entry.some((value) => value.trim().length > 0));
}

/**
 * What each column may be called, most specific first.
 *
 * The order inside a list is what resolves a file that has two candidates: a
 * KeePass 1 export calls the title "Account" and the username "Login Name",
 * while a browser calls the username "username" and has no title at all. Trying
 * the exact names before the loose ones is what keeps both readable.
 */
const COLUMNS = {
    name: ["name", "title", "item name", "entry name", "display name", "account"],
    username: [
        "username",
        "user name",
        "login name",
        "login_username",
        "login username",
        "user",
        "login",
        "email",
        "e-mail"
    ],
    password: ["password", "login_password", "login password", "pass"],
    uri: [
        "login_uri",
        "login uri",
        "url",
        "uri",
        "website",
        "web site",
        "urls",
        "link",
        "hostname"
    ],
    notes: ["notes", "note", "comments", "comment", "extra", "memo", "description"],
    totp: ["login_totp", "totp", "otpauth", "otpauth url", "otp", "totp seed", "two-factor secret"],
    folder: ["folder", "group", "grouping", "category", "collection", "group name", "path"],
    favorite: ["favorite", "favourite", "starred"],
    type: ["type", "kind"]
} as const;

type Column = keyof typeof COLUMNS;

/** Which column of this file holds a given field, or -1. */
function columnIndex(headers: string[], field: Column): number {
    const normalized = headers.map((header) => header.trim().toLowerCase().replace(/^"|"$/g, ""));
    for (const alias of COLUMNS[field]) {
        const at = normalized.indexOf(alias);
        if (at >= 0) return at;
    }
    return -1;
}

/** The item type a CSV names, however it spells it. */
function csvType(value: string): number {
    const word = value.trim().toLowerCase();
    if (word === "note" || word === "secure note" || word === "securenote") {
        return core.CIPHER_SECURE_NOTE;
    }
    if (word === "card" || word === "credit card") return core.CIPHER_CARD;
    if (word === "identity") return core.CIPHER_IDENTITY;
    return core.CIPHER_LOGIN;
}

/** A CSV from any manager. */
function readCsv(text: string): ImportedVault {
    const rows = parseCsv(text);
    const headers = rows.shift();
    if (!headers) return { items: [], folders: [], itemFolder: [] };
    const at: Record<Column, number> = {
        name: columnIndex(headers, "name"),
        username: columnIndex(headers, "username"),
        password: columnIndex(headers, "password"),
        uri: columnIndex(headers, "uri"),
        notes: columnIndex(headers, "notes"),
        totp: columnIndex(headers, "totp"),
        folder: columnIndex(headers, "folder"),
        favorite: columnIndex(headers, "favorite"),
        type: columnIndex(headers, "type")
    };
    if (at.password < 0 && at.username < 0 && at.notes < 0) {
        throw new Error("That file has no username, password or notes column.");
    }

    const cell = (row: string[], column: Column): string =>
        at[column] >= 0 ? (row[at[column]] ?? "") : "";

    const items: VaultItem[] = [];
    const folders: string[] = [];
    const itemFolder: number[] = [];
    for (const row of rows) {
        const item = emptyItem(csvType(cell(row, "type")));
        item.name = cell(row, "name") || cell(row, "uri") || row[0] || "Untitled";
        item.login.username = cell(row, "username");
        item.login.password = cell(row, "password");
        item.login.totp = cell(row, "totp");
        item.notes = cell(row, "notes");
        const favorite = cell(row, "favorite").trim().toLowerCase();
        item.favorite = favorite === "1" || favorite === "true" || favorite === "yes";
        const uri = cell(row, "uri").trim();
        item.login.uris = uri ? [uri] : [];
        // A secure note that carried a password would be a login the file
        // mislabelled; keeping both costs nothing and loses nothing.
        items.push(item);

        const folder = cell(row, "folder").trim();
        if (!folder) {
            itemFolder.push(-1);
            continue;
        }
        let index = folders.indexOf(folder);
        if (index < 0) index = folders.push(folder) - 1;
        itemFolder.push(index);
    }
    return { items, folders, itemFolder };
}

/** Bitwarden's own unencrypted JSON export. */
function readBitwardenJson(text: string): ImportedVault {
    const parsed = JSON.parse(text) as {
        encrypted?: boolean;
        folders?: { id?: string; name?: string }[];
        items?: Record<string, unknown>[];
    };
    if (parsed.encrypted) {
        throw new Error("That export is encrypted. Export it again unencrypted.");
    }

    const folderNames: string[] = [];
    const folderIndexById = new Map<string, number>();
    for (const folder of parsed.folders ?? []) {
        const name = String(folder.name ?? "").trim();
        if (!name) continue;
        folderIndexById.set(String(folder.id ?? ""), folderNames.push(name) - 1);
    }

    const items: VaultItem[] = [];
    const itemFolder: number[] = [];
    for (const raw of parsed.items ?? []) {
        const item = emptyItem(Number(raw.type ?? core.CIPHER_LOGIN));
        item.name = String(raw.name ?? "Untitled");
        item.notes = typeof raw.notes === "string" ? raw.notes : "";
        item.favorite = raw.favorite === true;
        const login = raw.login as Record<string, unknown> | undefined;
        if (login) {
            item.login.username = String(login.username ?? "");
            item.login.password = String(login.password ?? "");
            item.login.totp = String(login.totp ?? "");
            const uris = Array.isArray(login.uris) ? login.uris : [];
            item.login.uris = uris
                .map((entry) => String((entry as Record<string, unknown>)?.uri ?? ""))
                .filter(Boolean);
        }
        const card = raw.card as Record<string, string> | undefined;
        if (card) item.card = { ...item.card, ...card };
        const identity = raw.identity as Record<string, string> | undefined;
        if (identity) item.identity = { ...item.identity, ...identity };
        const sshKey = raw.sshKey as Record<string, unknown> | undefined;
        if (sshKey) {
            item.sshKey = {
                privateKey: String(sshKey.privateKey ?? ""),
                publicKey: String(sshKey.publicKey ?? ""),
                keyFingerprint: String(sshKey.keyFingerprint ?? "")
            };
        }
        const fields = Array.isArray(raw.fields) ? raw.fields : [];
        item.fields = fields.map((entry) => {
            const field = entry as Record<string, unknown>;
            return {
                name: String(field.name ?? ""),
                value: String(field.value ?? ""),
                type: Number(field.type ?? core.FIELD_TEXT)
            };
        });
        items.push(item);
        const folderId = typeof raw.folderId === "string" ? raw.folderId : "";
        itemFolder.push(folderIndexById.get(folderId) ?? -1);
    }
    return { items, folders: folderNames, itemFolder };
}

/** The `<String>` pairs of one KeePass entry, by key. */
function keePassStrings(entry: Element): Map<string, string> {
    const values = new Map<string, string>();
    for (const node of Array.from(entry.children)) {
        if (node.tagName !== "String") continue;
        const key = node.getElementsByTagName("Key")[0]?.textContent ?? "";
        const value = node.getElementsByTagName("Value")[0];
        if (!key || !value) continue;
        // An export written with protection still on holds ciphertext this
        // cannot open. Saying so beats importing a vault of unreadable strings.
        if (value.getAttribute("Protected") === "True") {
            throw new Error(
                "That export still has its passwords protected. In KeePass, export again with protection off."
            );
        }
        values.set(key, value.textContent ?? "");
    }
    return values;
}

/** KeePass 2 XML, as KeePass and KeePassXC write it from File > Export. */
function readKeePassXml(text: string): ImportedVault {
    const document = new DOMParser().parseFromString(text, "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) {
        throw new Error("That file is not readable XML.");
    }
    if (document.getElementsByTagName("KeePassFile").length === 0) {
        throw new Error("That XML is not a KeePass export.");
    }

    const items: VaultItem[] = [];
    const folders: string[] = [];
    const itemFolder: number[] = [];

    /**
     * Walk one group, carrying the group names above it as a path.
     *
     * `depth` rather than the length of the path, because the outermost group is
     * the database itself and not a folder: without the distinction, everything
     * ends up filed under the database's name.
     */
    function walk(group: Element, path: string[], depth: number): void {
        const name = group.getElementsByTagName("Name")[0]?.textContent?.trim() ?? "";
        const here = depth === 0 ? [] : [...path, name].filter(Boolean);

        for (const child of Array.from(group.children)) {
            if (child.tagName === "Entry") {
                const strings = keePassStrings(child);
                const item = emptyItem(core.CIPHER_LOGIN);
                item.name = strings.get("Title") ?? "Untitled";
                item.login.username = strings.get("UserName") ?? "";
                item.login.password = strings.get("Password") ?? "";
                item.notes = strings.get("Notes") ?? "";
                item.login.totp = strings.get("otp") ?? strings.get("TOTP Seed") ?? "";
                const uri = (strings.get("URL") ?? "").trim();
                item.login.uris = uri ? [uri] : [];
                // Anything KeePass did not have a column for was a custom field
                // there and stays one here.
                for (const [key, value] of strings) {
                    if (
                        ["Title", "UserName", "Password", "Notes", "URL", "otp"].includes(key) ||
                        !value
                    ) {
                        continue;
                    }
                    item.fields.push({ name: key, value, type: core.FIELD_TEXT });
                }
                items.push(item);

                const folder = here.join(" / ");
                if (!folder) {
                    itemFolder.push(-1);
                    continue;
                }
                let index = folders.indexOf(folder);
                if (index < 0) index = folders.push(folder) - 1;
                itemFolder.push(index);
                continue;
            }
            if (child.tagName === "Group") walk(child, here, depth + 1);
        }
    }

    const root = document.getElementsByTagName("Root")[0];
    for (const group of Array.from(root?.children ?? [])) {
        if (group.tagName === "Group") walk(group, [], 0);
    }
    return { items, folders, itemFolder };
}

/** Read whatever the file is. Throws with something worth showing. */
export function readImportFile(fileName: string, text: string): ImportedVault {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".kdbx")) {
        throw new Error(
            "A .kdbx is a KeePass database, not an export. In KeePass, use File > Export and pick KeePass XML or CSV."
        );
    }
    if (lower.endsWith(".json")) return readBitwardenJson(text);
    if (lower.endsWith(".xml")) return readKeePassXml(text);
    return readCsv(text);
}

/** The export formats offered, and what each is for. */
export const EXPORT_FORMATS = [
    { value: "json", label: "Bitwarden JSON - everything, and what its clients read" },
    { value: "csv", label: "CSV - what most managers and browsers read" },
    { value: "keepass", label: "KeePass XML - for KeePass and KeePassXC" }
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number]["value"];

/** One item's folder name, for the formats that write it inline. */
function folderNameOf(item: VaultItem, folders: { id: string; name: string }[]): string {
    return folders.find((folder) => folder.id === item.folderId)?.name ?? "";
}

/** Bitwarden's unencrypted JSON, which round-trips into their clients. */
function writeBitwardenJson(
    items: VaultItem[],
    folders: { id: string; name: string }[]
): { text: string; type: string; extension: string } {
    const payload = {
        encrypted: false,
        folders: folders.map((folder) => ({ id: folder.id, name: folder.name })),
        items: items.map((item) => ({
            id: item.id,
            folderId: item.folderId,
            organizationId: null,
            collectionIds: null,
            type: item.type,
            name: item.name,
            notes: item.notes || null,
            favorite: item.favorite,
            reprompt: 0,
            fields: item.fields.map((field) => ({
                name: field.name,
                value: field.value,
                type: field.type
            })),
            login:
                item.type === core.CIPHER_LOGIN
                    ? {
                          username: item.login.username || null,
                          password: item.login.password || null,
                          totp: item.login.totp || null,
                          uris: item.login.uris.map((uri) => ({ uri, match: null }))
                      }
                    : undefined,
            card: item.type === core.CIPHER_CARD ? item.card : undefined,
            identity: item.type === core.CIPHER_IDENTITY ? item.identity : undefined,
            sshKey: item.type === core.CIPHER_SSH_KEY ? item.sshKey : undefined,
            secureNote: item.type === core.CIPHER_SECURE_NOTE ? { type: 0 } : undefined
        }))
    };
    return {
        text: JSON.stringify(payload, null, 2),
        type: "application/json",
        extension: "json"
    };
}

/** One CSV cell, quoted whenever it could otherwise be read as two. */
function csvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

/** The CSV Bitwarden writes, which is the one other managers were taught. */
function writeCsv(
    items: VaultItem[],
    folders: { id: string; name: string }[]
): { text: string; type: string; extension: string } {
    const headers = [
        "folder",
        "favorite",
        "type",
        "name",
        "notes",
        "fields",
        "reprompt",
        "login_uri",
        "login_username",
        "login_password",
        "login_totp"
    ];
    const typeName = (type: number): string =>
        type === core.CIPHER_SECURE_NOTE ? "note" : type === core.CIPHER_CARD ? "card" : "login";

    const lines = [headers.join(",")];
    for (const item of items) {
        lines.push(
            [
                folderNameOf(item, folders),
                item.favorite ? "1" : "",
                typeName(item.type),
                item.name,
                item.notes,
                item.fields.map((field) => `${field.name}: ${field.value}`).join("\n"),
                "0",
                item.login.uris[0] ?? "",
                item.login.username,
                item.login.password,
                item.login.totp
            ]
                .map(csvCell)
                .join(",")
        );
    }
    return { text: `${lines.join("\n")}\n`, type: "text/csv", extension: "csv" };
}

/**
 * Text that is safe between XML tags.
 *
 * Control characters other than tab, newline and carriage return are not legal
 * in XML 1.0 at all, and one of them anywhere makes the whole file unreadable
 * to the importer on the other side - so they are dropped rather than escaped.
 */
function escapeXml(value: string): string {
    const escaped = value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    return Array.from(escaped)
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code > 31 || code === 9 || code === 10 || code === 13;
        })
        .join("");
}

/** KeePass 2 XML: groups for folders, one entry per item. */
function writeKeePassXml(
    items: VaultItem[],
    folders: { id: string; name: string }[]
): { text: string; type: string; extension: string } {
    const field = (key: string, value: string, protect = false): string =>
        `        <String><Key>${escapeXml(key)}</Key><Value${
            protect ? ' ProtectInMemory="True"' : ""
        }>${escapeXml(value)}</Value></String>`;

    const entry = (item: VaultItem): string => {
        const lines = [
            field("Title", item.name || "Untitled"),
            field("UserName", item.login.username),
            field("Password", item.login.password, true),
            field("URL", item.login.uris[0] ?? ""),
            field("Notes", item.notes)
        ];
        if (item.login.totp) lines.push(field("otp", item.login.totp, true));
        for (const custom of item.fields) {
            if (custom.name) {
                lines.push(field(custom.name, custom.value, custom.type === core.FIELD_HIDDEN));
            }
        }
        return `      <Entry>\n${lines.join("\n")}\n      </Entry>`;
    };

    const group = (name: string, groupItems: VaultItem[]): string =>
        `    <Group>\n      <Name>${escapeXml(name)}</Name>\n${groupItems
            .map(entry)
            .join("\n")}\n    </Group>`;

    const loose = items.filter((item) => !item.folderId);
    const grouped = folders.map((folder) =>
        group(
            folder.name || "Untitled",
            items.filter((item) => item.folderId === folder.id)
        )
    );

    const text = [
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
        "<KeePassFile>",
        "  <Meta>",
        "    <Generator>Polaris</Generator>",
        "    <DatabaseName>Polaris vault</DatabaseName>",
        "  </Meta>",
        "  <Root>",
        `${group("Polaris", loose)}`,
        ...grouped,
        "  </Root>",
        "</KeePassFile>",
        ""
    ].join("\n");
    return { text, type: "application/xml", extension: "xml" };
}

/** Turn a vault into the chosen format's file contents. */
export function writeExport(
    format: ExportFormat,
    items: VaultItem[],
    folders: { id: string; name: string }[]
): { text: string; type: string; extension: string } {
    if (format === "csv") return writeCsv(items, folders);
    if (format === "keepass") return writeKeePassXml(items, folders);
    return writeBitwardenJson(items, folders);
}
