/**
 * The command allow-list matcher: parse the configured entries, then match one argv against them.
 *
 * This is the rule that decides whether an offer may run. It lives in its own module because it has
 * **two** callers that must agree: the agent, which enforces the list on the machine that actually
 * executes the command, and the plugin, whose dispatch-time pre-flight exists so a dispatcher does
 * not send work the target would refuse. A second, independently written pre-flight is how the two
 * ends drift apart, and a pre-flight that is *stricter* than the gate is the worse direction: the
 * agent would have run the command, and the dispatch never happened.
 *
 * ## What an entry means (read this before trusting an allow-list)
 *
 * An entry is a **prefix sequence**, and it grants *everything the tool can be told to do with the
 * arguments that follow it*:
 *
 *   * `"node --test"` means `['node','--test']`, which allows `['node','--test','--test-name-pattern=x']`
 *     and refuses `['node','-e','...']` and a bare `['node']`.
 *   * It also allows `['node','--test','some/file.mjs']` -- and the test runner *loads and executes*
 *     whatever file it is handed. So `node --test` is a grant of arbitrary code execution from any
 *     file this machine can read. **A prefix entry is not a sandbox.** It says which tool may run,
 *     not what that tool will do; the only way to get "this exact command line" semantics is an entry
 *     that names the whole line, and even then the named file's contents are the caller's to choose.
 *
 * Two things narrow that grant, and neither closes it:
 *
 *   1. {@link REPARSING_ARGUMENTS} refuses a named set of *trailing* arguments that make a tool load
 *      code the entry never mentioned (`--test-reporter=file:///…evil.mjs`, `--import`, `python -c`,
 *      `git --exec-path`, …). The set is per-tool, explicit, and deliberately incomplete: PowerShell
 *      abbreviates its own parameter names, `npx`/`xargs`/`sh -c`/`make` exist to run *another*
 *      program, and a tool nobody listed here gets no argument control at all. When an entry does
 *      need one of these arguments, the remedy is to name it **in the entry** -- the entry is the
 *      explicit grant, and this matcher only reads entries.
 *   2. The executable is compared by **identity**, not by spelling: see `executableIdentity` below.
 *
 * ## The executable
 *
 * `argv[0]` is admitted in exactly three shapes:
 *
 *   * a **bare name** (`node`, `node.exe`, `git`) matching the entry's own bare name, extension and
 *     (on Windows) case aside. PATH decides which file that is, and the executor resolves it through
 *     the same search order the capability probe uses (PATH, then DSH's bundled runtime). What this
 *     leaves open is PATH itself: an earlier directory, or a writable entry in the bundled runtime,
 *     can put a different `node` in front of the intended one. That is a machine-configuration
 *     question, and it is why the honest reading of a bare-name entry is "whatever this machine
 *     currently calls `node`".
 *   * an **absolute path** that resolves (through `realpath`) to the *same file* the entry's
 *     executable resolves to, so `C:\Program Files\nodejs\node.exe` is admitted for the entry `node`
 *     only when that is the file `node` resolves to, and `E:\Temp\evil\node.exe` -- a different file
 *     that merely shares the name -- is refused with `COMMAND_EXECUTABLE_PATH_MISMATCH`.
 *   * nothing else. A **relative** path (`./node.exe`, `bin\node.exe`) is refused outright with
 *     `COMMAND_EXECUTABLE_RELATIVE_PATH`: it names a different file in every working directory, and
 *     the working directory is chosen by the offer, not by this machine.
 *
 * Names are compared case-insensitively on Windows and case-sensitively elsewhere, and the
 * extension is ignored on **both** sides, so the entry `Node.exe` and the argv `node` agree on
 * Windows but not on a POSIX machine, where those are two different files.
 */

import { basename, extname } from 'node:path';

import { bundledExecutable, hasPathSeparator, isRelativePath, resolveCommand, sameFile } from './resolve.mjs';

