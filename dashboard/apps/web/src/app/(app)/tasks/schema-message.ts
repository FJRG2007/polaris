/**
 * A sentence from one of core's task schemas ("A name is required"), in the
 * reader's language.
 *
 * The schemas live in `@polaris/core` and are shared with Notes, MCP tools and
 * the public API, which read their messages as they are, so the English stays
 * there and is looked up here. A message with no translation - one of zod's
 * own - is shown as it came.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

const SCHEMA_KEYS: Readonly<Record<string, NamespaceKey<"tasks">>> = {
    "A name is required": "schema.nameRequired",
    "Keep the name under 64 characters": "schema.nameUnder64",
    "Keep the name under 255 characters": "schema.nameUnder255",
    "Keep the description under 20,000 characters": "schema.descriptionUnder20000",
    "The name must not contain control characters": "schema.nameControlCharacters",
    "Twenty people at a time": "schema.twentyPeople",
    "Twenty addresses at a time": "schema.twentyAddresses",
    "Choose who to send it to": "schema.chooseRecipients",
    "Add at least one action": "schema.addAction",
    "A form needs at least one question": "schema.formNeedsQuestion",
    "Pick a colour": "schema.pickColour",
    "Write something first": "schema.writeSomething",
    "Email is required": "schema.emailRequired",
    "Enter a valid email": "schema.validEmail"
};

export function schemaMessage(t: NamespaceTranslator<"tasks">, message: string | undefined, fallback: string): string {
    if (!message) return fallback;
    const key = SCHEMA_KEYS[message];
    return key ? t(key) : message;
}
