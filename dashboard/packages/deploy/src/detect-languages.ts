/**
 * How to build and run a repository in something other than JavaScript.
 *
 * The same job `detect.ts` does for Node, for Python, Go, Rust, PHP, Ruby, Java,
 * Elixir and a plain static site: read the manifests the caller found, decide the
 * image, the install, the build and the start, and hand back a plan the Dockerfile
 * generator writes out. An image tag names the runtime the project asks for - the
 * `go 1.23` in go.mod, the `.python-version` file - which the auto-detecting
 * builder can only approximate with whatever its own version pinned.
 *
 * Pure: the caller reads the files (`LANGUAGE_FILES`) and passes their text in.
 * Every command listens on `$PORT`, which the generated image sets to the port the
 * service publishes, so a framework's own default port never decides anything.
 *
 * Anything this cannot state honestly - a Go module whose main package is not at
 * the root, a Rust workspace - comes back with no image and a note that says what
 * to set, rather than a guess that builds and then serves nothing.
 */

import type { DetectedBuild, DirectorySnapshot } from "./detect.js";

/** The files whose text detection reads, relative to the service's directory.
 *  Small by nature; the caller caps each one. */
export const LANGUAGE_FILES = [
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    ".python-version",
    "runtime.txt",
    "manage.py",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "Gemfile",
    ".ruby-version",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "Procfile"
] as const;

/** What a language detector is given: the directory and the text of its files. */
export interface LanguageInput {
    readonly path: string;
    readonly files: readonly string[];
    readonly texts: Readonly<Record<string, string>>;
    /** The runtime version the service set for itself, which beats anything the
     *  repository says ("3.11", "1.22", "21"). */
    readonly runtimeVersion?: string | null;
}

type Plan = NonNullable<DetectedBuild["image"]>;

/** A detected stack with nothing but a note, for one that cannot be built as is. */
function explain(path: string, framework: string, note: string): DetectedBuild {
    return {
        framework,
        buildRoot: path,
        install: null,
        build: null,
        start: null,
        packages: [],
        nodeRequirement: null,
        image: null,
        note
    };
}

/** A detected stack with the image plan that builds it. */
function planned(
    path: string,
    framework: string,
    image: string,
    steps: { install: string | null; build: string | null; start: string | null },
    note: string
): DetectedBuild {
    const plan: Plan = {
        buildImage: image,
        runtimeImage: image,
        appDirectory: path,
        workspaceInstall: null,
        install: steps.install,
        build: steps.build,
        start: steps.start,
        staticDirectory: null
    };
    return {
        framework,
        buildRoot: path,
        install: null,
        build: null,
        start: null,
        packages: [],
        nodeRequirement: null,
        image: plan,
        note: steps.start
            ? `${note}; on ${image}`
            : `${note}, but nothing here says how to start it - set a start command`
    };
}

/** The `web:` line of a Procfile, which is how a Heroku-shaped project states its
 *  start command. */
export function procfileWeb(procfile: string | undefined): string | null {
    if (!procfile) return null;
    for (const line of procfile.split(/\r?\n/)) {
        const match = /^\s*web\s*:\s*(.+?)\s*$/.exec(line);
        if (match?.[1]) return match[1];
    }
    return null;
}

/** "3.11.4", "python-3.11.4", "3.11" -> "3.11". */
function majorMinor(raw: string | undefined | null): string | null {
    const match = raw ? /(\d+)\.(\d+)/.exec(raw) : null;
    return match ? `${match[1]}.${match[2]}` : null;
}

/** Compare two dotted versions numerically. */
function newer(a: string, b: string): boolean {
    const [amaj = 0, amin = 0] = a.split(".").map(Number);
    const [bmaj = 0, bmin = 0] = b.split(".").map(Number);
    return amaj !== bmaj ? amaj > bmaj : amin > bmin;
}

