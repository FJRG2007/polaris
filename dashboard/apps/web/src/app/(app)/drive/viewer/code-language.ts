/**
 * The languages the viewer can highlight, and how a file name or a Markdown
 * fence tag resolves to one. Each entry names a highlight.js grammar and carries
 * its own loader, so opening a JSON file pulls in the JSON grammar and nothing
 * else - the import paths are static, which is what lets the bundler split them
 * into one chunk per language instead of shipping all 380 of them.
 */

import type { LanguageFn } from "highlight.js";
import { extensionOf } from "../file-categories";

export interface CodeLanguage {
    /** highlight.js grammar id, and the module name under lib/languages. */
    readonly id: string;
    /** Shown in the viewer's header. */
    readonly label: string;
    /** Extensions and Markdown fence tags that select this grammar. */
    readonly tokens: readonly string[];
    readonly load: () => Promise<{ default: LanguageFn }>;
}

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
    { id: "bash", label: "Shell", tokens: ["sh", "bash", "zsh", "ksh", "shell", "console"], load: () => import("highlight.js/lib/languages/bash") },
    { id: "c", label: "C", tokens: ["c", "h"], load: () => import("highlight.js/lib/languages/c") },
    { id: "clojure", label: "Clojure", tokens: ["clj", "cljs", "cljc", "edn"], load: () => import("highlight.js/lib/languages/clojure") },
    { id: "cmake", label: "CMake", tokens: ["cmake"], load: () => import("highlight.js/lib/languages/cmake") },
    { id: "cpp", label: "C++", tokens: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "c++"], load: () => import("highlight.js/lib/languages/cpp") },
    { id: "csharp", label: "C#", tokens: ["cs", "csx", "csharp"], load: () => import("highlight.js/lib/languages/csharp") },
    { id: "css", label: "CSS", tokens: ["css"], load: () => import("highlight.js/lib/languages/css") },
    { id: "dart", label: "Dart", tokens: ["dart"], load: () => import("highlight.js/lib/languages/dart") },
    { id: "diff", label: "Diff", tokens: ["diff", "patch"], load: () => import("highlight.js/lib/languages/diff") },
    { id: "dockerfile", label: "Dockerfile", tokens: ["dockerfile", "containerfile", "docker"], load: () => import("highlight.js/lib/languages/dockerfile") },
    { id: "elixir", label: "Elixir", tokens: ["ex", "exs", "elixir"], load: () => import("highlight.js/lib/languages/elixir") },
    { id: "erlang", label: "Erlang", tokens: ["erl", "hrl", "erlang"], load: () => import("highlight.js/lib/languages/erlang") },
    { id: "fsharp", label: "F#", tokens: ["fs", "fsi", "fsx", "fsharp"], load: () => import("highlight.js/lib/languages/fsharp") },
    { id: "go", label: "Go", tokens: ["go", "golang"], load: () => import("highlight.js/lib/languages/go") },
    { id: "gradle", label: "Gradle", tokens: ["gradle"], load: () => import("highlight.js/lib/languages/gradle") },
    { id: "graphql", label: "GraphQL", tokens: ["graphql", "gql"], load: () => import("highlight.js/lib/languages/graphql") },
    { id: "groovy", label: "Groovy", tokens: ["groovy"], load: () => import("highlight.js/lib/languages/groovy") },
    { id: "haskell", label: "Haskell", tokens: ["hs", "lhs", "haskell"], load: () => import("highlight.js/lib/languages/haskell") },
    { id: "http", label: "HTTP", tokens: ["http"], load: () => import("highlight.js/lib/languages/http") },
    { id: "ini", label: "INI", tokens: ["ini", "toml", "cfg", "conf", "properties", "env"], load: () => import("highlight.js/lib/languages/ini") },
    { id: "java", label: "Java", tokens: ["java", "jsp"], load: () => import("highlight.js/lib/languages/java") },
    { id: "javascript", label: "JavaScript", tokens: ["js", "mjs", "cjs", "jsx", "javascript"], load: () => import("highlight.js/lib/languages/javascript") },
    { id: "json", label: "JSON", tokens: ["json", "jsonc", "json5", "map", "webmanifest"], load: () => import("highlight.js/lib/languages/json") },
    { id: "julia", label: "Julia", tokens: ["jl", "julia"], load: () => import("highlight.js/lib/languages/julia") },
    { id: "kotlin", label: "Kotlin", tokens: ["kt", "kts", "kotlin"], load: () => import("highlight.js/lib/languages/kotlin") },
    { id: "latex", label: "LaTeX", tokens: ["tex", "latex", "sty", "cls"], load: () => import("highlight.js/lib/languages/latex") },
    { id: "less", label: "Less", tokens: ["less"], load: () => import("highlight.js/lib/languages/less") },
    { id: "lua", label: "Lua", tokens: ["lua"], load: () => import("highlight.js/lib/languages/lua") },
    { id: "makefile", label: "Makefile", tokens: ["mk", "mak", "make", "makefile"], load: () => import("highlight.js/lib/languages/makefile") },
    { id: "markdown", label: "Markdown", tokens: ["md", "mdx", "markdown"], load: () => import("highlight.js/lib/languages/markdown") },
    { id: "nginx", label: "Nginx", tokens: ["nginx"], load: () => import("highlight.js/lib/languages/nginx") },
    { id: "objectivec", label: "Objective-C", tokens: ["mm", "objc", "objectivec"], load: () => import("highlight.js/lib/languages/objectivec") },
    { id: "ocaml", label: "OCaml", tokens: ["ml", "mli", "ocaml"], load: () => import("highlight.js/lib/languages/ocaml") },
    { id: "perl", label: "Perl", tokens: ["pl", "pm", "perl"], load: () => import("highlight.js/lib/languages/perl") },
    { id: "php", label: "PHP", tokens: ["php", "phtml"], load: () => import("highlight.js/lib/languages/php") },
    { id: "powershell", label: "PowerShell", tokens: ["ps1", "psm1", "psd1", "pwsh", "powershell"], load: () => import("highlight.js/lib/languages/powershell") },
    { id: "protobuf", label: "Protocol Buffers", tokens: ["proto", "protobuf"], load: () => import("highlight.js/lib/languages/protobuf") },
    { id: "python", label: "Python", tokens: ["py", "pyw", "pyi", "python"], load: () => import("highlight.js/lib/languages/python") },
    { id: "r", label: "R", tokens: ["r"], load: () => import("highlight.js/lib/languages/r") },
    { id: "ruby", label: "Ruby", tokens: ["rb", "rake", "gemspec", "ruby"], load: () => import("highlight.js/lib/languages/ruby") },
    { id: "rust", label: "Rust", tokens: ["rs", "rust"], load: () => import("highlight.js/lib/languages/rust") },
    { id: "scala", label: "Scala", tokens: ["scala", "sc"], load: () => import("highlight.js/lib/languages/scala") },
    { id: "scss", label: "SCSS", tokens: ["scss", "sass"], load: () => import("highlight.js/lib/languages/scss") },
    { id: "sql", label: "SQL", tokens: ["sql", "psql", "pgsql", "mysql"], load: () => import("highlight.js/lib/languages/sql") },
    { id: "swift", label: "Swift", tokens: ["swift"], load: () => import("highlight.js/lib/languages/swift") },
    { id: "typescript", label: "TypeScript", tokens: ["ts", "tsx", "mts", "cts", "typescript"], load: () => import("highlight.js/lib/languages/typescript") },
    { id: "vim", label: "Vim script", tokens: ["vim", "vimrc"], load: () => import("highlight.js/lib/languages/vim") },
    { id: "xml", label: "HTML, XML", tokens: ["xml", "html", "htm", "xhtml", "svg", "vue", "svelte", "rss", "atom", "xsl", "xslt", "plist", "wsdl"], load: () => import("highlight.js/lib/languages/xml") },
    { id: "yaml", label: "YAML", tokens: ["yml", "yaml"], load: () => import("highlight.js/lib/languages/yaml") }
];

