/**
 * The stacks beyond JavaScript: which image each one builds on, how it installs,
 * and what starts it - always on `$PORT`, always from what the repository says.
 *
 * Off unless asked for (see `DetectOptions.languages`), which the safety sweep in
 * detect-safety.test.ts pins; everything here asks.
 */

import { describe, expect, it } from "vitest";
import { generateDockerfile } from "../src/dockerfile.js";
import { detectBuild, type DirectorySnapshot } from "../src/detect.js";

/** A service at the repository root holding these files, with these texts. */
function at(files: string[], texts: Record<string, string> = {}, runtimeVersion?: string) {
    const level: DirectorySnapshot = { path: "", files, texts };
    return detectBuild({ levels: [level] }, { languages: true, runtimeVersion });
}

describe("Python", () => {
    it("serves Django through gunicorn on its own project module", () => {
        const plan = at(["manage.py", "requirements.txt", "mysite"], {
            "requirements.txt": "Django==5.0\npsycopg[binary]\n",
            "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")'
        });
        expect(plan?.framework).toBe("Django");
        expect(plan?.image?.buildImage).toBe("python:3.12-slim");
        expect(plan?.image?.install).toBe("pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir gunicorn");
        expect(plan?.image?.start).toBe("gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT");
    });

    it("runs FastAPI with uvicorn from main.py, installed with uv", () => {
        const plan = at(["pyproject.toml", "uv.lock", "main.py"], {
            "pyproject.toml": '[project]\nname = "api"\nrequires-python = ">=3.13"\ndependencies = ["fastapi>=0.110", "uvicorn[standard]"]\n'
        });
        expect(plan?.framework).toBe("FastAPI");
        expect(plan?.image?.buildImage).toBe("python:3.13-slim");
        expect(plan?.image?.install).toContain("uv export --frozen --no-dev");
        // uvicorn is already a dependency, so it is not installed twice.
        expect(plan?.image?.install).not.toContain("pip install --no-cache-dir uvicorn");
        expect(plan?.image?.start).toBe("uvicorn main:app --host 0.0.0.0 --port $PORT");
    });

    it("reads Flask from a Poetry project and the version from .python-version", () => {
        const plan = at(["pyproject.toml", "poetry.lock", "app.py", ".python-version"], {
            "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.10"\nflask = "^3.0"\n',
            ".python-version": "3.11.9\n"
        });
        expect(plan?.framework).toBe("Flask");
        expect(plan?.image?.buildImage).toBe("python:3.11-slim");
        expect(plan?.image?.install).toContain("poetry install --no-interaction --no-root --only main");
        expect(plan?.image?.start).toBe("gunicorn app:app --bind 0.0.0.0:$PORT");
    });

    it("takes the Procfile's web process over any guess, and the service's own version over the file's", () => {
        const plan = at(["requirements.txt", "Procfile", "main.py"], {
            "requirements.txt": "flask\n",
            Procfile: "release: python migrate.py\nweb: gunicorn wsgi:app --workers 3 --bind 0.0.0.0:$PORT\n"
        }, "3.10");
        expect(plan?.image?.start).toBe("gunicorn wsgi:app --workers 3 --bind 0.0.0.0:$PORT");
        expect(plan?.image?.buildImage).toBe("python:3.10-slim");
    });

    it("says so when nothing names how to start it", () => {
        const plan = at(["requirements.txt"], { "requirements.txt": "requests\n" });
        expect(plan?.image?.start).toBeNull();
        expect(plan?.note).toContain("set a start command");
    });
});

describe("Go", () => {
    it("builds on the version go.mod names, and runs the one binary", () => {
        const plan = at(["go.mod", "go.sum", "main.go"], {
            "go.mod": "module example.com/api\n\ngo 1.23.2\n\nrequire github.com/gin-gonic/gin v1.10.0\n"
        });
        expect(plan?.framework).toBe("Gin");
        expect(plan?.image?.buildImage).toBe("golang:1.23");
        expect(plan?.image?.build).toBe("go build -o /usr/local/bin/app .");
        expect(plan?.image?.start).toBe("app");
    });

    it("asks for the root directory when the main package is not at the root", () => {
        const plan = at(["go.mod", "cmd", "internal"], { "go.mod": "module x\n\ngo 1.22\n" });
        expect(plan?.image).toBeNull();
        expect(plan?.note).toContain("root directory");
    });
});

