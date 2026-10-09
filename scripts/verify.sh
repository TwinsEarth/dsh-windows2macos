#!/usr/bin/env bash
# W2M acceptance ru - macOS / Linux entry point.
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

# Kept in step with the explicit list in .github/workflows/ci.yml. A suite that is
# not named here is silently not run, which is how four suites (166 cases) once
# shipped without ever executing in CI.
all_suites=(relay broadcast agent tools schedule auto-update update-source update-install update-wiring signing stress metrics metrics-route shared-config tool-cards p2p-stun p2p-transport p2p-signaling p2p-node p2p-transport-fields p2p-plugin p2p-agent stun-server e2e crossnetwork signing-e2e outbound-only recovery pipeline-e2e)
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
  # --test-force-exit: the end-to-end suites hold open SSE connections, and a long-lived
  # stream keeps Node's event loop alive after the assertions have passed. Without it a
  # green suite can hang the run, which looks exactly like a suite that never finished.
  if "${node_bin}" --test --test-force-exit "${file}"; then
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

