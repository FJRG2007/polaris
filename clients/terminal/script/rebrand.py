#!/usr/bin/env python3
"""Rewrite the upstream Warp branding to Rook across file contents and paths.

Kept in the tree so the same transformation can be replayed when merging new
upstream commits: copy the upstream files in, then run this script again.

Case is preserved: WARP -> ROOK, Warp -> Rook, warp -> rook. Binary assets and
the tokenizer vocabulary are left untouched, and the upstream GitHub slug is
remapped to this fork instead of being renamed word by word.
"""

import argparse
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Directories never descended into, relative to the repo root.
SKIP_DIRS = {".git", "references", "target", "node_modules", ".ledger", "__pycache__"}

# Paths whose contents are left byte-for-byte intact. The tokenizer holds model
# vocabulary, so rewriting tokens inside it would silently change classifier input.
SKIP_CONTENT_PATHS = {
    os.path.join("crates", "input_classifier", "models"),
    os.path.join("script", "rebrand.py"),
    # These describe the relationship to upstream, so they name it on purpose:
    # which repository this was forked from, which of its issues a bug came
    # from, where the reference checkout lives. Renaming those turns each one
    # into a statement about this repository instead, and the result reads as
    # a fork of itself.
    "CLAUDE.md",
    "README.md",
    "docs",
    os.path.join(".claude", "commands"),
}

# A licence names its copyright holder, and both the MIT and AGPL texts require that
# notice to be kept as it is. Renaming the holder would be a licence violation, not a
# rebrand, so any file that is one is left alone wherever it sits in the tree.
LICENCE_FILENAMES = {"LICENSE", "LICENCE", "COPYING", "NOTICE"}


def is_licence_file(name: str) -> bool:
    stem = name.split(".", 1)[0].upper()
    return stem in LICENCE_FILENAMES

BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".icns",
    ".ttf", ".otf", ".woff", ".woff2",
    ".zip", ".gz", ".xz", ".7z",
    ".onnx", ".sqlite", ".db", ".bin", ".pb",
    ".dll", ".exe", ".lib", ".pdb", ".so", ".dylib", ".a", ".wasm",
    ".mp4", ".mov", ".pdf",
}

# Applied before the generic word replacement, in order. Only the upstream client
# repository becomes this fork.
PRE_REPLACEMENTS = [
    ("Warp Team <dev@warp.dev>", "Rook Contributors"),
]

# The client repository, and only that one. Sibling repositories under the same
# organization share the prefix (warp-proto-apis, warp-internal, warp-server), so
# the slug has to end here for the rewrite to apply.
UPSTREAM_REPO = re.compile(r"warpdotdev/[Ww]arp(?![A-Za-z0-9._-])")

# Every other repository under the upstream organization is a real third-party
# fork this build still depends on (rust-objc, winit, vte, warp-proto-apis, the
# common-skills scripts), so those references survive the rename untouched. The
# sentinel carries no "warp" for the generic pass to catch.
UPSTREAM_ORG = re.compile(r"warpdotdev(/[A-Za-z0-9._-]+)?")

# Third-party crates that happen to carry the upstream name. Renaming these breaks
# dependency resolution, because the package name lives in the other repository.
# Derived from the upstream lockfile: every package whose name matches the brand and
# that resolves to a `source` rather than a workspace path.
#   awk '/^\[\[package\]\]/{n="";s=""} /^name = /{n=$3} /^source = /{s=$3} \
#        /^$/{if (n ~ /[Ww]arp/ && s != "") print n}' Cargo.lock
EXTERNAL_CRATES = re.compile(
    r"warp[-_](?:multi[-_]agent[-_]api"
    r"|command[-_]signatures"
    r"|completion[-_]metadata"
    r"|workflows[-_]types"
    r"|workflows)"
)

# Types and fields generated from the upstream protobuf definitions. They are
# reached through the `api::` alias of that crate, so anything named under that
# path belongs to the wire format and cannot be renamed on this side.
# Anything under the `api::` alias is generated from the upstream protobuf
# definitions. The named entries below come from the same wire format (and from
# session-sharing-protocol) but are reached without that prefix, so they have to
# be listed. The list is maintained by compiling: `cargo check` reports each one
# as an unknown field or variant on a type this repository does not own.
#
# Where our own code happens to use one of these names for its own field, it
# keeps the upstream spelling too. That is consistent and compiles; it just
# leaves a few internal identifiers unbranded.
# Names where "warp" is the English word, not the brand. X11's XWarpPointer
# teleports the cursor and predates the terminal by decades; renaming it broke
# the Linux build, and nothing about a Windows-only check would have caught it.
PROTOCOL_TERMS = re.compile(r"[Ww]arp[_ ]?[Pp]ointer")

