#!/usr/bin/env bash
# Build prebuilt harnage binaries and draft a GitHub release.
# Does NOT publish/push anything by default — pass --publish to actually run
# `gh release create`. Without it, prints the plan (--dry-run behavior is the
# default) and leaves binaries in dist/release/.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
OUT_DIR="dist/release"
DO_PUBLISH=false

for arg in "$@"; do
  case "$arg" in
    --publish) DO_PUBLISH=true ;;
    --dry-run) DO_PUBLISH=false ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

TARGETS=(
  "bun-darwin-arm64:harnage-darwin-arm64"
  "bun-linux-x64:harnage-linux-x64"
)

echo "harnage release plan"
echo "  version: ${VERSION}"
echo "  tag:     ${TAG}"
echo "  targets: ${TARGETS[*]}"
echo "  publish: ${DO_PUBLISH}"
echo ""

mkdir -p "$OUT_DIR"

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  outfile="${OUT_DIR}/${entry##*:}"
  echo "==> building ${target} -> ${outfile}"
  bun build --compile --target="${target}" --outfile="${outfile}" src/main.tsx
done

echo ""
echo "==> binaries built:"
ls -lh "$OUT_DIR"

if [ "$DO_PUBLISH" = false ]; then
  echo ""
  echo "Dry run only — no GitHub release created."
  echo "To draft a release without publishing it live, this would run:"
  echo "  gh release create ${TAG} ${OUT_DIR}/* --draft --title \"harnage ${TAG}\" --generate-notes"
  echo "Re-run with --publish to actually create the draft release on GitHub."
  exit 0
fi

echo "==> creating draft GitHub release ${TAG}"
gh release create "${TAG}" "${OUT_DIR}"/* \
  --draft \
  --title "harnage ${TAG}" \
  --generate-notes