/**
 * Files whose whole name identifies the language, because they carry no
 * extension or one that says nothing (Dockerfile, Makefile, CMakeLists.txt).
 * Keyed by the lowercased file name, valued by one of the tokens above.
 */
const NAMED_FILES: Record<string, string> = {
    dockerfile: "dockerfile",
    containerfile: "dockerfile",
    makefile: "make",
    gnumakefile: "make",
    "cmakelists.txt": "cmake",
    gemfile: "rb",
    rakefile: "rb",
    brewfile: "rb",
    vagrantfile: "rb",
    jenkinsfile: "groovy",
    "nginx.conf": "nginx",
    ".bashrc": "bash",
    ".bash_profile": "bash",
    ".bash_aliases": "bash",
    ".zshrc": "bash",
    ".profile": "bash",
    ".vimrc": "vim",
    ".gitconfig": "ini",
    ".npmrc": "ini",
    ".editorconfig": "ini"
};

const BY_TOKEN: ReadonlyMap<string, CodeLanguage> = (() => {
    const index = new Map<string, CodeLanguage>();
    for (const language of CODE_LANGUAGES) {
        index.set(language.id, language);
        for (const token of language.tokens) {
            // First grammar to claim a token wins, so the table order above is the
            // precedence (nothing claims one twice today).
            if (!index.has(token)) index.set(token, language);
        }
    }
    return index;
})();

/** The grammar a Markdown fence tag or an extension asks for, if we have it. */
export function languageForToken(token: string): CodeLanguage | undefined {
    return BY_TOKEN.get(token.trim().toLowerCase());
}

/** The grammar a file name selects, if we have one for it. */
export function languageForFile(name: string): CodeLanguage | undefined {
    const lowercased = name.toLowerCase();
    const named = NAMED_FILES[lowercased];
    if (named) return BY_TOKEN.get(named);
    // .env, .env.local, .env.production: the name is all there is to go on.
    if (lowercased === ".env" || lowercased.startsWith(".env.")) return BY_TOKEN.get("ini");
    return BY_TOKEN.get(extensionOf(lowercased));
}
