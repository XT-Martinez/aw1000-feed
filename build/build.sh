#!/usr/bin/env bash
# Build the AW1000 image inside OpenWrt's buildbot worker container, so that
# nothing but the bind-mounted source trees is touched on the host.
#
#   build/build.sh            feeds + config + full build
#   build/build.sh shell      interactive shell in the same container
#   build/build.sh make ...   run make with the given arguments
#
# Layout expected next to this repo (see HANDOVER.md):
#   ../openwrt             nss-edma-rework checkout (build tree, read-write)
#   ../nss-packages        edma-nss feed checkout
#   ../builder-reference   Qualcommax_NSS_Builder (common config + overlays)

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/openwrt/buildbot/buildworker-v3.11.8:latest}"
FEED_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TOP="$(cd -- "$FEED_DIR/.." && pwd)"

for d in openwrt nss-packages builder-reference; do
	[[ -d "$TOP/$d" ]] || { echo "missing $TOP/$d" >&2; exit 1; }
done

# keep-id runs the build as the invoking user, so the tree stays owned by
# them; label=disable avoids relabelling the whole tree on SELinux hosts.
run() {
	local tty=(-i)
	[[ -t 0 ]] && tty=(-it)
	podman run --rm "${tty[@]}" \
		--userns=keep-id \
		--security-opt label=disable \
		--entrypoint /bin/bash \
		-e HOME=/tmp \
		-e TERM="${TERM:-xterm}" \
		-v "$TOP/openwrt:/work/openwrt" \
		-v "$FEED_DIR:/work/aw1000-feed:ro" \
		-v "$TOP/nss-packages:/work/nss-packages:ro" \
		-v "$TOP/builder-reference:/work/builder-reference:ro" \
		-w /work/openwrt \
		"$IMAGE" "$@"
}

case "${1:-all}" in
shell) run ;;
make) shift; run -c 'make "$@"' make "$@" ;;
all | prepare) run /work/aw1000-feed/build/inside.sh "${1:-all}" ;;
*) echo "usage: $0 [all|prepare|shell|make ...]" >&2; exit 1 ;;
esac
