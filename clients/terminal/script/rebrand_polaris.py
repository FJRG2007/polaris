#!/usr/bin/env python3
"""Rewrite the Rook branding to Polaris Terminal across file contents and paths.

The second leg of `rebrand.py`: that script turns the upstream Warp names into
Rook, this one turns Rook into the Polaris names (docs/terminal-integration.md,
"Rename map"). Replaying an upstream merge runs both, in that order:

    python3 script/rebrand.py && python3 script/rebrand_polaris.py

It is not one word swap. Code identifiers and user-facing names take different
forms, so Rust sources are split into code, strings and comments first:

    crate / snake case   rook_core          -> pterm_core
    UI crates            rookui_core        -> ptermui_core
    type / camel case    RookTheme          -> PtermTheme
    channel app names    RookOss, RookDev   -> PolarisTerminal, PolarisTerminalDev
    environment          ROOK_CHANNEL       -> POLARIS_TERMINAL_CHANNEL
    package / binaries   rook, rook-oss     -> polaris-terminal
    the app crate path   rook::             -> polaris_terminal::
    AppId                dev.rook.RookOss   -> dev.polaris.PolarisTerminal
    home directory       ~/.rook-oss        -> ~/.polaris-terminal-oss
    per-repository dir   .rook/             -> .polaris/terminal/
    prose                Rook               -> Polaris Terminal

The hosts and addresses under the old project's domain are left as they are: the sweep that removes
them is its own step, guarded by a test, and it decides per category.
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebrand  # noqa: E402  (the shared skip lists and walker)

SKIP_SCRIPTS = {
    os.path.join("script", "rebrand.py"),
    os.path.join("script", "rebrand_polaris.py"),
}

# Kept verbatim and restored after the rewrite.
PRESERVE = re.compile(
    # Hosts and addresses under the old domain: handled by the domain sweep.
    r"[A-Za-z0-9._%+-]*@?[A-Za-z0-9.-]*\brook\.dev\b"
)

# Applied first, in order, to every text segment (code, string and prose alike).
FIXED = [
    # The old repository is now this one, with the tree under clients/terminal/.
    (re.compile(r"FJRG2007/rook/(blob|tree|raw|edit)/([A-Za-z0-9._-]+)/"), r"FJRG2007/polaris/\1/\2/clients/terminal/"),
    (re.compile(r"raw\.githubusercontent\.com/FJRG2007/rook/([A-Za-z0-9._-]+)/"), r"raw.githubusercontent.com/FJRG2007/polaris/\1/clients/terminal/"),
    (re.compile(r"FJRG2007/rook(?![A-Za-z0-9_-])"), "FJRG2007/polaris"),
    # Application identifiers.
    (re.compile(r"dev\.rook\.RookOss\b"), "dev.polaris.PolarisTerminal"),
    (re.compile(r"dev\.rook\.Rook(?![A-Za-z0-9_])"), "dev.polaris.PolarisTerminal"),
    (re.compile(r"dev\.rook\.Rook"), "dev.polaris.PolarisTerminal"),
    (re.compile(r"dev\.rook(?![A-Za-z0-9_-])"), "dev.polaris"),
    (re.compile(r"\"dev\", \"rook\""), "\"dev\", \"polaris\""),
    (re.compile(r"organization\(\) == \"rook\""), "organization() == \"polaris\""),
    # The home directory, before the per-repository rule claims `.rook`.
    # The unsuffixed `rook` binary is the local channel; `rook-oss` is the released one.
    (re.compile(r"(--bin[ =]|default-run = \")rook(?![A-Za-z0-9_.-])"), r"\1polaris-terminal-local"),
    # The released channel is OSS and takes the plain name; the others keep a
    # suffix so no two channels share a binary, package, scheme or directory.
    (re.compile(r"(Channel::Local => \")rook\""), r'\1polaris-terminal-local"'),
    (re.compile(r"(Channel::Stable => \")rook\""), r'\1polaris-terminal-stable"'),
    (re.compile(r"(?<![A-Za-z0-9_])rook-terminal-(preview|dev|integration|local)(?![A-Za-z0-9_])"), r"polaris-terminal-\1"),
    (re.compile(r"(?<![A-Za-z0-9_])rook-terminal(?![A-Za-z0-9_-])"), "polaris-terminal-stable"),
    # Hyphenated names such as PowerShell functions and bundle ids keep no space.
    (re.compile(r"(?<![A-Za-z0-9_])Rook-(?=[A-Z])"), "PolarisTerminal-"),
    (re.compile(r"(CONFIG_DIR: &str = \")\.rook\""), r'\1.polaris-terminal"'),
    (re.compile(r"(Channel::Stable => \")\.rook\""), r'\1.polaris-terminal"'),
    (re.compile(r"\.rook-(?=[a-z])"), ".polaris-terminal-"),
    (re.compile(r"(~|\$HOME|%USERPROFILE%|home_dir\(\)|home\)?|HOME)([/\\]|\.join\(\")\.rook(?![A-Za-z0-9_-])"), r"\1\2.polaris-terminal"),
    (re.compile(r"\.rookindexingignore"), ".polaris-terminal-indexingignore"),
    # The per-repository directory.
    (re.compile(r"(?<![A-Za-z0-9_])\.rook(?![A-Za-z0-9_.-])"), ".polaris/terminal"),
    # Release channels.
    (re.compile(r"(?<![A-Za-z0-9_])rook-oss(?![A-Za-z0-9_])"), "polaris-terminal"),
    (re.compile(r"(?<![A-Za-z])RookOss(?![a-z])"), "PolarisTerminal"),
    (re.compile(r"(?<![A-Za-z])Rook(Dev|Local|Preview|Stable|Integration)(?![a-z])"), r"PolarisTerminal\1"),
]

# URL schemes; only outside Rust code, where they are strings.
SCHEMES = [
    (re.compile(r"(?<![A-Za-z0-9_])rookoss(?![A-Za-z0-9_])"), "polaris-terminal"),
    (re.compile(r"(?<![A-Za-z0-9_])rook(dev|local|preview|stable|integration)(?![A-Za-z0-9_])"), r"polaris-terminal-\1"),
    (re.compile(r"(?<![A-Za-z0-9_])rook::"), "polaris_terminal::"),
]

# Any remaining spelling, one token at a time.
TOKEN = re.compile(r"[Rr][Oo][Oo][Kk]")

def _before(text: str, start: int) -> str:
    """The character before `start`, with an escape such as \\n read as a boundary."""
    if start == 0:
        return ""
    if start >= 2 and text[start - 2] == "\\" and text[start - 1] in "nrt0":
        return ""
    return text[start - 1]

def rewrite_token(text: str, code: bool) -> str:
    def sub(match: re.Match[str]) -> str:
        word = match.group(0)
        start, end = match.span()
        before = _before(text, start)
        after = text[end] if end < len(text) else ""
        if word == "ROOK":
            if text.startswith("UI", end):
                return "PTERM"
            return "POLARIS_TERMINAL"
        if word == "Rook":
            if after.isalnum() or before.isalnum() or after == "_" or before == "_":
                return "Pterm"
            return "Pterm" if code else "Polaris Terminal"
        if word == "rook":
            if after.isalpha() or after.isdigit() or after == "_" or before == "_" or before.isalnum():
                return "pterm"
            if after == "-" or before == "-":
                return "polaris-terminal"
            return "polaris_terminal" if code else "polaris-terminal"
        return word

    return TOKEN.sub(sub, text)

def apply_fixed(text: str) -> str:
    for pattern, replacement in FIXED:
        text = pattern.sub(replacement, text)
    return text


def rewrite_segment(text: str, code: bool) -> str:
    if not code:
        for pattern, replacement in SCHEMES:
            text = pattern.sub(replacement, text)
    return rewrite_token(text, code)

def rust_segments(source: str):
    """Split Rust source into (text, is_code) runs: strings and comments are not code."""
    i, n, start = 0, len(source), 0
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        end = None
        if c == "/" and nxt == "/":
            end = source.find("\n", i)
            end = n if end == -1 else end
        elif c == "/" and nxt == "*":
            depth, j = 1, i + 2
            while j < n and depth:
                if source.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif source.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            end = j
        elif c in "rb" and not (i and (source[i - 1].isalnum() or source[i - 1] == "_")):
            m = re.match(r"(?:br|r)(#*)\"", source[i:])
            if m:
                closing = "\"" + m.group(1)
                j = source.find(closing, i + len(m.group(0)))
                end = n if j == -1 else j + len(closing)
            elif c == "b" and nxt == "\"":
                end = _string_end(source, i + 1)
        elif c == "\"":
            end = _string_end(source, i)
        elif c == "'":
            m = re.match(r"'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'", source[i:])
            if m:
                end = i + len(m.group(0))
        if end is None:
            i += 1
            continue
        if start < i:
            yield source[start:i], True
        yield source[i:end], False
        start = i = end
    if start < n:
        yield source[start:], True

def _string_end(source: str, quote: int) -> int:
    j, n = quote + 1, len(source)
    while j < n:
        if source[j] == "\\":
            j += 2
            continue
        if source[j] == "\"":
            return j + 1
        j += 1
    return n

def rewrite_text(text: str, rust: bool) -> str:
    preserved: list[str] = []

    def stash(match: re.Match[str]) -> str:
        preserved.append(match.group(0))
        return f"\x00keep{len(preserved) - 1}\x00"

    text = apply_fixed(PRESERVE.sub(stash, text))
    if rust:
        text = "".join(rewrite_segment(part, code) for part, code in rust_segments(text))
    else:
        text = rewrite_segment(text, False)
    for index, original in enumerate(preserved):
        text = text.replace(f"\x00keep{index}\x00", original)
    return text

def rewrite_contents(root: str, dry_run: bool) -> int:
    changed = 0
    for dirpath, _, filenames in rebrand.walk(root):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(path, root)
            if rel_path in SKIP_SCRIPTS or rebrand.is_licence_file(filename):
                continue
            if os.path.splitext(rel_path)[1].lower() in rebrand.BINARY_SUFFIXES:
                continue
            if rel_path.startswith(os.path.join("crates", "input_classifier", "models")):
                continue
            with open(path, "rb") as handle:
                raw = handle.read()
            if b"\x00" in raw:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if not TOKEN.search(text):
                continue
            updated = rewrite_text(text, rel_path.endswith(".rs"))
            if updated == text:
                continue
            changed += 1
            if dry_run:
                print(f"content: {rel_path}")
                continue
            with open(path, "wb") as handle:
                handle.write(updated.encode("utf-8"))
    return changed

def rename_component(name: str) -> str:
    if name == ".rook":
        return os.path.join(".polaris", "terminal")
    return rewrite_segment(apply_fixed(name), False)

def rewrite_paths(root: str, dry_run: bool) -> int:
    targets = []
    for dirpath, dirnames, filenames in rebrand.walk(root):
        for name in filenames + dirnames:
            if TOKEN.search(name):
                targets.append(os.path.join(dirpath, name))
    targets.sort(key=lambda p: p.count(os.sep), reverse=True)
    renamed = 0
    for path in targets:
        parent, name = os.path.split(path)
        destination = os.path.join(parent, rename_component(name))
        if destination == path:
            continue
        renamed += 1
        if dry_run:
            print(f"path: {os.path.relpath(path, root)} -> {os.path.relpath(destination, root)}")
            continue
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.rename(path, destination)
    return renamed

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    parser.add_argument("--root", default=rebrand.REPO_ROOT, help="tree to rewrite (default: the terminal tree)")
    args = parser.parse_args()
    root = os.path.abspath(args.root)
    contents = rewrite_contents(root, args.dry_run)
    paths = rewrite_paths(root, args.dry_run)
    verb = "would rewrite" if args.dry_run else "rewrote"
    print(f"{verb} {contents} file(s) and {paths} path(s)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
