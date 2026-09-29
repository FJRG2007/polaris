/**
 * The commands the search field understands.
 *
 * One entry per scope, holding everything three places need: the words that
 * activate it, how it is announced, and - for the scopes answered locally -
 * which kind of resource in the loaded index it keeps. Adding a command is
 * adding a row here; nothing else has a list of them.
 *
 * Keywords are the plural first, because that is what a command reads as
 * ("/services"), with the singular and the usual shorthand after it so
 * "/service" and "/svc" are not dead ends.
 */

import type { SearchResourceKind } from "@/lib/search/entries";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { SEARCH_SCOPES, type SearchScope } from "@polaris/core";
import {
    AtSign,
    Boxes,
    Hash,
    MessageCircle,
    MessagesSquare,
    TextQuote,
    UserRound,
    CheckSquare,
    Database,
    FileText,
    LayoutGrid,
    Rocket,
    Server,
    StickyNote,
    Workflow,
    type LucideIcon
} from "lucide-react";

export interface SearchScopeDefinition {
    readonly id: SearchScope;
    /** Everything that activates it, first one being the canonical spelling. */
    readonly keywords: readonly string[];
    readonly icon: LucideIcon;
    /** For a locally answered scope, the resource kind it narrows the index to.
     *  Absent means the scope is a query against the database. */
    readonly resourceKind?: SearchResourceKind;
    /** Typed instead of a command word, the way @ opens people. */
    readonly sigil?: string;
}

export const SEARCH_SCOPE_LIST: readonly SearchScopeDefinition[] = [
    {
        id: "projects",
        keywords: ["projects", "project"],
        icon: Boxes,
        resourceKind: "project"
    },
    {
        id: "services",
        keywords: ["services", "service", "svc"],
        icon: Rocket,
        resourceKind: "service"
    },
    {
        id: "databases",
        keywords: ["databases", "database", "db"],
        icon: Database,
        resourceKind: "database"
    },
    {
        id: "servers",
        keywords: ["servers", "server", "hosts", "host"],
        icon: Server,
        resourceKind: "server"
    },
    {
        id: "runners",
        keywords: ["runners", "runner", "pools"],
        icon: Workflow,
        resourceKind: "runner"
    },
    {
        id: "apps",
        keywords: ["apps", "app", "installed"],
        icon: LayoutGrid,
        resourceKind: "installed"
    },
    {
        id: "tasks",
        keywords: ["tasks", "task", "issues", "issue"],
        icon: CheckSquare
    },
    {
        id: "docs",
        keywords: ["docs", "doc", "pages", "page"],
        icon: FileText
    },
    {
        id: "notes",
        keywords: ["notes", "note"],
        icon: StickyNote
    },
    {
        id: "users",
        keywords: ["users", "user", "people", "person"],
        icon: AtSign,
        sigil: "@"
    },
    {
        id: "chat",
        keywords: ["chat"],
        icon: MessagesSquare
    },
    {
        id: "contacts",
        keywords: ["contacts", "contact", "dm"],
        icon: UserRound
    },
    {
        id: "chats",
        keywords: ["chats", "conversations", "conversation"],
        icon: MessageCircle
    },
    {
        id: "channels",
        keywords: ["channels", "channel"],
        icon: Hash
    },
    {
        id: "messages",
        keywords: ["messages", "message", "msg"],
        icon: TextQuote
    }
];

/**
 * The Chat quick switcher's filters, in the order its chips are drawn: all of it
 * first, then one kind at a time.
 */
export const CHAT_SCOPE_FILTERS: readonly SearchScopeDefinition[] = (
    ["chat", "contacts", "chats", "channels", "messages"] as const
).map((id) => SEARCH_SCOPE_LIST.find((scope) => scope.id === id)!);

const BY_ID = new Map(SEARCH_SCOPE_LIST.map((scope) => [scope.id, scope]));

// The registry is hand-written, so this is the check that it stayed complete
// when a scope was added to the shared list and forgotten here.
for (const id of SEARCH_SCOPES) {
    if (!BY_ID.has(id)) throw new Error(`Search scope "${id}" has no definition`);
}

export function searchScope(id: SearchScope): SearchScopeDefinition {
    // Every id in the type is in the map, which the loop above guarantees.
    return BY_ID.get(id)!;
}

/**
 * A scope's words in the reader's language: the heading its matches are listed
 * under (and what the chip says), and what the field shows once it is on.
 */
export function scopeWords(
    t: NamespaceTranslator<"components">,
    id: SearchScope
): { label: string; placeholder: string } {
    return { label: t(`search.scopes.${id}.label`), placeholder: t(`search.scopes.${id}.placeholder`) };
}
