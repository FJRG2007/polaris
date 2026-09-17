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
    /** Heading the matches are listed under, and what the chip says. */
    readonly label: string;
    /** Everything that activates it, first one being the canonical spelling. */
    readonly keywords: readonly string[];
    readonly icon: LucideIcon;
    /** Shown in the field once the command is on. */
    readonly placeholder: string;
    /** For a locally answered scope, the resource kind it narrows the index to.
     *  Absent means the scope is a query against the database. */
    readonly resourceKind?: SearchResourceKind;
    /** Typed instead of a command word, the way @ opens people. */
    readonly sigil?: string;
}

export const SEARCH_SCOPE_LIST: readonly SearchScopeDefinition[] = [
    {
        id: "projects",
        label: "Projects",
        keywords: ["projects", "project"],
        icon: Boxes,
        placeholder: "Search deploy projects",
        resourceKind: "project"
    },
    {
        id: "services",
        label: "Services",
        keywords: ["services", "service", "svc"],
        icon: Rocket,
        placeholder: "Search services",
        resourceKind: "service"
    },
    {
        id: "databases",
        label: "Databases",
        keywords: ["databases", "database", "db"],
        icon: Database,
        placeholder: "Search managed databases",
        resourceKind: "database"
    },
    {
        id: "servers",
        label: "Servers",
        keywords: ["servers", "server", "hosts", "host"],
        icon: Server,
        placeholder: "Search servers",
        resourceKind: "server"
    },
    {
        id: "runners",
        label: "Runners",
        keywords: ["runners", "runner", "pools"],
        icon: Workflow,
        placeholder: "Search runner pools",
        resourceKind: "runner"
    },
    {
        id: "apps",
        label: "Installed apps",
        keywords: ["apps", "app", "installed"],
        icon: LayoutGrid,
        placeholder: "Search installed apps",
        resourceKind: "installed"
    },
    {
        id: "tasks",
        label: "Tasks",
        keywords: ["tasks", "task", "issues", "issue"],
        icon: CheckSquare,
        placeholder: "Search tasks by name or number"
    },
    {
        id: "docs",
        label: "Pages",
        keywords: ["docs", "doc", "pages", "page"],
        icon: FileText,
        placeholder: "Search pages"
    },
    {
        id: "notes",
        label: "Notes",
        keywords: ["notes", "note"],
        icon: StickyNote,
        placeholder: "Search your notes"
    },
    {
        id: "users",
        label: "People",
        keywords: ["users", "user", "people", "person"],
        icon: AtSign,
        placeholder: "Search people",
        sigil: "@"
    },
    {
        id: "chat",
        label: "Chat",
        keywords: ["chat"],
        icon: MessagesSquare,
        placeholder: "Find people, conversations, channels and messages"
    },
    {
        id: "contacts",
        label: "People",
        keywords: ["contacts", "contact", "dm"],
        icon: UserRound,
        placeholder: "Find somebody to message"
    },
    {
        id: "chats",
        label: "Conversations",
        keywords: ["chats", "conversations", "conversation"],
        icon: MessageCircle,
        placeholder: "Find a direct message or a group"
    },
    {
        id: "channels",
        label: "Channels",
        keywords: ["channels", "channel"],
        icon: Hash,
        placeholder: "Find a channel in your spaces"
    },
    {
        id: "messages",
        label: "Messages",
        keywords: ["messages", "message", "msg"],
        icon: TextQuote,
        placeholder: "Find something that was said"
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
