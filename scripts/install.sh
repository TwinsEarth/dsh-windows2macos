#!/usr/bin/env bash
#
# One-command installer for the W2M DSH plugin (macOS / Linux).
#
# =============================================================================
#  NOT VERIFIED ON macOS OR LINUX
# =============================================================================
#  This script was written and reviewed on Windows. Its syntax was checked with
#  `bash -n`, and the flow was exercised end to end under **Git Bash on Windows**
#  (download, checksum, staging, install through the runtime pnpm, readback
#  verification, rollback). What that does NOT cover, and what therefore remains
#  unverified until someone runs it on the real platform:
#
#    * `shasum -a 256` (the macOS branch; on Windows the `sha256sum` branch ran);
#    * the `wget` download branch (curl was present, so wget never ran);
#    * `dsh` CLI discovery from a real macOS/Linux install (on Windows the
#      runtime-pnpm fallback was what actually installed the package);
#    * macOS/Linux DSH_HOME defaults and permissions (0600/0700 semantics);
#    * anything involving `$HOME` paths that only exist on those platforms.
#
#  Every branch above is marked with `# UNVERIFIED(macos/linux):` in the code.
#  If you are the first person to run this on macOS, please report what breaks.
# =============================================================================
#
# What it does, in order (nothing is written before step 5):
#
#   1. checks Node >= 20.19.0 (what ESLint 10 and `engines` require);
#   2. resolves `<DSH_HOME>/profiles/<name>` and refuses to guess when it is
#      missing -- it lists the profiles that do exist;
#   3. reads `SHA256SUMS` from the release and treats it as the manifest: both
#      the tarball name and the expected hash come from it;
#   4. if the profile already has that exact version and --force was not given,
#      prints "already up to date" and exits 0 without downloading anything;
#   5. downloads to a temporary file **next to the profile** (not to $TMPDIR):
#      `package.json` will record a `file:` path, and a temp directory that is
#      later cleaned breaks every future `pnpm install`;
#   6. verifies sha256; on a mismatch the temporary file is deleted and the
#      install never starts -- zero bytes reach the profile;
#   7. backs up `package.json` and `pnpm-lock.yaml`, then installs with
#      `dsh plugin --profile <name> add <tarball>` (falling back to the DSH
#      runtime's own pnpm when the `dsh` CLI is not on PATH);
#   8. restores that backup if the install fails;
#   9. loads the installed copy through scripts/verify-installed.mjs -- "it
#      installed" is not "it loads", which this project has been burned by;
#  10. prints how to start the relay and an agent.
#
# Usage:
#   ./install.sh --profile desktop
#   ./install.sh --profile desktop --version v0.3.0
#   ./install.sh --profile desktop --tarball ./plugin.tgz --sha256 <64 hex>
#   ./install.sh --profile desktop --release-base /mnt/mirror
#
# Every failure names the cause and the next command to run.

set -euo pipefail

PACKAGE_NAME='@twinsearth/w2m-dsh-plugin'
REQUIRED_NODE='20.19.0'
STAGING_DIR_NAME='.w2m-update'
DEFAULT_REPO='TwinsEarth/dsh-windows2macos'

PROFILE_NAME='default'
VERSION=''
TARBALL=''
EXPECTED_SHA=''
DSH_PATH=''
DSH_HOME_OVERRIDE=''
REPO="$DEFAULT_REPO"
RELEASE_BASE=''
FORCE=0

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_HEAD=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RESET=''; C_HEAD=''; C_OK=''; C_WARN=''; C_ERR=''
fi

head()  { printf '\n%s== %s%s\n' "$C_HEAD" "$1" "$C_RESET"; }
ok()    { printf '  %s[ok]%s   %s\n' "$C_OK" "$C_RESET" "$1"; }
info()  { printf '  [info] %s\n' "$1"; }
warn()  { printf '  %s[warn]%s %s\n' "$C_WARN" "$C_RESET" "$1"; }

