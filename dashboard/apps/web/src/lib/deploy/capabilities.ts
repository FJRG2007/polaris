/**
 * What Polaris does for the things you deploy, in seven groups, each entry
 * pointing at the screen that does it.
 *
 * Only what exists: every entry names where it is, and the test beside this
 * checks that every link lands on a route that is really there. A capability
 * written here before its screen is an advertisement for a 404.
 *
 * Screens inside a project or a service cannot be linked to without one, so
 * those entries link to the projects and say where to go from there.
 */

import type { Permission } from "@polaris/core";

export interface Capability {
    title: string;
    description: string;
    /** Where it is, in the words the screens use. */
    where: string;
    href: string;
    /** The permission the linked screen asks for, beyond reaching Deploy. */
    needs?: Permission;
    /** The linked screen is for administrators. */
    adminOnly?: boolean;
}

export interface CapabilityGroup {
    id: string;
    title: string;
    summary: string;
    items: Capability[];
}

const PROJECTS = "/apps/deploy";

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
    {
        id: "deploy",
        title: "Deploy",
        summary: "From a repository or an image to a running service.",
        items: [
            {
                title: "Push to deploy",
                description:
                    "A push to the tracked branch deploys the services built from it. A commit filter and watch paths decide which pushes count.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Preview environments",
                description: "An environment for each open pull request, built from its branch and removed when it closes.",
                where: "Project > Settings > Feature flags",
                href: PROJECTS
            },
            {
                title: "Builds from the source",
                description:
                    "A Dockerfile is used when there is one; otherwise the stack is detected - Node, Python, Go, Rust, PHP, Ruby, Java, Elixir or a static site - and built. Install, build and start commands and the runtime version can be set per service.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Settings from the repository",
                description:
                    "A new service takes what railway.json, render.yaml, netlify.toml, vercel.json, a Procfile or app.json already set.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Build anywhere",
                description:
                    "Build on the service's own server, on this machine or on another server, and the image is carried to where it runs. The CLI can build on your own computer.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Deploy a folder",
                description: "Drop a folder or a zip and it is built the way a repository would be.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Smart fixes",
                description: "A failed deploy says what most likely went wrong and offers the change that fixes it, redeploying in one press.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Updates noticed",
                description: "Says when a newer image is published behind a service's tag, or how far it is behind its branch.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Monorepos",
                description: "Several services from one repository, each with its own root directory, Dockerfile and watch paths.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Images from a registry",
                description: "Deploy any image, public or behind a registry login.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Instant rollbacks",
                description: "Recent releases keep their image, so putting one back live needs no rebuild. Pin a release to keep it longer.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Deploy progress",
                description: "Each deploy shows its steps as it runs, with the build log under them and what failed if it did.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Staged removals",
                description: "Removing a service or a database is staged and reviewed with the rest before anything is torn down.",
                where: "Project > changes banner",
                href: PROJECTS
            }
        ]
    },
    {
        id: "run",
        title: "Run",
        summary: "Keep services up and see what they are doing.",
        items: [
            {
                title: "Service metrics",
                description: "CPU, memory, network and disk for each service, with history.",
                where: "Service > Metrics",
                href: PROJECTS
            },
            {
                title: "Observability",
                description: "Metrics for every service in an environment on one screen.",
                where: "Project > Observability",
                href: PROJECTS
            },
            {
                title: "Logs",
                description: "Every service's output in one live stream, kept for a week and searchable.",
                where: "Project > Logs",
                href: PROJECTS
            },
            {
                title: "Scheduled jobs",
                description: "Commands run inside a service on a schedule, with retries, timeouts and each run's output.",
                where: "Service > Cron",
                href: PROJECTS
            },
            {
                title: "Console and files",
                description: "A terminal inside the container, and a file browser over it.",
                where: "Service > Console, Files",
                href: PROJECTS
            },
            {
                title: "Volumes",
                description: "Persistent storage on the machine or on a connected storage share.",
                where: "Service > Volumes",
                href: PROJECTS
            },
            {
                title: "Your own servers",
                description: "Run services on this machine or any enrolled server, and move them between servers.",
                where: "Servers",
                href: "/apps/servers",
                needs: "system.manage"
            },
            {
                title: "Health checks",
                description: "Every address is checked, and one that stops answering is flagged on the service.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Deploys with no gap",
                description:
                    "A new version counts only once it is serving. A private service starts every copy of it beside the running ones - here, or on a server set up to serve its own domains - and changes over.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Copies and autoscaling",
                description:
                    "Run up to ten copies, spread by the edge with sticky visitors and a health path, and let the count follow CPU.",
                where: "Service > Settings > Scaling",
                href: PROJECTS
            },
            {
                title: "Resource limits",
                description: "Cap the CPU and memory each copy of a service, or a database, may use.",
                where: "Service > Settings > Scaling",
                href: PROJECTS
            },
            {
                title: "Sleep when idle",
                description: "A service nobody visits sleeps after a set time and wakes on the next visit.",
                where: "Service > Settings > Scaling",
                href: PROJECTS
            }
        ]
    },
    {
        id: "connect",
        title: "Connect",
        summary: "Addresses, certificates and the way in.",
        items: [
            {
                title: "Free subdomains",
                description: "Each service gets a hostname under the instance's domain, with a certificate.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Custom domains",
                description: "Any hostname, with an automatic Let's Encrypt certificate or one you supply.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "DNS written for you",
                description: "With a Cloudflare account connected, Polaris creates the records itself; without one it shows each record to add.",
                where: "Management > Domains",
                href: "/admin/domains",
                adminOnly: true
            },
            {
                title: "Tunnels",
                description: "Cloudflare and ngrok tunnels for a machine with no open ports.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Domains you own",
                description: "An account or organization proves a domain and deploys under it.",
                where: "My account > Domains",
                href: "/account/domains"
            },
            {
                title: "Private networking",
                description:
                    "An environment can keep its services on a network of its own, where they reach each other by a private name.",
                where: "Project > Settings > Environments",
                href: PROJECTS
            },
            {
                title: "Wildcard certificates",
                description: "A domain you bring gets one certificate for itself and every name under it, renewed on its own.",
                where: "My account > Domains",
                href: "/account/domains"
            },
            {
                title: "DNS records",
                description: "Add and change records in a Cloudflare zone, and watch the resolvers pick them up.",
                where: "Management > Domains",
                href: "/admin/domains",
                adminOnly: true
            },
            {
                title: "CDN",
                description: "A domain served through Cloudflare, with its cache emptied after every deploy.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Global edge",
                description:
                    "A domain served through Cloudflare's proxy is answered from their network worldwide, on their anycast addresses, and reaches your server only for what the cache cannot answer.",
                where: "Service > Settings",
                href: PROJECTS
            }
        ]
    },
    {
        id: "services",
        title: "Services",
        summary: "Databases and the rest of the stack.",
        items: [
            {
                title: "Managed databases",
                description: "PostgreSQL, MySQL, MariaDB, MongoDB and Redis, provisioned beside your services.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Redis Cluster",
                description:
                    "A Redis of 3, 5 or 7 masters, each with a replica that takes over when it stops, created as one database. Its nodes come as a reference variable; publish and subscribe, and streams, need nothing extra. Backups copy every master's data.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Database upkeep",
                description:
                    "Restore from a backup, upgrade with a way back, recover PostgreSQL to a moment, and copy data in.",
                where: "Database > Manage",
                href: PROJECTS
            },
            {
                title: "Object storage",
                description: "S3-compatible buckets with keys of their own, signed links, expiry rules and replication.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Mail server",
                description: "A mail server of your own, with its DNS records written and checked, mailboxes, aliases and DMARC reports.",
                where: "Mail server",
                href: "/apps/mail-server",
                needs: "mailserver.manage"
            },
            {
                title: "Database client",
                description: "Browse tables and run queries against any database here.",
                where: "Databases",
                href: "/apps/databases"
            },
            {
                title: "Reference variables",
                description: "${{postgres.DATABASE_URL}} points at another service's value, and follows it into a copied environment.",
                where: "Service > Variables",
                href: PROJECTS
            },
            {
                title: "Shared variables",
                description: "Set once per environment and delivered to every service in it.",
                where: "Project > Settings > Shared variables",
                href: PROJECTS
            },
            {
                title: "Templates",
                description: "Ghost, Gitea, Grafana, n8n, Umami, Vaultwarden and other well-known apps, with their volumes, secrets, database and first setup done.",
                where: "Project > New service",
                href: PROJECTS
            },
            {
                title: "Marketplace",
                description: "Ready-made apps, installed in a click.",
                where: "Marketplace",
                href: "/apps/marketplace"
            },
            {
                title: "Vercel and Railway",
                description: "What a project runs on Vercel or Railway, on the same board.",
                where: "Project > Elsewhere",
                href: PROJECTS
            }
        ]
    },
    {
        id: "manage",
        title: "Manage",
        summary: "Projects, environments, and what they report.",
        items: [
            {
                title: "Projects and environments",
                description: "Services grouped into projects, each with as many environments as it needs, each on its own branch.",
                where: "Deploy",
                href: PROJECTS
            },
            {
                title: "Desktop app",
                description: "Polaris installed as an app with its own window and icon, on any computer or phone.",
                where: "Account > Preferences",
                href: "/account/preferences"
            },
            {
                title: "Usage",
                description: "What a project is consuming.",
                where: "Project > Settings > Usage",
                href: PROJECTS
            },
            {
                title: "Alarms",
                description: "Alerts on health, spikes, outages, full disks and network traffic, for services and servers.",
                where: "Watch > Alarms",
                href: "/watch/alarms"
            },
            {
                title: "Webhooks",
                description: "Deploys and alerts reported to Discord, Slack, Microsoft Teams, Telegram or any endpoint.",
                where: "Watch > Webhooks",
                href: "/watch/webhooks"
            },
            {
                title: "Error tracking",
                description: "What your applications report when they break. Every service is handed a Sentry address.",
                where: "Telemetry",
                href: "/apps/telemetry",
                needs: "deploy.manage"
            },
            {
                title: "Analytics",
                description: "Visitors and traffic on your services, without cookies.",
                where: "Analytics",
                href: "/apps/analytics",
                needs: "deploy.manage"
            },
            {
                title: "Backups",
                description: "Backups on a schedule, and restores.",
                where: "Backups",
                href: "/apps/backups",
                adminOnly: true
            },
            {
                title: "Move to another machine",
                description: "The whole instance in one file sealed with a passphrase, imported on a new install.",
                where: "Management > Updates & settings",
                href: "/admin/settings",
                adminOnly: true
            },
            {
                title: "CI runners",
                description: "Self-hosted GitHub Actions runners on your own machines.",
                where: "Runners",
                href: "/apps/runners",
                needs: "system.manage"
            }
        ]
    },
    {
        id: "secure",
        title: "Secure",
        summary: "Who gets in, and what they can do.",
        items: [
            {
                title: "Firewall",
                description:
                    "Rules, bans and injection protection in front of every service. A new service publishes no port on the machine; it is reached through the edge only.",
                where: "Firewall",
                href: "/apps/firewall",
                needs: "deploy.manage"
            },
            {
                title: "DDoS protection",
                description:
                    "A browser challenge, connection caps and a flood watch on every server's edge, and Cloudflare's network in front of any domain served through its proxy.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Security headers",
                description:
                    "HSTS, CSP, COOP and COEP as presets or one by one. A new service starts on the preset any app survives.",
                where: "Service > Settings",
                href: PROJECTS
            },
            {
                title: "Encrypted secrets",
                description: "Secret variables are encrypted at rest and only revealed on request, and each reveal is recorded.",
                where: "Service > Variables",
                href: PROJECTS
            },
            {
                title: "Encrypted backups",
                description: "Every copy leaves encrypted, under a key you can keep elsewhere as a recovery key.",
                where: "Backups > Encryption",
                href: "/apps/backups",
                adminOnly: true
            },
            {
                title: "Project access",
                description: "Give people a set of capabilities on a project, for some environments only, until a date.",
                where: "Project > Settings > Access",
                href: PROJECTS
            },
            {
                title: "Project tokens",
                description: "API tokens that reach one project and nothing else.",
                where: "Project > Settings > Tokens",
                href: PROJECTS
            },
            {
                title: "Audit trail",
                description: "Who changed what, including every secret revealed.",
                where: "Management > Activity",
                href: "/admin/activity",
                adminOnly: true
            },
            {
                title: "Two-factor sign-in",
                description: "Passkeys, authenticator apps and trusted devices.",
                where: "My account > Security",
                href: "/account/security"
            }
        ]
    },
    {
        id: "collaborate",
        title: "Collaborate",
        summary: "Working on it with other people.",
        items: [
            {
                title: "Organizations and teams",
                description: "Projects owned by an organization, reached through its teams.",
                where: "My account > Organizations",
                href: "/account/organizations"
            },
            {
                title: "Notes on services",
                description: "What people write down about a service - why it was restarted, what not to touch.",
                where: "Service > Notes",
                href: PROJECTS
            },
            {
                title: "Service history",
                description: "What happened to a service: deploys, restarts, variables changed, and by whom.",
                where: "Service > Deployments",
                href: PROJECTS
            },
            {
                title: "Following",
                description: "Hear about the deploys and outages of a service you care about.",
                where: "Service > bell",
                href: PROJECTS
            },
            {
                title: "Deploys on GitHub",
                description: "Each deploy is reported on its commit, so a pull request shows where it went live.",
                where: "Your repository",
                href: PROJECTS
            },
            {
                title: "Code review queue",
                description: "Pull requests and issues waiting on you, across your repositories.",
                where: "Code",
                href: "/apps/code",
                needs: "agents.read"
            },
            {
                title: "Coding agents",
                description: "An agent in your repositories that reviews pull requests, answers issues and fixes failing checks.",
                where: "Agents",
                href: "/apps/agents",
                needs: "agents.read"
            }
        ]
    }
];