/**
 * Parse `--allowed-commands`.
 *
 * Accepts the JSON array form the CLI documents (`'["node --test","git status"]'`),
 * an already-parsed array of strings, or an array of arrays for entries whose
 * executable path contains spaces.  Each string entry is split on whitespace
 * into a **prefix sequence**.
 *
 * Commas are deliberately *not* a separator: `["node --test, git status"]`
 * would silently authorise something nobody meant.
 *
 * @param {string|Array<string|string[]>} input
 * @returns {string[][]} Prefixes.
 */
export function parseAllowedCommands(input) {
  let parsed = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return [];
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const err = new TypeError(
        `--allowed-commands must be a JSON array, e.g. '["node --test","git status"]' (${error.message})`,
      );
      err.code = 'ALLOWED_COMMANDS_INVALID';
      throw err;
    }
  }
  if (!Array.isArray(parsed)) {
    const err = new TypeError('allowed commands must be a JSON array');
    err.code = 'ALLOWED_COMMANDS_INVALID';
    throw err;
  }
  const prefixes = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      const parts = entry.split(/\s+/).filter((part) => part !== '');
      if (parts.length === 0) {
        const err = new TypeError('allowed command entries must not be empty');
        err.code = 'ALLOWED_COMMANDS_INVALID';
        throw err;
      }
      prefixes.push(parts);
      continue;
    }
    if (Array.isArray(entry) && entry.length > 0 && entry.every((part) => typeof part === 'string')) {
      prefixes.push([...entry]);
      continue;
    }
    const err = new TypeError('allowed command entries must be strings or arrays of strings');
    err.code = 'ALLOWED_COMMANDS_INVALID';
    throw err;
  }
  return prefixes;
}

/** Executable name without directory or extension (`C:\x\node.exe` -> `node`). */
function execName(value) {
  const base = basename(value);
  const ext = extname(base);
  return ext === '' ? base : base.slice(0, -ext.length);
}

