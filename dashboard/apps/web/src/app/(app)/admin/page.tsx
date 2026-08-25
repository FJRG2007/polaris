import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import {
    Activity,
    Blocks,
    Bot,
    Building2,
    ChevronRight,
    Gauge,
    Globe,
    HardDrive,
    IdCard,
    Mail,
    MessageSquare,
    MessagesSquare,
    Scale,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Users,
    UsersRound
} from "lucide-react";

/**
 * The Management app's home: one card per administration area. The areas
 * themselves are the existing admin pages; this page (and the app's sidebar)
 * gather them into a single place instead of the account menu.
 */
const SECTIONS = [
    { href: "/admin/users", icon: Users, title: "Users", description: "Accounts, admin rights, and invites." },
    { href: "/admin/groups", icon: UsersRound, title: "Groups", description: "Group membership for shared access." },
    {
        href: "/admin/roles",
        icon: IdCard,
        title: "Roles",
        description: "What a member, a viewer or a guest may do, and which apps they see."
    },
    {
        href: "/admin/policies",
        icon: Scale,
        title: "Policies",
        description: "Fine-grained permission policies for users and groups."
    },
    {
        href: "/admin/security",
        icon: ShieldCheck,
        title: "Security",
        description: "Whether an account has to carry a second factor, and which ones count."
    },
    { href: "/admin/activity", icon: Activity, title: "Activity", description: "Audit log of actions across Polaris." },
    {
        href: "/inbox",
        icon: MessagesSquare,
        title: "Inbox",
        description: "Conversations, the channels they arrive on, and who they are with."
    },
    {
        href: "/admin/chat",
        icon: MessageSquare,
        title: "Chat",
        description: "Message and file limits, how long one stays editable, and what a deleted one leaves."
    },
    {
        href: "/admin/email",
        icon: Mail,
        title: "Email",
        description: "Who Polaris sends mail as, and the channel that carries sign-in messages."
    },
    { href: "/admin/domains", icon: Globe, title: "Domains", description: "App and sharing domains, DuckDNS sync." },
    {
        href: "/admin/consumption",
        icon: Gauge,
        title: "Consumption",
        description: "What this machine is being spent on: Polaris itself, installed apps, and everything else running."
    },
    {
        href: "/admin/organizations",
        icon: Building2,
        title: "Organizations",
        description: "Which organizations exist, what they may run, and their limits."
    },
    {
        href: "/admin/display",
        icon: SlidersHorizontal,
        title: "Display defaults",
        description: "The units, dates and number formats new accounts start on."
    },
    {
        href: "/admin/agents",
        icon: Bot,
        title: "Agent defaults",
        description: "Where coding agents may run, and what they may open on their own."
    },
    {
        href: "/admin/uploads",
        icon: HardDrive,
        title: "Uploads",
        description: "Where files attached to work are kept, and how big one may be."
    },
    {
        href: "/integrations",
        icon: Blocks,
        title: "Integrations",
        description: "Third-party services (label printing, file scanning)."
    },
    {
        href: "/integrations/models",
        icon: Sparkles,
        title: "AI providers",
        description: "The model providers agents run on, and your key with each."
    },
    {
        href: "/settings",
        icon: Settings,
        title: "Updates & settings",
        description: "Version, in-band self-update, and deployment settings."
    }
];

export default async function ManagementPage() {
    await requireAdmin();

    return (
        <>
            <PageHeader
                title="Management"
                description="Administer Polaris: users and access, policies, domains, integrations, and updates."
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {SECTIONS.map((section) => {
                    const Icon = section.icon;
                    return (
                        <Link
                            key={section.href}
                            href={section.href}
                            className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-primary/5"
                        >
                            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
                                <Icon className="size-5" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                                <span className="flex items-center gap-1 text-sm font-medium">
                                    {section.title}
                                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                </span>
                                <span className="text-xs text-muted-foreground">{section.description}</span>
                            </span>
                        </Link>
                    );
                })}
            </div>
        </>
    );
}
