"use client";

/**
 * Bringing a vault in from somewhere else.
 *
 * A password manager nobody can move INTO is a password manager nobody adopts,
 * and the file somebody has is whatever their old one produced. Two shapes cover
 * almost all of it: Bitwarden's own unencrypted JSON export, and the CSV that
 * Chrome, Firefox, Safari and most others write.
 *
 * The file is read in this browser and every item is encrypted here before it is
 * sent, one at a time. That is slower than one big request and it is the right
 * trade: the file holds passwords in the clear, and it should not be handed to a
 * server that has spent this whole feature being unable to read them.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import * as crypto from "@/lib/vault/crypto";
import { Loader2, Upload } from "lucide-react";
import { saveItemAction } from "../vault-actions";
import { emptyItem, encryptItem, type VaultItem } from "../vault-model";
import { Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";

/** One row of a CSV, honouring quotes and the newlines inside them. */
function parseCsv(text: string): string[][] {
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

/** The column a header names, whatever it calls it. */
const COLUMNS: Record<string, string[]> = {
    name: ["name", "title", "account", "item name"],
    uri: ["url", "uri", "website", "login_uri", "login uri"],
    username: ["username", "user", "login_username", "login username", "email"],
    password: ["password", "login_password", "login password"],
    notes: ["notes", "note", "comment", "extra"],
    totp: ["totp", "login_totp", "otpauth"]
};

function columnIndex(headers: string[], field: keyof typeof COLUMNS): number {
    const wanted = COLUMNS[field]!;
    return headers.findIndex((header) => wanted.includes(header.trim().toLowerCase()));
}

/** Read whatever the file is into items ready to be encrypted. */
function readFile(name: string, text: string): VaultItem[] {
    if (name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as {
            encrypted?: boolean;
            items?: Record<string, unknown>[];
        };
        if (parsed.encrypted) {
            throw new Error("That export is encrypted. Export it again unencrypted.");
        }
        return (parsed.items ?? []).map((raw) => {
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
            const fields = Array.isArray(raw.fields) ? raw.fields : [];
            item.fields = fields.map((entry) => {
                const field = entry as Record<string, unknown>;
                return {
                    name: String(field.name ?? ""),
                    value: String(field.value ?? ""),
                    type: Number(field.type ?? core.FIELD_TEXT)
                };
            });
            return item;
        });
    }

    const rows = parseCsv(text);
    const headers = rows.shift();
    if (!headers) return [];
    const at = {
        name: columnIndex(headers, "name"),
        uri: columnIndex(headers, "uri"),
        username: columnIndex(headers, "username"),
        password: columnIndex(headers, "password"),
        notes: columnIndex(headers, "notes"),
        totp: columnIndex(headers, "totp")
    };
    if (at.password < 0 && at.username < 0) {
        throw new Error("That file has no username or password column.");
    }
    return rows.map((row) => {
        const item = emptyItem(core.CIPHER_LOGIN);
        item.name = (at.name >= 0 ? row[at.name] : "") || row[at.uri >= 0 ? at.uri : 0] || "Untitled";
        item.login.username = at.username >= 0 ? (row[at.username] ?? "") : "";
        item.login.password = at.password >= 0 ? (row[at.password] ?? "") : "";
        item.login.totp = at.totp >= 0 ? (row[at.totp] ?? "") : "";
        item.notes = at.notes >= 0 ? (row[at.notes] ?? "") : "";
        const uri = at.uri >= 0 ? (row[at.uri] ?? "") : "";
        item.login.uris = uri ? [uri] : [];
        return item;
    });
}

export function VaultImport({ vaultKey }: { vaultKey: crypto.SymmetricKey | null }) {
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    async function onFile(file: File): Promise<void> {
        if (!vaultKey) {
            setError("Type your master password above first.");
            return;
        }
        setError(null);
        setDone(null);
        let items: VaultItem[];
        try {
            items = readFile(file.name, await file.text());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "That file could not be read.");
            return;
        }
        if (items.length === 0) {
            setError("There was nothing in that file.");
            return;
        }

        setProgress({ done: 0, total: items.length });
        let failed = 0;
        for (const [index, item] of items.entries()) {
            const result = await saveItemAction(null, await encryptItem(item, vaultKey));
            if (result.error) failed += 1;
            setProgress({ done: index + 1, total: items.length });
        }
        setProgress(null);
        setDone(
            failed === 0
                ? `Brought in ${items.length} items.`
                : `Brought in ${items.length - failed} items; ${failed} could not be saved.`
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Import</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    A Bitwarden JSON export, or the CSV most browsers and password managers write.
                    The file is read here and every item is encrypted before it is sent.
                </p>
                <Input
                    type="file"
                    accept=".json,.csv,text/csv,application/json"
                    disabled={progress !== null}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onFile(file);
                        event.target.value = "";
                    }}
                    aria-label="The file to import"
                />
                {progress ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {progress.done} of {progress.total}...
                    </p>
                ) : null}
                {done ? (
                    <p className="flex items-center gap-2 text-sm text-success">
                        <Upload className="size-4" />
                        {done}
                    </p>
                ) : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