# Every failure prints the reason and the next command, then exits non-zero.
fail() {
  reason=$1; shift
  printf '\n  %s[FAIL]%s %s\n' "$C_ERR" "$C_RESET" "$reason" >&2
  if [ "$#" -gt 0 ]; then
    printf '  next steps:\n' >&2
    for line in "$@"; do printf '    - %s\n' "$line" >&2; done
  fi
  exit 1
}

usage() {
  sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)       PROFILE_NAME="${2:-}"; shift 2 ;;
    --profile=*)     PROFILE_NAME="${1#*=}"; shift ;;
    --version)       VERSION="${2:-}"; shift 2 ;;
    --version=*)     VERSION="${1#*=}"; shift ;;
    --tarball)       TARBALL="${2:-}"; shift 2 ;;
    --tarball=*)     TARBALL="${1#*=}"; shift ;;
    --sha256)        EXPECTED_SHA="${2:-}"; shift 2 ;;
    --sha256=*)      EXPECTED_SHA="${1#*=}"; shift ;;
    --dsh)           DSH_PATH="${2:-}"; shift 2 ;;
    --dsh=*)         DSH_PATH="${1#*=}"; shift ;;
    --dsh-home)      DSH_HOME_OVERRIDE="${2:-}"; shift 2 ;;
    --dsh-home=*)    DSH_HOME_OVERRIDE="${1#*=}"; shift ;;
    --repo)          REPO="${2:-}"; shift 2 ;;
    --repo=*)        REPO="${1#*=}"; shift ;;
    --release-base)  RELEASE_BASE="${2:-}"; shift 2 ;;
    --release-base=*) RELEASE_BASE="${1#*=}"; shift ;;
    --force)         FORCE=1; shift ;;
    -h|--help)       usage ;;
    *) fail "unknown argument: $1" "run '$0 --help' for the accepted flags" ;;
  esac
done

[ -n "$PROFILE_NAME" ] || fail "--profile needs a value" "example: $0 --profile desktop"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# tiny helpers
# ---------------------------------------------------------------------------

# mkdir -p a directory, naming the reason when it is impossible.
make_dir() {
  [ -d "$1" ] && return 0
  mkdir -p "$1" || fail "could not create $1" "check permissions on the parent directory"
}

# Is $1 >= $2? Version comparison without `sort -V` (BSD sort does not have it).
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    na=split(a,x,"."); nb=split(b,y,".");
    n=(na>nb)?na:nb;
    for(i=1;i<=n;i++){ xi=(i<=na)?x[i]+0:0; yi=(i<=nb)?y[i]+0:0;
      if(xi>yi) exit 0; if(xi<yi) exit 1 }
    exit 0 }'
}

# sha256 of a file: GNU, then BSD/macOS, then openssl.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    # UNVERIFIED(macos/linux): this is the branch macOS uses; a Windows Git Bash
    # run took the sha256sum branch above.
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    # UNVERIFIED(macos/linux): openssl fallback, not exercised anywhere yet.
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    fail "no sha256 tool found (sha256sum, shasum or openssl)" \
      "install coreutils (Linux) or use the system shasum (macOS)"
  fi
}

