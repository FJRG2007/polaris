#!/bin/sh
# Exercises the checkout-realignment path in update.sh: what happens when
# `git pull --ff-only` cannot fast-forward the deployment's own checkout
# (its history was rewritten upstream, or someone edited files in place).
#
# A source build used to fail outright in that case. It now tries to realign
# the checkout first - exactly like an image update already did - and only
# fails the build when realigning itself fails too. This runs the real
# realign_checkout/keep_checkout functions and the real decision block
# against real git repositories, pulled out of update.sh with sed so the
# test runs the current source verbatim.
#
# Run with: sh dashboard/scripts/test/update-realign.test.sh
set -eu

self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
update_sh="$self_dir/../update.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok - %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'not ok - %s\n' "$1"; }

extract() {
    sed -n "/^$1() {/,/^}/p" "$update_sh"
}

eval "$(extract realign_checkout)"
eval "$(extract keep_checkout)"

decision_block=$(sed -n '/if ! git -C "\$dash_dir" pull --ff-only --quiet; then/,/^        fi$/p' "$update_sh")
if [ -z "$decision_block" ]; then
    printf 'setup failed: could not extract the pull/realign decision block from %s\n' "$update_sh" >&2
    exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
repo_root="$scratch/repo_root_placeholder"

# A diverged checkout: upstream moved on its own commit, and the checkout
# being updated has a commit (or edit) of its own - exactly what a
# `pull --ff-only` cannot resolve, and what forced a source build to fail
# before this fix.
make_diverged_checkout() {
    upstream="$scratch/upstream-$1.git"
    seed="$scratch/seed-$1"
    work="$scratch/work-$1"
    git -c init.defaultBranch=main init --quiet --bare "$upstream"
    git clone --quiet "$upstream" "$seed"
    (
        cd "$seed"
        git config user.email test@example.com
        git config user.name Test
        printf 'one\n' > file.txt
        git add file.txt
        git commit --quiet -m initial
        git push --quiet origin HEAD:refs/heads/main
    )
    git clone --quiet "$upstream" "$work"
    (
        cd "$seed"
        printf 'two\n' >> file.txt
        git commit --quiet -am upstream-move
        git push --quiet origin HEAD:refs/heads/main
    )
    (
        cd "$work"
        git config user.email test@example.com
        git config user.name Test
        printf 'local\n' >> file.txt
        git commit --quiet -am local-edit
    )
    printf '%s' "$work"
}

# --- realign_checkout on its own --------------------------------------------

dash_dir=$(make_diverged_checkout a)
log() { :; }
err() { :; }
if realign_checkout; then
    ok "realign_checkout: succeeds on a diverged checkout with a real upstream"
else
    bad "realign_checkout: failed to realign a diverged checkout"
fi
upstream_head=$(git -C "$scratch/upstream-a.git" rev-parse refs/heads/main)
work_head=$(git -C "$dash_dir" rev-parse HEAD)
if [ "$upstream_head" = "$work_head" ]; then
    ok "realign_checkout: the checkout ends up on upstream's HEAD"
else
    bad "realign_checkout: checkout HEAD ($work_head) does not match upstream ($upstream_head)"
fi
if git -C "$dash_dir" for-each-ref refs/polaris/superseded | grep -q .; then
    ok "realign_checkout: the local edit was kept under its own ref instead of discarded"
else
    bad "realign_checkout: no refs/polaris/superseded ref was created for the discarded local edit"
fi

dash_dir=$(make_diverged_checkout b)
(cd "$dash_dir" && git branch --quiet --unset-upstream)
if realign_checkout; then
    bad "realign_checkout: reported success with no upstream to realign against"
else
    ok "realign_checkout: fails cleanly when the checkout has no upstream configured"
fi

# --- the decision block in main(): build vs. image, realign ok vs. failing -

# `err` runs inside the subshell below, so it has to record through a file
# rather than a variable: a subshell's own variable assignments never reach
# back out to the parent shell that reads them afterwards.
err_log="$scratch/err.log"
read_errors() { cat "$err_log" 2>/dev/null || true; }

source=build
dash_dir=$(make_diverged_checkout c)
: > "$err_log"
err() { printf '%s\n' "$1" >> "$err_log"; }
code=0
( eval "$decision_block" ) || code=$?
if [ "$code" = "0" ]; then
    ok "decision block: a source build realigns instead of failing outright on a diverged checkout"
else
    bad "decision block: a source build exited ($code) even though realign_checkout could succeed"
fi
upstream_head=$(git -C "$scratch/upstream-c.git" rev-parse refs/heads/main)
work_head=$(git -C "$dash_dir" rev-parse HEAD)
if [ "$work_head" = "$upstream_head" ]; then
    ok "decision block: the checkout was actually realigned, not just spared the exit"
else
    bad "decision block: checkout HEAD ($work_head) does not match upstream ($upstream_head) after the decision block ran"
fi

source=build
dash_dir=$(make_diverged_checkout d)
realign_checkout() { return 1; }
: > "$err_log"
err() { printf '%s\n' "$1" >> "$err_log"; }
code=0
( eval "$decision_block" ) || code=$?
if [ "$code" = "1" ]; then
    ok "decision block: a source build still fails when realigning itself fails"
else
    bad "decision block: a source build did not fail ($code) when realigning failed"
fi
errors=$(read_errors)
case "$errors" in
    *"builds its own image"*) ok "decision block: the failing build names the reason on stderr" ;;
    *) bad "decision block: the failing build did not explain itself (logged:$errors)" ;;
esac

source=image
dash_dir=$(make_diverged_checkout e)
realign_checkout() { return 1; }
: > "$err_log"
err() { printf '%s\n' "$1" >> "$err_log"; }
code=0
( eval "$decision_block" ) || code=$?
if [ "$code" = "0" ]; then
    ok "decision block: an image update continues even when realigning the checkout fails"
else
    bad "decision block: an image update exited ($code) when the checkout only failed to realign"
fi
errors=$(read_errors)
case "$errors" in
    *"continuing with the published images"*) ok "decision block: an image update logs that it is continuing anyway" ;;
    *) bad "decision block: an image update did not log why it continued (logged:$errors)" ;;
esac

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