EXTERNAL_API = re.compile(
    r"api::(?:[A-Za-z0-9_]+::)*[Ww]arp[A-Za-z0-9_]*"
    r"|Metadata::WarpDocumentationSearch"
    r"|ActivePrompt::WarpPrompt"
    r"|FailedToAddGuestsReason::NotWarpUsers"
    r"|allow_use_of_warp_credits"
    r"|warp_drive_context_enabled"
    r"|warp_token_usage"
)

SENTINEL = "\x00preserved-{}\x00"

WORD = re.compile(r"[Ww][Aa][Rr][Pp]")
CASE_MAP = {"WARP": "ROOK", "Warp": "Rook", "warp": "rook"}

def replace_case_preserving(text: str) -> str:
    for old, new in PRE_REPLACEMENTS:
        text = text.replace(old, new)
    text = UPSTREAM_REPO.sub("FJRG2007/rook", text)

    preserved: list[str] = []

    def stash(match: re.Match[str]) -> str:
        preserved.append(match.group(0))
        return SENTINEL.format(len(preserved) - 1)

    text = UPSTREAM_ORG.sub(stash, text)
    text = EXTERNAL_CRATES.sub(stash, text)
    text = EXTERNAL_API.sub(stash, text)
    text = PROTOCOL_TERMS.sub(stash, text)
    text = WORD.sub(lambda m: CASE_MAP.get(m.group(0), "rook"), text)
    for index, original in enumerate(preserved):
        text = text.replace(SENTINEL.format(index), original)
    return text

def rename_path_component(name: str) -> str:
    return WORD.sub(lambda m: CASE_MAP.get(m.group(0), "rook"), name)

def is_skipped_content(rel_path: str) -> bool:
    if is_licence_file(os.path.basename(rel_path)):
        return True
    if os.path.splitext(rel_path)[1].lower() in BINARY_SUFFIXES:
        return True
    return any(
        rel_path == skip or rel_path.startswith(skip + os.sep)
        for skip in SKIP_CONTENT_PATHS
    )

def walk(root: str):
    """Yield (dirpath, dirnames, filenames), pruning skipped directories."""
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        yield dirpath, dirnames, filenames

def rewrite_contents(root: str, dry_run: bool) -> int:
    changed = 0
    for dirpath, _, filenames in walk(root):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(path, root)
            if is_skipped_content(rel_path):
                continue
            try:
                with open(path, "rb") as handle:
                    raw = handle.read()
            except OSError as error:
                print(f"skip (unreadable): {rel_path}: {error}", file=sys.stderr)
                continue
            if b"\x00" in raw:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if not WORD.search(text) and not any(old in text for old, _ in PRE_REPLACEMENTS):
                continue
            updated = replace_case_preserving(text)
            if updated == text:
                continue
            changed += 1
            if dry_run:
                print(f"content: {rel_path}")
                continue
            with open(path, "wb") as handle:
                handle.write(updated.encode("utf-8"))
    return changed

def rewrite_paths(root: str, dry_run: bool) -> int:
    """Rename matching files and directories, deepest first so parents stay valid."""
    targets = []
    for dirpath, dirnames, filenames in walk(root):
        for name in filenames + dirnames:
            if WORD.search(name):
                targets.append(os.path.join(dirpath, name))
    targets.sort(key=lambda p: p.count(os.sep), reverse=True)

    renamed = 0
    for path in targets:
        parent, name = os.path.split(path)
        destination = os.path.join(parent, rename_path_component(name))
        if destination == path:
            continue
        renamed += 1
        if dry_run:
            print(f"path: {os.path.relpath(path, root)} -> {os.path.basename(destination)}")
            continue
        # Case-only renames need a two-step move on case-insensitive filesystems.
        if path.lower() == destination.lower():
            temporary = destination + ".rebrand-tmp"
            os.rename(path, temporary)
            os.rename(temporary, destination)
        else:
            os.rename(path, destination)
    return renamed

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    parser.add_argument("--root", default=REPO_ROOT, help="tree to rewrite (default: repo root)")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    contents = rewrite_contents(root, args.dry_run)
    paths = rewrite_paths(root, args.dry_run)
    verb = "would rewrite" if args.dry_run else "rewrote"
    print(f"{verb} {contents} file(s) and {paths} path(s)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