/**
 * The version a requirement like `>=3.11`, `^3.10` or `==3.9.*` asks for, given
 * the default this would otherwise use. An exact pin is that version; a minimum
 * above the default is the minimum; anything the default satisfies is the default.
 */
function versionFor(requirement: string | undefined | null, fallback: string): string {
    if (!requirement) return fallback;
    const exact = /==\s*(\d+\.\d+)/.exec(requirement);
    if (exact?.[1]) return exact[1];
    const minimum = majorMinor(/(?:>=|\^|~=|~>|~)?\s*(\d+\.\d+)/.exec(requirement)?.[1] ?? null);
    return minimum && newer(minimum, fallback) ? minimum : fallback;
}

function has(input: LanguageInput, name: string): boolean {
    return input.files.includes(name);
}

/* -------------------------------------------------------------------------- */
/* Python                                                                     */
/* -------------------------------------------------------------------------- */

/** Package names a Python project depends on, lower-cased with `-` as `_`, from
 *  whichever manifest it has. */
function pythonDependencies(texts: Readonly<Record<string, string>>): Set<string> {
    const names = new Set<string>();
    const add = (raw: string) => {
        const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(raw);
        if (match?.[1]) names.add(match[1].toLowerCase().replace(/-/g, "_"));
    };
    for (const line of (texts["requirements.txt"] ?? "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) add(trimmed);
    }
    const pyproject = texts["pyproject.toml"] ?? "";
    // Every quoted requirement string in the file, which covers PEP 621
    // dependencies and optional groups alike.
    for (const match of pyproject.matchAll(
        /["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:[<>=!~^;][^"']*)?["']/g
    )) {
        if (match[1]) add(match[1]);
    }
    // Poetry and Pipfile tables: `name = "..."` lines.
    for (const match of `${pyproject}\n${texts.Pipfile ?? ""}`.matchAll(
        /^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*[{"']/gm
    )) {
        if (match[1] && match[1] !== "python") add(match[1]);
    }
    return names;
}

/** The Python version asked for, most specific source first. */
function pythonVersion(input: LanguageInput): string {
    const fallback = "3.12";
    const own = majorMinor(input.runtimeVersion);
    if (own) return own;
    const pinned =
        majorMinor(input.texts[".python-version"]) ?? majorMinor(input.texts["runtime.txt"]);
    if (pinned) return pinned;
    const requires =
        /requires-python\s*=\s*["']([^"']+)["']/.exec(input.texts["pyproject.toml"] ?? "")?.[1] ??
        /^\s*python\s*=\s*["']([^"']+)["']/m.exec(input.texts["pyproject.toml"] ?? "")?.[1];
    return versionFor(requires, fallback);
}

/** How the project's dependencies go in, by the tool its files say it uses. */
function pythonInstall(input: LanguageInput): { command: string; tool: string } {
    const pyproject = input.texts["pyproject.toml"] ?? "";
    if (has(input, "uv.lock")) {
        return {
            tool: "uv",
            command:
                "pip install --no-cache-dir uv && uv export --frozen --no-dev --no-hashes -o /tmp/requirements.txt && pip install --no-cache-dir -r /tmp/requirements.txt"
        };
    }
    if (has(input, "poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) {
        return {
            tool: "Poetry",
            command:
                "pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --no-interaction --no-root --only main"
        };
    }
    if (has(input, "Pipfile")) {
        return {
            tool: "Pipenv",
            command: "pip install --no-cache-dir pipenv && pipenv install --system --deploy"
        };
    }
    if (has(input, "requirements.txt")) {
        return { tool: "pip", command: "pip install --no-cache-dir -r requirements.txt" };
    }
    return { tool: "pip", command: "pip install --no-cache-dir ." };
}

/** The Django project module, read from manage.py's settings default. */
function djangoModule(managePy: string | undefined): string | null {
    const match = managePy
        ? /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([A-Za-z0-9_]+)\.settings/.exec(managePy)
        : null;
    return match?.[1] ?? null;
}

function detectPython(input: LanguageInput): DetectedBuild | null {
    if (
        !["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"].some((name) =>
            has(input, name)
        )
    )
        return null;
    const deps = pythonDependencies(input.texts);
    const image = `python:${pythonVersion(input)}-slim`;
    const install = pythonInstall(input);
    /** Add a server the project does not already depend on. */
    const withServer = (server: string) =>
        deps.has(server)
            ? install.command
            : `${install.command} && pip install --no-cache-dir ${server}`;
    const procfile = procfileWeb(input.texts.Procfile);

    if (has(input, "manage.py") || deps.has("django")) {
        const module = djangoModule(input.texts["manage.py"]);
        const start =
            procfile ??
            (module ? `gunicorn ${module}.wsgi:application --bind 0.0.0.0:$PORT` : null);
        return planned(
            input.path,
            "Django",
            image,
            {
                install: procfile ? install.command : withServer("gunicorn"),
                // Without every setting in place collectstatic can refuse; a build is
                // not the place that should stop on it.
                build: has(input, "manage.py")
                    ? "python manage.py collectstatic --noinput || true"
                    : null,
                start
            },
            `Django, installed with ${install.tool}`
        );
    }
    if (deps.has("fastapi")) {
        const module = has(input, "main.py")
            ? "main"
            : has(input, "app.py")
              ? "app"
              : has(input, "app")
                ? "app.main"
                : null;
        return planned(
            input.path,
            "FastAPI",
            image,
            {
                install: procfile ? install.command : withServer("uvicorn"),
                build: null,
                start:
                    procfile ??
                    (module ? `uvicorn ${module}:app --host 0.0.0.0 --port $PORT` : null)
            },
            `FastAPI, installed with ${install.tool}`
        );
    }
    if (deps.has("flask")) {
        const module = has(input, "app.py")
            ? "app"
            : has(input, "wsgi.py")
              ? "wsgi"
              : has(input, "main.py")
                ? "main"
                : null;
        return planned(
            input.path,
            "Flask",
            image,
            {
                install: procfile ? install.command : withServer("gunicorn"),
                build: null,
                start: procfile ?? (module ? `gunicorn ${module}:app --bind 0.0.0.0:$PORT` : null)
            },
            `Flask, installed with ${install.tool}`
        );
    }
    const script = has(input, "main.py") ? "main.py" : has(input, "app.py") ? "app.py" : null;
    return planned(
        input.path,
        "Python",
        image,
        {
            install: install.command,
            build: null,
            start: procfile ?? (script ? `python ${script}` : null)
        },
        `Python, installed with ${install.tool}`
    );
}

/* -------------------------------------------------------------------------- */
/* Go                                                                         */
/* -------------------------------------------------------------------------- */

function detectGo(input: LanguageInput): DetectedBuild | null {
    const mod = input.texts["go.mod"];
    if (!has(input, "go.mod")) return null;
    const version =
        majorMinor(input.runtimeVersion) ??
        majorMinor(/^go\s+(\d+\.\d+)/m.exec(mod ?? "")?.[1] ?? null);
    // `golang:1` is the newest 1.x, which a module without a go line builds on.
    const image = `golang:${version ?? "1"}`;
    const framework = /github\.com\/gin-gonic\/gin/.test(mod ?? "")
        ? "Gin"
        : /github\.com\/gofiber\/fiber/.test(mod ?? "")
          ? "Fiber"
          : /github\.com\/labstack\/echo/.test(mod ?? "")
            ? "Echo"
            : "Go";
    const procfile = procfileWeb(input.texts.Procfile);
    if (!has(input, "main.go") && !procfile) {
        // The main package lives somewhere else (cmd/<name> by convention); which
        // one is the server is not something the file list says.
        return explain(
            input.path,
            framework,
            `${framework} with no main.go at its root - set the root directory to the folder holding the main package`
        );
    }
    return planned(
        input.path,
        framework,
        image,
        {
            install: "go mod download",
            build: "go build -o /usr/local/bin/app .",
            start: procfile ?? "app"
        },
        framework
    );
}

/* -------------------------------------------------------------------------- */
/* Rust                                                                       */
/* -------------------------------------------------------------------------- */

/** The binary `cargo build` produces: an explicit [[bin]] name, else the package's. */
function cargoBinary(cargo: string): string | null {
    const bin = /\[\[bin\]\][^[]*?\bname\s*=\s*["']([^"']+)["']/.exec(cargo)?.[1];
    if (bin) return bin;
    const pkg = /\[package\][^[]*?\bname\s*=\s*["']([^"']+)["']/.exec(cargo)?.[1];
    return pkg ?? null;
}

function detectRust(input: LanguageInput): DetectedBuild | null {
    if (!has(input, "Cargo.toml")) return null;
    const cargo = input.texts["Cargo.toml"] ?? "";
    const framework = /\bactix-web\b/.test(cargo)
        ? "Actix Web"
        : /\baxum\b/.test(cargo)
          ? "Axum"
          : /\brocket\b/.test(cargo)
            ? "Rocket"
            : "Rust";
    const binary = cargoBinary(cargo);
    if (!binary) {
        return explain(
            input.path,
            "Rust",
            "a Cargo workspace rather than a crate - set the root directory to the crate you want to deploy"
        );
    }
    const version =
        majorMinor(input.runtimeVersion) ??
        majorMinor(/rust-version\s*=\s*["']([^"']+)["']/.exec(cargo)?.[1] ?? null);
    const image = version ? `rust:${version}-slim` : "rust:1-slim";
    return planned(
        input.path,
        framework,
        image,
        {
            // Most web crates reach TLS through OpenSSL, which the slim image lacks.
            install:
                "apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*",
            build: "cargo build --release",
            start: procfileWeb(input.texts.Procfile) ?? `./target/release/${binary}`
        },
        framework
    );
}

/* -------------------------------------------------------------------------- */
/* PHP                                                                        */
/* -------------------------------------------------------------------------- */

/** The PHP versions a FrankenPHP image is published for. */
const PHP_VERSIONS = ["8.2", "8.3", "8.4"] as const;

function detectPhp(input: LanguageInput): DetectedBuild | null {
    if (!has(input, "composer.json") && !has(input, "index.php")) return null;
    let require: Record<string, unknown> = {};
    try {
        const composer = JSON.parse(input.texts["composer.json"] ?? "{}") as {
            require?: Record<string, unknown>;
        };
        require = composer.require && typeof composer.require === "object" ? composer.require : {};
    } catch {
        // A composer.json that is not JSON fails on install, where the error says so.
    }
    const framework =
        "laravel/framework" in require
            ? "Laravel"
            : "symfony/framework-bundle" in require
              ? "Symfony"
              : "PHP";
    const asked =
        majorMinor(input.runtimeVersion) ??
        versionFor(typeof require.php === "string" ? require.php : null, "8.4");
    // An image exists for each listed version; anything else is met by the newest.
    const version = (PHP_VERSIONS as readonly string[]).includes(asked) ? asked : "8.4";
    const image = `dunglas/frankenphp:1-php${version}-bookworm`;
    const install = has(input, "composer.json")
        ? "apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/* && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && composer install --no-dev --optimize-autoloader --no-interaction"
        : null;
    // FrankenPHP serves public/ from the working directory; a site without one is
    // served where it stands, by PHP's own server.
    const start =
        procfileWeb(input.texts.Procfile) ??
        (has(input, "public")
            ? 'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile'
            : "php -S 0.0.0.0:$PORT -t .");
    const needs = framework === "Laravel" ? " (it needs APP_KEY set as a variable)" : "";
    return planned(
        input.path,
        framework,
        image,
        { install, build: null, start },
        `${framework}${needs}`
    );
}

/* -------------------------------------------------------------------------- */
/* Ruby                                                                       */
/* -------------------------------------------------------------------------- */

function detectRuby(input: LanguageInput): DetectedBuild | null {
    if (!has(input, "Gemfile")) return null;
    const gemfile = input.texts.Gemfile ?? "";
    const version =
        majorMinor(input.runtimeVersion) ??
        majorMinor(input.texts[".ruby-version"]) ??
        majorMinor(/^\s*ruby\s+["'](?:~>\s*)?([^"']+)["']/m.exec(gemfile)?.[1] ?? null) ??
        "3.3";
    const image = `ruby:${version}-slim`;
    const install =
        "apt-get update && apt-get install -y --no-install-recommends build-essential git libpq-dev libyaml-dev && rm -rf /var/lib/apt/lists/* && bundle config set --local without 'development test' && bundle install";
    const gem = (name: string) => new RegExp(`^\\s*gem\\s+["']${name}["']`, "m").test(gemfile);
    const procfile = procfileWeb(input.texts.Procfile);
    if (gem("rails")) {
        const assets = gem("propshaft") || gem("sprockets") || gem("sprockets-rails");
        return planned(
            input.path,
            "Ruby on Rails",
            image,
            {
                install,
                build: assets
                    ? "SECRET_KEY_BASE_DUMMY=1 RAILS_ENV=production bundle exec rails assets:precompile"
                    : null,
                start: procfile ?? "bundle exec rails server -b 0.0.0.0 -p $PORT -e production"
            },
            "Ruby on Rails (it needs SECRET_KEY_BASE or RAILS_MASTER_KEY set as a variable)"
        );
    }
    const framework = gem("sinatra") ? "Sinatra" : "Ruby";
    const start =
        procfile ??
        (has(input, "config.ru")
            ? "bundle exec rackup -o 0.0.0.0 -p $PORT"
            : has(input, "app.rb")
              ? "bundle exec ruby app.rb -o 0.0.0.0 -p $PORT"
              : null);
    return planned(input.path, framework, image, { install, build: null, start }, framework);
}

/* -------------------------------------------------------------------------- */
/* Java                                                                       */
/* -------------------------------------------------------------------------- */

/** The JDK images are published for LTS releases; take the nearest one at or
 *  above what the project asks for. */
function jdkFor(requested: string | null): string {
    const wanted = Number(requested ?? 21);
    return String([11, 17, 21, 25].find((lts) => lts >= wanted) ?? 21);
}

function detectJava(input: LanguageInput): DetectedBuild | null {
    const maven = has(input, "pom.xml");
    const gradle = has(input, "build.gradle") || has(input, "build.gradle.kts");
    if (!maven && !gradle) return null;
    const manifest = maven
        ? (input.texts["pom.xml"] ?? "")
        : (input.texts["build.gradle.kts"] ?? input.texts["build.gradle"] ?? "");
    const spring = /spring[-.]boot/.test(manifest);
    const quarkus = /io\.quarkus/.test(manifest);
    const framework = spring ? "Spring Boot" : quarkus ? "Quarkus" : "Java";
    const requested =
        /^(\d+)/.exec(input.runtimeVersion ?? "")?.[1] ??
        /<(?:java\.version|maven\.compiler\.release|maven\.compiler\.source)>\s*(?:1\.)?(\d+)/.exec(
            manifest
        )?.[1] ??
        /(?:languageVersion\.set\(JavaLanguageVersion\.of\(|sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?)(\d+)/.exec(
            manifest
        )?.[1] ??
        null;
    const jdk = jdkFor(requested);
    // Spring Boot and Quarkus read their port from a property rather than PORT.
    const portFlag = spring ? "-Dserver.port=$PORT " : quarkus ? "-Dquarkus.http.port=$PORT " : "";
    const procfile = procfileWeb(input.texts.Procfile);
    if (maven) {
        const build = has(input, "mvnw")
            ? "chmod +x mvnw && ./mvnw -B -DskipTests package"
            : "mvn -B -DskipTests package";
        const jar = quarkus
            ? "target/quarkus-app/quarkus-run.jar"
            : "$(ls target/*.jar | head -n 1)";
        return planned(
            input.path,
            framework,
            `maven:3.9-eclipse-temurin-${jdk}`,
            { install: null, build, start: procfile ?? `java ${portFlag}-jar ${jar}` },
            `${framework} with Maven`
        );
    }
    const wrapper = has(input, "gradlew");
    return planned(
        input.path,
        framework,
        wrapper ? `eclipse-temurin:${jdk}-jdk` : `gradle:jdk${jdk}`,
        {
            install: null,
            build: wrapper
                ? "chmod +x gradlew && ./gradlew build -x test --no-daemon"
                : "gradle build -x test --no-daemon",
            // Gradle also writes a `-plain` jar without dependencies, which cannot run.
            start:
                procfile ??
                `java ${portFlag}-jar $(ls build/libs/*.jar | grep -v -- '-plain.jar' | head -n 1)`
        },
        `${framework} with Gradle`
    );
}

/* -------------------------------------------------------------------------- */
/* Elixir                                                                     */
/* -------------------------------------------------------------------------- */

function detectElixir(input: LanguageInput): DetectedBuild | null {
    if (!has(input, "mix.exs")) return null;
    const mix = input.texts["mix.exs"] ?? "";
    const phoenix = /\{\s*:phoenix\s*,/.test(mix);
    const version = versionFor(
        majorMinor(input.runtimeVersion) ?? /elixir:\s*["']([^"']+)["']/.exec(mix)?.[1] ?? null,
        "1.17"
    );
    return planned(
        input.path,
        phoenix ? "Phoenix" : "Elixir",
        `elixir:${version}`,
        {
            install:
                "mix local.hex --force && mix local.rebar --force && MIX_ENV=prod mix deps.get --only prod",
            build: phoenix
                ? "MIX_ENV=prod mix compile && (MIX_ENV=prod mix assets.deploy || true)"
                : "MIX_ENV=prod mix compile",
            start:
                procfileWeb(input.texts.Procfile) ??
                (phoenix
                    ? "MIX_ENV=prod PHX_SERVER=true mix phx.server"
                    : "MIX_ENV=prod mix run --no-halt")
        },
        phoenix ? "Phoenix (it needs SECRET_KEY_BASE and PHX_HOST set as variables)" : "Elixir"
    );
}

/* -------------------------------------------------------------------------- */
/* Static                                                                     */
/* -------------------------------------------------------------------------- */

/** Every file that would make a directory a project rather than a site. */
const PROJECT_MARKERS = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "setup.py",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "deno.json",
    "Dockerfile"
];

function detectStatic(input: LanguageInput): DetectedBuild | null {
    if (!has(input, "index.html") || PROJECT_MARKERS.some((name) => has(input, name))) return null;
    return {
        framework: "Static site",
        buildRoot: input.path,
        install: null,
        build: null,
        start: null,
        packages: [],
        nodeRequirement: null,
        image: {
            buildImage: "alpine:3",
            runtimeImage: "alpine:3",
            appDirectory: input.path,
            workspaceInstall: null,
            install: null,
            build: null,
            start: null,
            staticDirectory: ""
        },
        note: "a static site, served as it is"
    };
}

/** In order: a repository holding several manifests is decided by the first. */
const DETECTORS = [
    detectPython,
    detectGo,
    detectRust,
    detectPhp,
    detectRuby,
    detectJava,
    detectElixir,
    detectStatic
];

/**
 * How to build a non-JavaScript project, or null when nothing here recognizes
 * the directory.
 */
export function detectLanguageBuild(
    app: DirectorySnapshot,
    runtimeVersion?: string | null
): DetectedBuild | null {
    const input: LanguageInput = {
        path: app.path,
        files: app.files,
        texts: app.texts ?? {},
        runtimeVersion
    };
    for (const detect of DETECTORS) {
        const found = detect(input);
        if (found) return found;
    }
    return null;
}
