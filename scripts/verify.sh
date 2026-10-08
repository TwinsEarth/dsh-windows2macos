#!/usr/bin/env bash
# W2M acceptance run 鈥?macOS / Linux entry point.
#
# Same job as verify.ps1: run every suite, summarise, and let the exit code be
# the verdict. Kept as a separate file rather than one clever cross-platform
# script, because a verification script that needs its own verification is not
# worth the saving.
#
# Usage:
#   bash scripts/verify.sh              # everything
#   bash scripts/verify.sh relay agent  # only the named suites

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Prefer the Node that ships with DSH when present: it is the interpreter the
# plugin runs under in production.
node_bin="node"
if [[ -n "${DSH_HOME:-}" && -x "${DSH_HOME}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]]; then
  node_bin="${DSH_HOME}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
elif [[ -x "${HOME}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]]; then
  node_bin="${HOME}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
fi

echo "node: ${node_bin}"
"${node_bin}" -v
echo

all_suites=(relay agent tools schedule auto-update update-source update-install update-wiring signing e2e)
if [[ $# -gt 0 ]]; then
  suites=("$@")
else
  suites=("${all_suites[@]}")
fi

declare -a names=()
declare -a states=()
failed=0

for suite in "${suites[@]}"; do
  file="test/${suite}.test.mjs"
  if [[ ! -f "${file}" ]]; then
    echo "SKIP  ${suite} (missing ${file})"
    names+=("${suite}")
    states+=("missing")
    continue
  fi
  echo "=== ${suite} ==="
  if "${node_bin}" --test "${file}"; then
    names+=("${suite}")
    states+=("pass")
  else
    code=$?
    names+=("${suite}")
    states+=("FAIL(${code})")
    failed=$((failed + 1))
  fi
  echo
done

echo "=== summary ==="
for i in "${!names[@]}"; do
  printf '  %-8s %s\n' "${names[$i]}" "${states[$i]}"
done

if [[ "${failed}" -gt 0 ]]; then
  echo
  echo "${failed} suite(s) failed."
  exit 1
fi

echo
echo "All suites passed."
exit 0

