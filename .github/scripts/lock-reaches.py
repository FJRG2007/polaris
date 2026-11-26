#!/usr/bin/env python3
"""Say whether a Cargo.lock change between two commits reaches one crate.

    python3 .github/scripts/lock-reaches.py <crate> <before> <after>   # prints true or false

The workspace shares one Cargo.lock, so a version bump of any crate in it - a
device plugin's native module, say - changes the file every image job used to
watch. Rebuilt for that, the host daemon's image moved for a change that never
reaches its binary. This compares the lock entries the crate reaches (the same
closure tunnel-inputs.py fingerprints) at both commits, and says true when they
differ, or when either cannot be read: an unreadable lock is a reason to build.
"""

import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("tunnel_inputs", pathlib.Path(__file__).with_name("tunnel-inputs.py"))
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)

def reaches(crate: str, before: str, after: str) -> bool:
    try:
        return inputs.lock_closure(before, crate) != inputs.lock_closure(after, crate)
    except (Exception, SystemExit):
        return True

if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: lock-reaches.py <crate> <before> <after>")
    print("true" if reaches(*sys.argv[1:]) else "false")
