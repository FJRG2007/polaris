/**
 * Every card of a service's Settings tab, in one place: the section it belongs
 * to, and the words "Filter settings" finds it by besides its own title and
 * description - in English and in Spanish, whichever language the screen is in.
 *
 * A card names its entry (`<SettingsCard entry="...">`), and a test holds the
 * two sides together: every entry here is drawn by exactly one card, and every
 * card of the tab has an entry, so a setting can be neither lost nor listed twice.
 */

import type { SettingsIndex } from "./settings-search";

/** The sections of the tab, in the order they are drawn. */
export const SERVICE_SETTINGS_SECTIONS = [
    "source",
    "networking",
    "security",
    "scale",
    "build",
    "deploy",
    "other",
    "danger"
] as const;

export type ServiceSettingsSection = (typeof SERVICE_SETTINGS_SECTIONS)[number];

type Entry = {
    readonly section: ServiceSettingsSection;
    readonly keywords: { readonly en: readonly string[]; readonly es: readonly string[] };
};

// Search keywords in both languages; they are matched, never drawn on screen.
export const SERVICE_SETTINGS_INDEX = {
    repository: {
        section: "source",
        keywords: {
            en: ["repository", "repo", "github", "git", "branch", "source", "connected"],
            es: ["repositorio", "rama", "origen", "conectado", "codigo"]
        }
    },
    rootDirectory: {
        section: "source",
        keywords: {
            en: ["root directory", "monorepo", "folder", "path"],
            es: ["directorio raiz", "carpeta", "ruta", "monorepo"]
        }
    },
    autoDeploy: {
        section: "source",
        keywords: {
            en: ["auto deploy", "push", "branch", "commit filter", "watch paths", "trigger"],
            es: ["despliegue automatico", "rama", "filtro de commits", "rutas vigiladas"]
        }
    },
    uploadedSource: {
        section: "source",
        keywords: {
            en: ["upload", "folder", "zip", "files"],
            es: ["subir", "carpeta", "archivos", "zip"]
        }
    },
    registry: {
        section: "source",
        keywords: {
            en: ["image", "registry", "docker", "pull", "credentials"],
            es: ["imagen", "registro", "credenciales", "descargar"]
        }
    },
    publicDomains: {
        section: "networking",
        keywords: {
            en: ["public networking", "domain", "url", "tunnel", "tcp proxy", "cloudflare"],
            es: ["red publica", "dominio", "tunel", "proxy tcp", "direccion"]
        }
    },
    addDomain: {
        section: "networking",
        keywords: {
            en: ["add domain", "custom domain", "generate domain", "subdomain", "dns"],
            es: ["anadir dominio", "dominio propio", "generar dominio", "subdominio"]
        }
    },
    privateNetwork: {
        section: "networking",
        keywords: {
            en: ["private networking", "internal", "dns name", "alias"],
            es: ["red privada", "interna", "nombre dns", "alias"]
        }
    },
    containerPort: {
        section: "networking",
        keywords: {
            en: ["port", "container port", "listen"],
            es: ["puerto", "puerto del contenedor", "escucha"]
        }
    },
    externalNetworks: {
        section: "networking",
        keywords: {
            en: ["docker network", "external network", "alias"],
            es: ["red docker", "red externa", "alias"]
        }
    },
    publishPort: {
        section: "security",
        keywords: {
            en: ["publish port", "open port", "firewall", "direct access", "exposed"],
            es: ["publicar puerto", "puerto abierto", "cortafuegos", "acceso directo"]
        }
    },
    traffic: {
        section: "security",
        keywords: {
            en: ["rate limit", "firewall", "waf", "under attack", "challenge", "ip", "block"],
            es: ["limite de peticiones", "cortafuegos", "ataque", "desafio", "bloquear"]
        }
    },
    securityHeaders: {
        section: "security",
        keywords: {
            en: ["security headers", "hsts", "csp", "content security policy", "frame"],
            es: ["cabeceras de seguridad", "encabezados", "politica de contenido"]
        }
    },
    edgeRules: {
        section: "security",
        keywords: {
            en: ["redirect", "rewrite", "edge rules", "www", "https"],
            es: ["redireccion", "reescritura", "reglas del borde"]
        }
    },
    blockVulnerable: {
        section: "security",
        keywords: {
            en: ["vulnerability", "cve", "scan", "block deploy", "security"],
            es: ["vulnerabilidad", "analisis", "bloquear despliegue", "seguridad"]
        }
    },
    replicas: {
        section: "scale",
        keywords: {
            en: ["replicas", "copies", "instances", "autoscale"],
            es: ["replicas", "copias", "instancias", "autoescalado"]
        }
    },
    sleep: {
        section: "scale",
        keywords: {
            en: ["sleep", "serverless", "scale to zero", "idle"],
            es: ["dormir", "reposo", "escalar a cero", "inactivo"]
        }
    },
    resources: {
        section: "scale",
        keywords: {
            en: ["cpu", "memory", "ram", "limits", "resources"],
            es: ["cpu", "memoria", "ram", "limites", "recursos"]
        }
    },
    balancing: {
        section: "scale",
        keywords: {
            en: ["load balancing", "sticky", "balance"],
            es: ["balanceo de carga", "reparto", "balanceo"]
        }
    },
    gpu: {
        section: "scale",
        keywords: { en: ["gpu", "graphics", "cuda", "nvidia"], es: ["gpu", "grafica", "cuda"] }
    },
    server: {
        section: "scale",
        keywords: {
            en: ["server", "machine", "host", "region", "runs on"],
            es: ["servidor", "maquina", "equipo", "region"]
        }
    },
    builder: {
        section: "build",
        keywords: {
            en: ["builder", "dockerfile", "detected", "nixpacks", "image"],
            es: ["constructor", "dockerfile", "detectado", "imagen"]
        }
    },
    buildCommands: {
        section: "build",
        keywords: {
            en: ["build command", "install command", "start command", "runtime", "output"],
            es: ["comando de build", "instalacion", "arranque", "version", "salida"]
        }
    },
    buildMachine: {
        section: "build",
        keywords: {
            en: ["build machine", "build server", "builder host"],
            es: ["maquina de build", "servidor de build", "compilacion"]
        }
    },
    deployStrategy: {
        section: "deploy",
        keywords: {
            en: ["zero downtime", "restart", "overlap", "volumes", "strategy"],
            es: ["sin cortes", "reinicio", "solapar", "volumenes", "estrategia"]
        }
    },
    keepReleases: {
        section: "deploy",
        keywords: {
            en: ["releases", "rollback", "keep", "history"],
            es: ["versiones", "revertir", "conservar", "historial"]
        }
    },
    deployHooks: {
        section: "deploy",
        keywords: {
            en: ["deploy hook", "webhook", "trigger", "url"],
            es: ["gancho de despliegue", "webhook", "disparador"]
        }
    },
    tags: {
        section: "other",
        keywords: { en: ["tags", "labels", "group"], es: ["etiquetas", "grupo"] }
    },
    moveOut: {
        section: "other",
        keywords: {
            en: ["move", "provider", "vercel", "railway", "elsewhere"],
            es: ["mover", "proveedor", "otro sitio"]
        }
    },
    deleteService: {
        section: "danger",
        keywords: { en: ["delete", "remove", "danger"], es: ["eliminar", "borrar", "peligro"] }
    }
} as const satisfies Record<string, Entry>;

export type ServiceSettingsEntry = keyof typeof SERVICE_SETTINGS_INDEX;

/** The same index, as the settings kit reads it. */
export const SERVICE_SETTINGS_SEARCH: SettingsIndex = SERVICE_SETTINGS_INDEX;