is_url() { case "$1" in http://*|https://*) return 0 ;; *) return 1 ;; esac; }

# Copy or download one artifact. Follows redirects: GitHub release assets always
# answer with a 302, and a client that does not follow it saves an HTML page.
fetch_artifact() {
  src="$1"; dest="$2"
  if is_url "$src"; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 2 --max-time 300 -o "$dest" "$src" && return 0
      return 1
    fi
    if command -v wget >/dev/null 2>&1; then
      # UNVERIFIED(macos/linux): the wget branch never ran; curl was always present.
      wget -q -O "$dest" "$src" && return 0
      return 1
    fi
    fail "neither curl nor wget is available to download $src" \
      "install curl: 'apt install curl' / 'brew install curl'"
  fi
  [ -f "$src" ] || return 1
  cp -f "$src" "$dest"
}

# ---------------------------------------------------------------------------
# 1. Node
# ---------------------------------------------------------------------------

head 'W2M DSH plugin installer (bash)'
info "profile : $PROFILE_NAME"
info "repo    : $REPO"
printf '  %s[note]%s  this script is NOT verified on macOS or Linux; see the header\n' "$C_WARN" "$C_RESET"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found on PATH, and this project requires Node >= $REQUIRED_NODE." \
    "install Node $REQUIRED_NODE or newer: https://nodejs.org/en/download" \
    "macOS: 'brew install node'; Debian/Ubuntu: use the NodeSource repository" \
    "then open a NEW terminal (PATH is only refreshed in new shells) and re-run"
fi
NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//')" || NODE_VERSION=''
[ -n "$NODE_VERSION" ] || fail "node is on PATH but 'node -v' printed nothing; the installation looks broken." \
  "run 'node -v' yourself and fix the Node installation"

if ! version_ge "$NODE_VERSION" "$REQUIRED_NODE"; then
  fail "Node $NODE_VERSION is too old: this project needs >= $REQUIRED_NODE." \
    "upgrade Node: https://nodejs.org/en/download (ESLint 10 and the build scripts require it)" \
    "nvm: 'nvm install $REQUIRED_NODE && nvm use $REQUIRED_NODE'"
fi
ok "node $NODE_VERSION (>= $REQUIRED_NODE)"

# ---------------------------------------------------------------------------
# 2. profile
# ---------------------------------------------------------------------------

if [ -n "$DSH_HOME_OVERRIDE" ]; then
  DSH_HOME_PATH="$DSH_HOME_OVERRIDE"
elif [ -n "${DSH_HOME:-}" ]; then
  DSH_HOME_PATH="$DSH_HOME"
else
  DSH_HOME_PATH="$HOME/.dsh"
fi

PROFILES_ROOT="$DSH_HOME_PATH/profiles"
PROFILE_DIR="$PROFILES_ROOT/$PROFILE_NAME"
if [ ! -d "$PROFILE_DIR" ]; then
  AVAILABLE=''
  if [ -d "$PROFILES_ROOT" ]; then
    AVAILABLE="$(ls -1 "$PROFILES_ROOT" 2>/dev/null | tr '\n' ' ' || true)"
  fi
  NEXT_1="list the profiles DSH already has: ls '$PROFILES_ROOT'"
  NEXT_2="create the profile in the DSH desktop app (Profiles), then re-run with --profile <name>"
  if [ -n "$AVAILABLE" ]; then
    fail "DSH profile '$PROFILE_NAME' was not found at $PROFILE_DIR." \
      "existing profiles: $AVAILABLE" "$NEXT_1" "$NEXT_2"
  fi
  fail "DSH profile '$PROFILE_NAME' was not found at $PROFILE_DIR." "$NEXT_1" "$NEXT_2"
fi
ok "profile $PROFILE_DIR"

installed_version() {
  manifest="$PROFILE_DIR/node_modules/$PACKAGE_NAME/package.json"
  [ -f "$manifest" ] || return 0
  node -e 'try{const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.version||""))}catch{}' "$manifest" 2>/dev/null || true
}
INSTALLED_VERSION="$(installed_version)"
if [ -n "$INSTALLED_VERSION" ]; then
  info "installed version: $INSTALLED_VERSION"
else
  info 'installed version: (not installed yet)'
fi

# The work directory lives inside the profile on purpose: `package.json` will
# record a `file:` path to the staged tarball, and $TMPDIR is not durable.
STAGING_DIR="$PROFILE_DIR/$STAGING_DIR_NAME"
make_dir "$STAGING_DIR"

# ---------------------------------------------------------------------------
# 3. release metadata
# ---------------------------------------------------------------------------

TAG="$VERSION"
if [ -n "$RELEASE_BASE" ] || [ -n "$TAG" ] || [ -n "$TARBALL" ]; then
  : # nothing to look up: the base is explicit, the tag is pinned, or the file is local
else
  API_JSON="$(curl -fsSL --max-time 60 -H 'User-Agent: w2m-install' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  # No jq dependency: the tag is a plain string field.
  TAG="$(printf '%s' "$API_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi

# A local `--tarball` needs no release metadata at all: the checksum comes from
# --sha256, so asking GitHub for SHA256SUMS would make an offline install
# impossible (and it is the first thing that breaks behind a proxy).
ENTRY=''
if [ -z "$TARBALL" ]; then
  if [ -n "$RELEASE_BASE" ]; then
    SUMS_SRC="$RELEASE_BASE/SHA256SUMS"
  elif [ -n "$TAG" ]; then
    SUMS_SRC="https://github.com/$REPO/releases/download/$TAG/SHA256SUMS"
  else
    SUMS_SRC="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
  fi

  SUMS_PATH="$STAGING_DIR/SHA256SUMS"
  if ! fetch_artifact "$SUMS_SRC" "$SUMS_PATH"; then
    NEXT=("check network/proxy access to github.com (curl honours HTTPS_PROXY)"
          "or install a local file instead: --tarball <path.tgz> --sha256 <expected>"
          "or point at a mirror directory holding SHA256SUMS and the tarball: --release-base <dir>"
          "or pin a specific release: --version v0.3.0")
    if [ -n "$INSTALLED_VERSION" ]; then
      NEXT=("this profile already has $PACKAGE_NAME $INSTALLED_VERSION; if that is the version you want, no action is needed" "${NEXT[@]}")
    fi
    fail "could not read SHA256SUMS from $SUMS_SRC" "${NEXT[@]}"
  fi

  # First .tgz line wins; the hash is the manifest, not a suggestion.
  ENTRY="$(awk '/^[0-9a-fA-F]{64}[[:space:]]+\*?.*\.tgz$/ {print; exit}' "$SUMS_PATH")"
  [ -n "$ENTRY" ] || fail "SHA256SUMS from $SUMS_SRC contains no .tgz entry; the release looks malformed." \
    "open the release page and check that the tarball asset was uploaded" \
    "or install a local file: --tarball <path.tgz> --sha256 <expected>"
fi

EXPECTED_FROM_SUMS="$(printf '%s' "$ENTRY" | awk '{print tolower($1)}')"
RELEASE_FILE="$(printf '%s' "$ENTRY" | awk '{print $2}' | sed 's/^\*//')"
RELEASE_VERSION="$(printf '%s' "$RELEASE_FILE" | sed -n 's/^twinsearth-w2m-dsh-plugin-\(.*\)\.tgz$/\1/p')"

if [ -n "$RELEASE_BASE" ]; then
  RELEASE_URL="$RELEASE_BASE/$RELEASE_FILE"
elif [ -n "$TAG" ]; then
  RELEASE_URL="https://github.com/$REPO/releases/download/$TAG/$RELEASE_FILE"
else
  RELEASE_URL="https://github.com/$REPO/releases/latest/download/$RELEASE_FILE"
fi

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || fail "the tarball given with --tarball does not exist: $TARBALL" \
    "check the path (it must be a .tgz built by 'node scripts/pack.mjs')" \
    "or drop --tarball to install from the latest GitHub release"
  SOURCE_FILE="$(basename "$TARBALL")"
  SOURCE_URL="$TARBALL"
  SOURCE_LOCAL=1
  SOURCE_VERSION=''
  info "source  : local file $TARBALL"
else
  SOURCE_FILE="$RELEASE_FILE"
  SOURCE_URL="$RELEASE_URL"
  SOURCE_LOCAL=0
  SOURCE_VERSION="$RELEASE_VERSION"
  info "source  : $SOURCE_URL"
  [ -n "$TAG" ] && info "release : $TAG"
fi

# Idempotence: with a known target version, an up-to-date profile is success --
# and nothing is downloaded in that case.
if [ "$SOURCE_LOCAL" -eq 0 ] && [ -n "$SOURCE_VERSION" ] && [ "$INSTALLED_VERSION" = "$SOURCE_VERSION" ] && [ "$FORCE" -eq 0 ]; then
  printf '\n  %s[ok]%s   already up to date: %s %s\n' "$C_OK" "$C_RESET" "$PACKAGE_NAME" "$INSTALLED_VERSION"
  info 'nothing was downloaded or installed; pass --force to reinstall anyway'
  exit 0
fi

STAGED_TARBALL="$STAGING_DIR/$SOURCE_FILE"
TMP_DOWNLOAD="$STAGED_TARBALL.part"

# ---------------------------------------------------------------------------
# 4/5. fetch + verify (the only steps before anything durable appears)
# ---------------------------------------------------------------------------

head 'download'
rm -f "$TMP_DOWNLOAD"
if [ "$SOURCE_LOCAL" -eq 1 ]; then
  cp -f "$SOURCE_URL" "$TMP_DOWNLOAD" || fail "could not copy $SOURCE_URL" "check that the file is readable"
  ok 'copied local file to a temporary file for verification'
else
  if ! fetch_artifact "$SOURCE_URL" "$TMP_DOWNLOAD"; then
    rm -f "$TMP_DOWNLOAD"
    fail "download failed: $SOURCE_URL" \
      "check network/proxy access to github.com (curl honours HTTPS_PROXY)" \
      "retry: the same command" \
      "offline install: download $SOURCE_FILE and run with --tarball <path> --sha256 <hash from SHA256SUMS>" \
      "or point at a mirror directory: --release-base <dir>"
  fi
  ok "downloaded $SOURCE_FILE"
fi

head 'verify checksum'
if [ -n "$TARBALL" ] && [ -n "$EXPECTED_SHA" ]; then
  EXPECTED="$EXPECTED_SHA"
elif [ -n "$TARBALL" ]; then
  # A local file with no expected hash cannot be checked against the project's
  # own promise, so it is refused rather than installed unverified.
  rm -f "$TMP_DOWNLOAD"
  fail "no expected sha256 is available, so the tarball cannot be verified; refusing to install." \
    "install from the release instead (drop --tarball), where SHA256SUMS supplies the hash" \
    "or pass --sha256 <64 hex chars> alongside --tarball"
else
  EXPECTED="$EXPECTED_FROM_SUMS"
fi
EXPECTED="$(printf '%s' "$EXPECTED" | tr 'A-Z' 'a-z')"

ACTUAL="$(sha256_of "$TMP_DOWNLOAD")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  rm -f "$TMP_DOWNLOAD"
  fail "checksum mismatch -- nothing was installed." \
    "expected $EXPECTED" \
    "actual   $ACTUAL" \
    "re-download: the file may have been truncated or modified in transit" \
    "if it keeps happening, report it: the release asset itself may be corrupt"
fi
ok "sha256 $ACTUAL"

# Only now does anything durable appear: verified bytes are moved into place.
mv -f "$TMP_DOWNLOAD" "$STAGED_TARBALL"
ok "staged -> $STAGED_TARBALL"

# ---------------------------------------------------------------------------
# 6/7. install, with backup and restore
# ---------------------------------------------------------------------------

head 'install'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$STAGING_DIR/backup-$STAMP"
make_dir "$BACKUP_DIR"
SAVED=''
for name in package.json pnpm-lock.yaml; do
  if [ -f "$PROFILE_DIR/$name" ]; then
    cp -f "$PROFILE_DIR/$name" "$BACKUP_DIR/$name"
    SAVED="$SAVED $name"
  fi
done
ok "backed up${SAVED:- nothing} -> $BACKUP_DIR"

restore_profile() {
  for name in package.json pnpm-lock.yaml; do
    if [ -f "$BACKUP_DIR/$name" ]; then
      cp -f "$BACKUP_DIR/$name" "$PROFILE_DIR/$name"
      warn "restored $name from $BACKUP_DIR"
    elif [ -f "$PROFILE_DIR/$name" ]; then
      # A lockfile pnpm created must not survive a rolled-back install.
      rm -f "$PROFILE_DIR/$name"
      warn "removed $name (it did not exist before the install)"
    fi
  done
}

DSH_BIN=''
if [ -n "$DSH_PATH" ]; then
  if [ -x "$DSH_PATH" ] || [ -f "$DSH_PATH" ]; then
    DSH_BIN="$DSH_PATH"
  else
    fail "--dsh '$DSH_PATH' does not exist." \
      "pass the real path to the dsh CLI, or drop --dsh to use the runtime pnpm fallback"
  fi
elif command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
fi

PNPM_MJS=''
for runtime in "$DSH_HOME_PATH"/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs; do
  # UNVERIFIED(macos/linux): on macOS/Linux this glob is the same shape, but only
  # the Windows layout has actually been used.
  if [ -f "$runtime" ]; then PNPM_MJS="$runtime"; break; fi
done

INSTALL_OK=0
if [ -n "$DSH_BIN" ]; then
  info "running: dsh plugin --profile $PROFILE_NAME add <tarball>"
  if "$DSH_BIN" plugin --profile "$PROFILE_NAME" add "$STAGED_TARBALL"; then INSTALL_OK=1; fi
  # UNVERIFIED(macos/linux): the dsh CLI was not present on this machine, so this
  # branch has never executed anywhere.
else
  warn 'the dsh CLI was not found on PATH; using the DSH runtime pnpm instead'
  warn '(that is the same package manager `dsh plugin` drives; --dsh overrides)'
  if [ -z "$PNPM_MJS" ]; then
    restore_profile
    fail 'neither the dsh CLI nor the DSH runtime pnpm could be found.' \
      "pass the CLI explicitly: --dsh /path/to/dsh" \
      "or point at the DSH home that holds dsh-runtimes: --dsh-home ~/.dsh" \
      "the DSH desktop app ships both; installing/updating it restores them"
  fi
  info "running: node --expose-internals <pnpm.mjs> add <tarball> --dir <profile>"
  if node --expose-internals "$PNPM_MJS" add "$STAGED_TARBALL" --dir "$PROFILE_DIR"; then INSTALL_OK=1; fi
fi

if [ "$INSTALL_OK" -ne 1 ]; then
  restore_profile
  fail "the package manager failed, so the profile was restored from $BACKUP_DIR." \
    "re-run and read the output above: it names the failing step" \
    "if the tarball was staged correctly, retry with --force" \
    "if the profile is shared/corrupted: check that '$PROFILE_DIR/package.json' is valid JSON"
fi
if [ -n "$DSH_BIN" ]; then ok 'installed via dsh'; else ok 'installed via pnpm'; fi

# ---------------------------------------------------------------------------
# 8. readback verification
# ---------------------------------------------------------------------------

head 'verify the install actually loads'
PKG_DIR="$PROFILE_DIR/node_modules/$PACKAGE_NAME"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-installed.mjs"
if [ ! -f "$VERIFY_SCRIPT" ]; then
  warn "could not find $VERIFY_SCRIPT, skipping the load check"
else
  if ! node "$VERIFY_SCRIPT" "$PKG_DIR"; then
    restore_profile
    fail "the package installed but does not load, so the profile was restored. That combination is exactly what this check exists for." \
      "the output above lists the tools that *did* register; compare with the expected six" \
      "if the release predates a tool you expect, install a newer release: --version v0.3.0" \
      "re-run with --force after fixing the release"
  fi
  ok 'the installed copy loads and registers its tools'
fi

NEW_VERSION="$(installed_version)"
head 'done'
ok "$PACKAGE_NAME ${NEW_VERSION:-?} installed into profile '$PROFILE_NAME'"
info "tarball  : $STAGED_TARBALL"
info "backup   : $BACKUP_DIR   (kept; delete it once you are happy)"
printf '\n  next steps:\n'
printf '    1. start the relay (on the machine that will coordinate):\n'
printf '         w2m-rabbit --port 8787 --state "%s/xclient/rabbit"\n' "$DSH_HOME_PATH"
printf '       it prints a PAIR-XXXXXXXX code on first start.\n'
printf '    2. start an agent on every machine that should run commands:\n'
printf '         w2m-localside --rabbit http://<relay-host>:8787 --pair PAIR-XXXXXXXX \\\n'
printf '           --project <path> --allowed-commands '"'"'["node --test"]'"'"'\n'
printf '    3. restart DSH so the profile picks up the new plugin version.\n\n'
exit 0
