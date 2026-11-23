#!/usr/bin/env python3
"""Print a fingerprint of everything the tunnel daemon's image is built from.

    python3 .github/scripts/tunnel-inputs.py [<git ref>]   # HEAD by default

A dashboard names the daemon's image by the crate's version, and hosts pull it
only when it is missing, so one version has to mean one build everywhere. The
publish records this fingerprint on the image and refuses to move a version tag
to a build of different sources; ci.yml refuses a pull request that changes the
sources without raising the version.

The inputs are the crate's manifest, its `src` tree and Dockerfile, the
patched smoltcp under vendor/, the parts of the workspace manifest a release
build of it reads (shared package fields and dependencies, lints, patches and
the release profile), and the Cargo.lock entries the crate reaches. The
workspace's member list and the other crates' profiles are left out: adding a
crate beside it never reaches its binary. Its tests are left out: they never reach the binary. A
Cargo.lock change for another crate is left out too. Cargo.lock does not tell
dev-dependencies apart, so a change to one of those counts as a change.

Changing what this script hashes changes every fingerprint: raise the crate's
version in the same change.
"""

import hashlib
import json
import subprocess
import sys
import tomllib

CRATE = "polaris-tunnel"
PATHS = [
    "crates/polaris-tunnel/Cargo.toml",
    "crates/polaris-tunnel/Dockerfile",
    "crates/polaris-tunnel/src",
    "vendor/smoltcp"
]

def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout

def lock_closure(ref: str) -> str:
    """The Cargo.lock entries the crate depends on, directly or not, one per line."""
    lock = tomllib.loads(git("show", f"{ref}:Cargo.lock").decode())
    by_name: dict[str, list[dict]] = {}
    for package in lock.get("package", []):
        by_name.setdefault(package["name"], []).append(package)

    def resolve(dependency: str) -> dict:
        # "name", or "name version" when the lock holds several, maybe "(source)".
        parts = dependency.split(" ")
        candidates = by_name.get(parts[0], [])
        if len(parts) > 1:
            candidates = [package for package in candidates if package["version"] == parts[1]]
        if len(candidates) != 1:
            sys.exit(f"Cargo.lock at {ref}: cannot resolve {dependency!r}")
        return candidates[0]

    reached: dict[str, dict] = {}
    pending = [resolve(CRATE)]
    while pending:
        package = pending.pop()
        key = f"{package['name']} {package['version']}"
        if key in reached:
            continue
        reached[key] = package
        pending.extend(resolve(dependency) for dependency in package.get("dependencies", []))
    return "\n".join(
        f"{key} {reached[key].get('source', '')} {reached[key].get('checksum', '')}"
        for key in sorted(reached)
    )

def workspace_manifest(ref: str) -> str:
    """The root manifest's sections a release build of the crate reads, canonical."""
    manifest = tomllib.loads(git("show", f"{ref}:Cargo.toml").decode())
    workspace = manifest.get("workspace", {})
    read = {
        "workspace.package": workspace.get("package"),
        "workspace.dependencies": workspace.get("dependencies"),
        "workspace.lints": workspace.get("lints"),
        "patch": manifest.get("patch"),
        "replace": manifest.get("replace"),
        "profile.release": manifest.get("profile", {}).get("release"),
    }
    return json.dumps(read, sort_keys=True, separators=(",", ":"))

def fingerprint(ref: str) -> str:
    digest = hashlib.sha256()
    digest.update(b"Cargo.toml\0" + workspace_manifest(ref).encode() + b"\n")
    for path in PATHS:
        # The object id is a hash of the file's or tree's contents.
        digest.update(f"{path}\0".encode() + git("rev-parse", f"{ref}:{path}").strip() + b"\n")
    digest.update(lock_closure(ref).encode())
    return digest.hexdigest()

if __name__ == "__main__":
    print(fingerprint(sys.argv[1] if len(sys.argv) > 1 else "HEAD"))