describe("Rust", () => {
    it("runs the binary Cargo builds, by the name it will have", () => {
        const plan = at(["Cargo.toml", "Cargo.lock", "src"], {
            "Cargo.toml": '[package]\nname = "server"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n'
        });
        expect(plan?.framework).toBe("Axum");
        expect(plan?.image?.buildImage).toBe("rust:1-slim");
        expect(plan?.image?.start).toBe("./target/release/server");
    });

    it("prefers an explicit [[bin]], and refuses a bare workspace", () => {
        const bin = at(["Cargo.toml", "src"], {
            "Cargo.toml": '[package]\nname = "lib-and-bin"\n\n[[bin]]\nname = "web"\npath = "src/main.rs"\n'
        });
        expect(bin?.image?.start).toBe("./target/release/web");
        const workspace = at(["Cargo.toml", "crates"], { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' });
        expect(workspace?.image).toBeNull();
    });
});

describe("PHP, Ruby, Java, Elixir", () => {
    it("serves Laravel's public/ with FrankenPHP and says APP_KEY is needed", () => {
        const plan = at(["composer.json", "composer.lock", "artisan", "public"], {
            "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11.0" } })
        });
        expect(plan?.framework).toBe("Laravel");
        expect(plan?.image?.buildImage).toBe("dunglas/frankenphp:1-php8.4-bookworm");
        expect(plan?.image?.install).toContain("composer install --no-dev");
        expect(plan?.image?.start).toContain("frankenphp run");
        expect(plan?.note).toContain("APP_KEY");
    });

    it("runs Rails in production on the Ruby version the project pins", () => {
        const plan = at(["Gemfile", "Gemfile.lock", ".ruby-version", "config.ru"], {
            Gemfile: 'source "https://rubygems.org"\nruby "3.2.2"\ngem "rails", "~> 7.1"\ngem "propshaft"\n',
            ".ruby-version": "3.2.2"
        });
        expect(plan?.framework).toBe("Ruby on Rails");
        expect(plan?.image?.buildImage).toBe("ruby:3.2-slim");
        expect(plan?.image?.build).toContain("assets:precompile");
        expect(plan?.image?.start).toBe("bundle exec rails server -b 0.0.0.0 -p $PORT -e production");
    });

    it("runs Spring Boot on the port the service publishes, with the JDK the pom asks for", () => {
        const plan = at(["pom.xml", "mvnw", "src"], {
            "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>17</java.version></properties></project>"
        });
        expect(plan?.framework).toBe("Spring Boot");
        expect(plan?.image?.buildImage).toBe("maven:3.9-eclipse-temurin-17");
        expect(plan?.image?.build).toBe("chmod +x mvnw && ./mvnw -B -DskipTests package");
        expect(plan?.image?.start).toBe("java -Dserver.port=$PORT -jar $(ls target/*.jar | head -n 1)");
    });

    it("builds Gradle with its wrapper and skips the jar that cannot run", () => {
        const plan = at(["build.gradle.kts", "gradlew", "src"], { "build.gradle.kts": 'plugins { kotlin("jvm") }' });
        expect(plan?.image?.buildImage).toBe("eclipse-temurin:21-jdk");
        expect(plan?.image?.start).toContain("grep -v -- '-plain.jar'");
    });

    it("starts Phoenix as a server", () => {
        const plan = at(["mix.exs", "mix.lock"], { "mix.exs": 'defp deps do\n  [{:phoenix, "~> 1.7"}]\nend\nelixir: "~> 1.15"' });
        expect(plan?.framework).toBe("Phoenix");
        expect(plan?.image?.start).toBe("MIX_ENV=prod PHX_SERVER=true mix phx.server");
    });
});

describe("a static site", () => {
    it("is served as it stands by nginx", () => {
        const plan = at(["index.html", "style.css", "img"]);
        expect(plan?.framework).toBe("Static site");
        expect(plan?.image?.staticDirectory).toBe("");
        const dockerfile = generateDockerfile({ ...plan!.image!, port: 8080 });
        expect(dockerfile).toContain("FROM nginx:alpine");
        expect(dockerfile).toContain("listen 8080");
    });

    it("is not claimed when anything in the directory makes it a project", () => {
        expect(at(["index.html", "package.json"])).toBeNull();
    });
});

describe("what stays the builder's", () => {
    it("says nothing about another language unless asked", () => {
        const level: DirectorySnapshot = { path: "", files: ["requirements.txt", "main.py"], texts: { "requirements.txt": "flask\n" } };
        expect(detectBuild({ levels: [level] })).toBeNull();
    });

    it("leaves a Node app that starts itself to Node, whatever else is beside it", () => {
        const level: DirectorySnapshot = {
            path: "",
            files: ["package.json", "requirements.txt"],
            manifest: { scripts: { start: "node server.js" } },
            texts: { "requirements.txt": "flask\n" }
        };
        expect(detectBuild({ levels: [level] }, { languages: true })).toBeNull();
    });

    it("writes a Dockerfile that starts the service on its port", () => {
        const plan = at(["requirements.txt", "app.py"], { "requirements.txt": "flask\n" });
        const dockerfile = generateDockerfile({ ...plan!.image!, port: 5000 });
        expect(dockerfile).toContain("FROM python:3.12-slim");
        expect(dockerfile).toContain("ENV PORT=5000");
        expect(dockerfile).toContain('CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:$PORT"]');
    });
});