/** Windows paths are case-insensitive; POSIX ones are not. */
function sameName(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The trailing arguments a matched prefix does **not** cover, and why each one is refused.
 *
 * Every entry here is an argument that makes its tool run code the allow-list entry never named --
 * either by loading a module or file, by taking source text directly, or by delegating to another
 * program. They are refused because the alternative is worse in a way that is invisible: the matcher
 * would say `allowed: true` for a command line whose *effect* the entry does not describe, and the
 * operator would read that as "the list covers this".
 *
 * Three honest limits, because a list like this invites more trust than it can carry:
 *
 *   * It is keyed by executable **family** ({@link EXECUTABLE_FAMILY}), so an executable nobody
 *     listed gets no argument control at all -- and listing every executable that can run another
 *     program is not a finite job (`npx`, `xargs`, `make`, `docker run`, `sh -c`, …). Those are
 *     grants of *another* program by construction; an entry naming one is a grant of it.
 *   * A tool that abbreviates its own options cannot be covered by tokens: PowerShell accepts any
 *     unambiguous prefix (`-com`, `-comm`, `-Command`), so the list is a floor for `pwsh`, not a
 *     guarantee.
 *   * It matches the arguments *as written*. Nothing here re-parses a command line, because
 *     re-parsing is the technique being refused; `--test-reporter` is caught, `--test-report`+`er`
 *     split across two arguments is not a thing a tool accepts either.
 *
 * The escape hatch is deliberate and is the point: an entry that names the argument is an explicit
 * grant, so `["node --test --test-reporter=tap"]` allows exactly that and nothing more.
 */
const REPARSING_ARGUMENTS = Object.freeze({
  node: Object.freeze([
    { token: '--test-reporter', why: 'its value is a module specifier or URL, and node imports and runs it as the test reporter' },
    { token: '--import', why: 'it loads an ES module before the program runs' },
    { token: '--require', why: 'it loads a CommonJS module before the program runs' },
    { token: '-r', why: 'it is the short spelling of --require, which loads a CommonJS module before the program runs' },
    { token: '--experimental-loader', why: 'it installs a module loader hook: code that decides what every later import resolves to' },
    { token: '--loader', why: 'it is the older spelling of --experimental-loader' },
    { token: '--eval', why: 'it runs its value as source instead of a file' },
    { token: '-e', why: 'it is the short spelling of --eval, which runs its value as source' },
    { token: '--print', why: 'it runs its value as source and prints the result' },
    { token: '-p', why: 'it is the short spelling of --print, which runs its value as source' },
    // `-c` / `--check` is deliberately absent: it parses a file without executing it.
  ]),
  python: Object.freeze([
    { token: '-c', why: 'it runs its value as Python source' },
    { token: '-m', why: 'it runs a module as __main__, imported from sys.path - which includes the working directory the offer chose' },
  ]),
  perl: Object.freeze([
    { token: '-e', why: 'it runs its value as source' },
    { token: '-E', why: 'it runs its value as source, with optional features enabled' },
    { token: '-M', why: 'it loads a module at startup, and -MModule=args calls into it' },
    { token: '-m', why: 'it loads a module at startup, as -M does' },
    { token: '-d', why: 'it runs under a debugger whose value can name a module to load (-d:Module)' },
    { token: '-S', why: 'it runs a script looked up on PATH, so PATH chooses the file that executes' },
  ]),
  ruby: Object.freeze([
    { token: '-e', why: 'it runs its value as source' },
    { token: '-r', why: 'it requires a library before the program runs' },
    { token: '-S', why: 'it runs a script looked up on PATH, so PATH chooses the file that executes' },
  ]),
  php: Object.freeze([
    { token: '-r', why: 'it runs its value as PHP source' },
    { token: '-B', why: 'it runs its value as source before the input loop' },
    { token: '-R', why: 'it runs its value as source for every input line' },
    { token: '-E', why: 'it runs its value as source after the input loop' },
    { token: '-F', why: 'it runs a file for every input line' },
    { token: '-d', why: 'it overrides any php.ini directive, including auto_prepend_file/auto_append_file, which include a file before the script runs' },
  ]),
  deno: Object.freeze([
    { token: '--import-map', why: 'it remaps module specifiers, so an import can be pointed at a different file' },
    { token: '--config', why: 'it names a config file whose imports/scopes remap module specifiers, as --import-map does' },
  ]),
  bun: Object.freeze([
    { token: '-e', why: 'it runs its value as source' },
    { token: '--eval', why: 'it is the long spelling of bun -e, which runs its value as source' },
    { token: '-r', why: 'it imports a module before the program runs' },
    { token: '--preload', why: 'it is the long spelling of bun -r, which imports a module before the program runs' },
    { token: '--require', why: 'it imports a CommonJS module before the program runs' },
  ]),
  shell: Object.freeze([
    { token: '-c', why: 'it runs its value as a command line' },
    { token: '--command', why: 'it is the long spelling of -c' },
    { token: '-Command', why: "it is PowerShell's -Command, which runs its value as a script block" },
    { token: '-EncodedCommand', why: "it is PowerShell's -EncodedCommand, which runs its base64 value as a script block" },
    { token: '--init-file', why: "it is bash's --init-file, which runs the named file instead of the usual startup file" },
    { token: '--rcfile', why: "it is bash's --rcfile, which runs the named file instead of ~/.bashrc" },
    { token: '/c', why: "it is cmd.exe's /c, which runs the rest of the command line as a command" },
    { token: '/k', why: "it is cmd.exe's /k, which runs the rest of the command line and then keeps the shell open" },
  ]),
  java: Object.freeze([
    { token: '-javaagent', why: 'it names a jar whose premain runs inside the JVM before main' },
    { token: '-agentlib', why: 'it loads a native agent library whose Agent_OnLoad runs before main' },
    { token: '-agentpath', why: 'it loads a native agent library by path, as -agentlib does' },
  ]),
  git: Object.freeze([
    { token: '-c', why: 'it sets any config for this one run: core.pager, core.sshCommand, core.editor and alias.* = !<shell command> each make git run a program the entry never named' },
    { token: '--config-env', why: 'it is -c with the value taken from an environment variable' },
    { token: '--exec-path', why: 'it moves the directory git takes its own subprograms (git-remote-*, git-upload-pack) from' },
    { token: '--upload-pack', why: 'it names the program the remote side runs to serve the pack' },
    { token: '--receive-pack', why: 'it is the push-side spelling of --upload-pack' },
  ]),
  make: Object.freeze([
    { token: '-f', why: 'it reads a different makefile, whose recipes are commands make runs' },
    { token: '--file', why: 'it is a long spelling of make -f' },
    { token: '--makefile', why: 'it is another long spelling of make -f' },
    { token: '--eval', why: 'it evaluates its value as makefile text before any makefile is read' },
  ]),
  tar: Object.freeze([
    { token: '-I', why: 'it names the compression program tar executes' },
    { token: '--use-compress-program', why: 'it is the long spelling of tar -I' },
    { token: '--to-command', why: 'it pipes every extracted member through a command of the caller\'s choosing' },
    { token: '--checkpoint-action', why: 'it runs a command at a checkpoint (--checkpoint-action=exec=...)' },
    { token: '-F', why: 'it runs its value as a script at every checkpoint' },
    { token: '--info-script', why: 'it is the long spelling of tar -F' },
  ]),
  ssh: Object.freeze([
    { token: '-o', why: 'it sets any ssh_config option for this run, including ProxyCommand and LocalCommand, which are shell commands' },
    { token: '-F', why: 'it reads an alternate config file, which can itself set ProxyCommand' },
  ]),
  scp: Object.freeze([
    { token: '-S', why: 'it names the program scp uses for the encrypted connection' },
    { token: '-o', why: 'it sets any ssh_config option for this run, including ProxyCommand, which is a shell command' },
    { token: '-F', why: 'it reads an alternate config file, which can itself set ProxyCommand' },
  ]),
  rsync: Object.freeze([
    { token: '-e', why: 'it names the remote shell rsync runs' },
    { token: '--rsh', why: 'it is the long spelling of rsync -e' },
    { token: '--rsync-path', why: 'it names the rsync program the remote side runs' },
  ]),
  find: Object.freeze([
    { token: '-exec', why: 'it runs a command for every match' },
    { token: '-execdir', why: "it runs a command in each match's own directory" },
    { token: '-ok', why: 'it runs a command for every match, asking first' },
    { token: '-okdir', why: "it runs a command in each match's own directory, asking first" },
  ]),
  env: Object.freeze([
    { token: '-S', why: 'it splits its value into a new command line, so the arguments this matcher just read would be re-parsed by env' },
    { token: '--split-string', why: 'it is the long spelling of env -S' },
  ]),
});

/**
 * Which argument list applies to an executable name.
 *
 * Family names, not exact names: `python3.12` and `python` must land on one list, and so must
 * `node.exe` and `node`. The trailing-version strip is how `python3.12`/`perl5`/`node20` are
 * recognised without enumerating every release ever installed.
 */
const EXECUTABLE_FAMILY = Object.freeze({
  node: 'node', nodejs: 'node',
  python: 'python', pythonw: 'python', py: 'python',
  perl: 'perl',
  ruby: 'ruby',
  php: 'php',
  deno: 'deno',
  bun: 'bun',
  sh: 'shell', bash: 'shell', dash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell',
  pwsh: 'shell', powershell: 'shell', cmd: 'shell',
  java: 'java', javaw: 'java',
  git: 'git',
  make: 'make',
  tar: 'tar',
  ssh: 'ssh', sftp: 'ssh',
  scp: 'scp',
  rsync: 'rsync',
  find: 'find',
  env: 'env',
});

/**
 * The deny-list entries that apply to `executable`, or `[]` when its family is not covered.
 *
 * @param {string} executable
 * @returns {ReadonlyArray<{token: string, why: string}>}
 */
function reparsingArgumentsFor(executable) {
  const name = execName(String(executable)).toLowerCase();
  const versionless = name.replace(/[0-9.]+$/, '');
  for (const candidate of [name, versionless]) {
    if (candidate !== '' && Object.hasOwn(EXECUTABLE_FAMILY, candidate)) {
      return REPARSING_ARGUMENTS[EXECUTABLE_FAMILY[candidate]] ?? [];
    }
  }
  return [];
}

/**
 * Does one trailing argument name a denied token?
 *
 * Three shapes, because tools accept three:
 *
 *   * **exact** (`-e`, `--import`), and -- for tokens that take a value -- the value attached with
 *     `=` or `:` (`--import=file:///x`, `--test-reporter=spec`, `-javaagent:C:\evil.jar`) or written
 *     straight after a single-letter token;
 *   * a **bundle** of short options, where a denied single letter is one of them: `node -pe '…'` is
 *     `--print --eval`, `python -uc '…'` is `-u -c`, `bash -lc '…'` is `-l -c`. Only single-letter
 *     tokens take part, which is the conservative direction -- `find . -name x` must not read as
 *     `-n -a -m -e`;
 *   * the `/c` and `/k` forms cmd.exe uses, exact only.
 *
 * Comparison is case-insensitive: the family lists are small, the flags they name are the ones that
 * load code, and refusing `-C` for `python` (a different spelling of the same thing on the platform
 * where the entry was probably written) is the direction that keeps the two ends agreeing.
 *
 * @param {string} argument
 * @param {ReadonlyArray<{token: string, why: string}>} denied
 * @returns {{token: string, why: string, argument: string}|null}
 */
function deniedArgument(argument, denied) {
  const token = String(argument);
  const lower = token.toLowerCase();
  // The *given* token decides which shapes are possible. Without this, `...\not-a-test-name.mjs`
  // would be read as a bundle of short options and refused for containing an `e`.
  const isLong = lower.startsWith('--');
  const isShort = !isLong && lower.startsWith('-') && lower.length > 1;
  const isSlash = lower.startsWith('/') && lower.length > 1;
  for (const entry of denied) {
    const deniedToken = entry.token.toLowerCase();
    if (deniedToken.startsWith('--')) {
      if (!isLong) continue;
      if (lower === deniedToken || lower.startsWith(`${deniedToken}=`) || lower.startsWith(`${deniedToken}:`)) {
        return { ...entry, argument: token };
      }
      continue;
    }
    if (deniedToken.startsWith('/')) {
      // cmd.exe's `/c` and `/k`: exact, or with the command attached (`cmd /cecho hi`).
      if (isSlash && (lower === deniedToken || lower.startsWith(deniedToken))) {
        return { ...entry, argument: token };
      }
      continue;
    }
    if (!isShort) continue;
    // Exact, or with the value attached (`-javaagent:C:\evil.jar`, `-MModule=args`).
    if (lower.startsWith(deniedToken)) return { ...entry, argument: token };
    const flag = deniedToken.slice(1);
    if (flag.length === 1 && token.length > 2 && lower.slice(1).includes(flag)) {
      return { ...entry, argument: token };
    }
  }
  return null;
}

/**
 * The stable codes this matcher refuses with.
 *
 * `COMMAND_NOT_ALLOWED` is deliberately the **same literal** the agent writes into a result
 * envelope's `refusal_reason` (`REFUSAL.COMMAND_NOT_ALLOWED` in `src/agent/agent.mjs`) and the same
 * one the plugin's dispatch pre-flight reports: the whole reason this matcher is shared is that the
 * two ends must not be able to disagree about *why* a command was refused, and two spellings of one
 * refusal would be a disagreement of exactly that kind. The three codes below it travel the same
 * way -- the agent writes whichever code the matcher returned into its envelope, and the plugin puts
 * the same one in its refusal value -- so a refusal code has exactly one definition, here.
 *
 * `COMMAND_ARGV_EMPTY` is the matcher's own precondition: no argv at all, or an argv carrying an
 * entry that is not a string. It is a separate code because it is a separate fault -- a caller that
 * passed something incomparable has a bug, not a policy problem -- and collapsing it into
 * `COMMAND_NOT_ALLOWED` would send the reader to the allow-list to fix a caller. (A non-string entry
 * used to reach `path.basename` and throw out of this function; the agent's catch-all turned that
 * into a `crashed` envelope, which is a lot of noise for a caller bug and no refusal at all.)
 *
 * The three v0.5.10 codes are separate for the same reason, one remedy each:
 *
 *   * `COMMAND_REPARSING_ARGUMENT` -- the entry matched, and one of its *trailing* arguments is on
 *     {@link REPARSING_ARGUMENTS}. The remedy is to name that argument in the entry (or drop it).
 *   * `COMMAND_EXECUTABLE_PATH_MISMATCH` -- `argv[0]` is a path, and it is not the file the entry's
 *     executable resolves to. The remedy is the other path, or a bare name.
 *   * `COMMAND_EXECUTABLE_RELATIVE_PATH` -- `argv[0]` is a relative path, whose meaning is chosen by
 *     the offer's working directory. The remedy is a bare name or an absolute path.
 */
export const MATCH_REFUSAL = Object.freeze({
  ARGV_EMPTY: 'COMMAND_ARGV_EMPTY',
  NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  REPARSING_ARGUMENT: 'COMMAND_REPARSING_ARGUMENT',
  EXECUTABLE_PATH_MISMATCH: 'COMMAND_EXECUTABLE_PATH_MISMATCH',
  EXECUTABLE_RELATIVE_PATH: 'COMMAND_EXECUTABLE_RELATIVE_PATH',
});

/**
 * Why this argv is not covered by this list, and what would change it.
 *
 * The entries are echoed because they are the *only* thing that would make the same call succeed,
 * and a caller reading this deserves them without a second call. They are configuration, never
 * credentials: the parse path refuses a secret-looking key before a list ever reaches here.
 *
 * @param {string[]} argv
 * @param {string[][]} prefixes
 * @returns {string}
 */
function allowListMissDetail(argv, prefixes) {
  if (prefixes.length === 0) {
    return (
      'the configured allow-list is empty, so every command is refused; add an entry naming what ' +
      `this machine may run - an entry of \`${argv[0]}\` would allow \`${argv.join(' ')}\``
    );
  }
  const entries = prefixes.map((prefix) => prefix.join(' ')).join(', ');
  return (
    `no configured entry is a prefix of this argv; the allow-list entries are ${entries}. Add one ` +
    `that covers \`${argv.join(' ')}\`, or run a command the list already covers`
  );
}

/**
 * Can `argv[0]` be the executable this entry names?
 *
 * The three admissible shapes are described in the file header. The comparison is on the **file**,
 * never on the spelling: `realpath` equality for paths (through {@link sameFile}), and name equality
 * for bare names, where PATH is what turns a name into a file.
 *
 * @param {string} argv0
 * @param {string} prefix0
 * @param {object} options Forwarded to `resolveCommand` (`env`, `extraDirs`).
 * @returns {{kind: 'match'|'no-match'|'path-mismatch', detail: string|null}}
 */
function executableIdentity(argv0, prefix0, options) {
  const argvIsPath = hasPathSeparator(argv0);
  const prefixIsPath = hasPathSeparator(prefix0);

  // Both bare names: the name decides, and PATH decides which file the name means. This is the
  // behaviour every existing configuration was written against, and it is the shape the header
  // calls out as trusting PATH.
  if (!argvIsPath && !prefixIsPath) {
    return sameName(execName(argv0), execName(prefix0))
      ? { kind: 'match', detail: null }
      : { kind: 'no-match', detail: null };
  }

  // One side is a path, so a file has to be identified: the entry's executable is resolved the same
  // way the executor resolves it (PATH, then DSH's bundled runtime), and argv[0] -- a path the
  // caller wrote -- is compared to it by realpath.
  const resolvedPrefix = prefixIsPath ? prefix0 : resolveCommand(prefix0, options);
  if (!prefixIsPath && !hasPathSeparator(resolvedPrefix)) {
    return {
      kind: 'path-mismatch',
      detail:
        `\`${argv0}\` is a path, but the entry's executable \`${prefix0}\` could not be found on ` +
        'this machine\'s PATH (or in DSH\'s bundled runtime), so there is no file for a path to be ' +
        `the same as; install it, or use the bare name \`${prefix0}\``,
    };
  }

  const resolvedArgv = argvIsPath ? argv0 : resolveCommand(argv0, options);
  if (!argvIsPath && !hasPathSeparator(resolvedArgv)) {
    // A bare argv[0] against a path entry, and the bare name resolves to nothing: that is an
    // ordinary "the entry does not cover this name" miss, not a claim about a file.
    return { kind: 'no-match', detail: null };
  }
  if (sameFile(resolvedArgv, resolvedPrefix)) return { kind: 'match', detail: null };

  /**
   * Second identity path, and the one that matters on a machine where the bundled tree is not on PATH.
   *
   * A bare entry names a tool; **the bundled copy of that tool is that tool**, whether or not PATH happens to
   * point at it. This is what admits `process.execPath` for the entry `node` without weakening anything: it
   * **only ever** returns a file under `<deps>`, so `E:\Temp\evil\node.exe` is still refused, and it does not
   * touch the search order, so `keeps PATH ahead of the bundled runtime` still holds.
   *
   * It also fixes a real case rather than a test-only one: **DSH runs on the bundled interpreter and does not
   * put its directory on PATH**, so an allow-list entry of `node` could not be satisfied by the very interpreter
   * the host executes.
   */
  if (!prefixIsPath && argvIsPath) {
    const bundled = bundledExecutable(prefix0, options.env ?? process.env);
    if (bundled !== null && sameFile(argv0, bundled)) return { kind: 'match', detail: null };
  }

  return {
    kind: 'path-mismatch',
    detail:
      `\`${argv0}\` is a path, and it is not the executable this entry names: \`${prefix0}\` resolves ` +
      `to \`${resolvedPrefix}\`, a different file. An absolute path is admitted only when it *is* the ` +
      `file the entry's executable resolves to, because a copy of a program under an allowed name is ` +
      `a different program; use \`${resolvedPrefix}\`, or the bare name \`${execName(prefix0)}\``,
  };
}

/**
 * The first trailing argument that makes this match mean more than the entry says, or `null`.
 *
 * Only arguments **after** the matched prefix are examined: an entry that names a code-loading
 * argument is the operator's explicit grant (`["python -m pytest"]` runs pytest), and re-refusing it
 * here would make such an entry unusable rather than safer.
 *
 * @param {string[]} argv
 * @param {string[]} prefix
 * @returns {{token: string, why: string, argument: string}|null}
 */
function trailingReparsingArgument(argv, prefix) {
  const denied = reparsingArgumentsFor(prefix[0]);
  if (denied.length === 0) return null;
  for (let i = prefix.length; i < argv.length; i += 1) {
    const hit = deniedArgument(argv[i], denied);
    if (hit) return hit;
  }
  return null;
}

/**
 * Why this trailing argument was refused, in terms of the entry that let the command this far.
 *
 * @param {{token: string, why: string, argument: string}} hit
 * @param {string[]} prefix
 * @returns {string}
 */
function reparsingDetail(hit, prefix) {
  const entry = prefix.join(' ');
  return (
    `\`${hit.argument}\` is a trailing argument of the entry \`${entry}\`, and it is refused because ` +
    `${hit.why}. A prefix entry grants the command, not the arguments after it, so this control ` +
    `cannot tell \`${hit.argument}\` from the one that loads someone else's code. Name the argument ` +
    `in an entry of its own if this machine is meant to run it (for example \`${entry} ${hit.token}=...\`), ` +
    'or run the command without it'
  );
}

/**
 * Default-deny prefix match, executable identity check, and trailing-argument deny-list.
 *
 * `['node','--test']` is allowed by the prefix `node --test`, and so is
 * `['node','--test','--test-name-pattern=x']`; `['node','-e','...']`, a bare `['node']`,
 * `['node','--test','--test-reporter=file:///evil.mjs']` and a copy of some other program at
 * `E:\Temp\evil\node.exe` are all refused.
 *
 * A refusal is a **named** one: `reason_code` is a stable, greppable code (see
 * {@link MATCH_REFUSAL}) and `detail` says what would change it. `allowed` and `prefix` keep the
 * shape this function has always returned, because both callers read exactly those two fields and
 * the codes are additive.
 *
 * @param {string[]} argv
 * @param {string[][]} prefixes
 * @param {object} [options] `env`/`extraDirs` for executable resolution (defaults: this process).
 * @returns {{allowed: boolean, prefix: string[]|null, reason_code: string|null, detail: string|null}}
 */
export function matchAllowedCommand(argv, prefixes, options = {}) {
  const entries = Array.isArray(prefixes) ? prefixes : [];
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      allowed: false,
      prefix: null,
      reason_code: MATCH_REFUSAL.ARGV_EMPTY,
      detail:
        'there is no argv to compare, and this matcher is default-deny; pass a non-empty array of ' +
        'strings whose first element is the executable',
    };
  }
  for (const part of argv) {
    if (typeof part !== 'string') {
      return {
        allowed: false,
        prefix: null,
        reason_code: MATCH_REFUSAL.ARGV_EMPTY,
        detail:
          'every argv entry must be a string; a non-string entry cannot be compared without ' +
          'coercing it, and coercion is a re-parse',
      };
    }
  }

  // A relative executable is refused before any entry is consulted, because no entry can pin it:
  // `./node.exe` is a different file in every working directory, and the working directory comes
  // from the offer.
  if (isRelativePath(argv[0])) {
    return {
      allowed: false,
      prefix: null,
      reason_code: MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH,
      detail:
        `\`${argv[0]}\` is a relative path, and the working directory it would be resolved against ` +
        'is chosen by the offer, not by this machine - so this names a different file in every ' +
        'directory and the allow-list cannot say which program would run. Use the bare command name ' +
        `(\`${execName(argv[0])}\`) or an absolute path to the executable the entry names`,
    };
  }

  /** The first refused trailing argument, kept while other entries are still tried on their merits. */
  let reparsing = null;
  /** The first path-identity mismatch, reported only if no entry matches at all. */
  let mismatch = null;

  for (const prefix of entries) {
    if (!Array.isArray(prefix) || prefix.length === 0) continue;
    if (argv.length < prefix.length) continue;
    const identity = executableIdentity(argv[0], prefix[0], options);
    if (identity.kind === 'no-match') continue;
    if (identity.kind === 'path-mismatch') {
      if (mismatch === null) mismatch = identity.detail;
      continue;
    }
    let ok = true;
    for (let i = 1; i < prefix.length; i += 1) {
      if (argv[i] !== prefix[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // The prefix matched. A trailing argument on the deny-list is *not* an immediate refusal: an
    // entry may name it explicitly, and entries are tried in the order they were configured, so
    // `["node --test","node --test --test-reporter=tap"]` must still admit the second one.
    const hit = trailingReparsingArgument(argv, prefix);
    if (hit) {
      if (reparsing === null) reparsing = { hit, prefix };
      continue;
    }
    return { allowed: true, prefix, reason_code: null, detail: null };
  }

  if (reparsing !== null) {
    return {
      allowed: false,
      prefix: null,
      reason_code: MATCH_REFUSAL.REPARSING_ARGUMENT,
      detail: reparsingDetail(reparsing.hit, reparsing.prefix),
    };
  }
  if (mismatch !== null) {
    return {
      allowed: false,
      prefix: null,
      reason_code: MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH,
      detail: mismatch,
    };
  }
  return {
    allowed: false,
    prefix: null,
    reason_code: MATCH_REFUSAL.NOT_ALLOWED,
    detail: allowListMissDetail(argv, entries.filter((prefix) => Array.isArray(prefix) && prefix.length > 0)),
  };
}
