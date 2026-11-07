#!/usr/bin/env bash
# Run the whole test suite, including the companion-installer suites that need
# root (they drive the real installers against stubbed apt/pip/systemctl), on a
# developer machine without passwordless sudo.
#
# An unprivileged user namespace (unshare -Ur) gives the test process uid 0 and
# a `sudo` shim that simply execs its arguments. Nothing outside the temporary
# test trees is touched. The installer fixtures target a service account named
# "ubuntu" (the Pi image / CI); here only root exists, so it is overridden.
#
#   pnpm test:privileged            # whole suite
#   pnpm test:privileged server/companion-installers.test.ts
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v unshare >/dev/null || { echo "unshare (util-linux) is required" >&2; exit 1; }
unshare -Ur true 2>/dev/null || { echo "unprivileged user namespaces are disabled on this kernel; run the suite with passwordless sudo instead" >&2; exit 1; }
SHIM=$(mktemp -d)
trap 'rm -rf -- "$SHIM"' EXIT
cat > "$SHIM/sudo" <<'EOF'
#!/bin/bash
# passthrough sudo: inside the namespace we already are uid 0
while [ "$#" -gt 0 ]; do case "$1" in -n|-E|-H) shift ;; -u) shift 2 ;; --) shift; break ;; *) break ;; esac; done
exec "$@"
EOF
chmod +x "$SHIM/sudo"
cd "$HERE/.."
exec unshare -Ur env PATH="$SHIM:$PATH" QUIVER_TEST_SERVICE_USER="${QUIVER_TEST_SERVICE_USER:-root}" pnpm exec vitest run "$@"
