# Platforms: the same fleet from Claude Code, Codex, OpenAI's plugin directory and anything else that speaks MCP

One MCP server, `bin/w2m-mcp.mjs`, published in the npm package and exposed three ways. **Nothing in this document
invents a second implementation per platform** -- a platform is adapted to by shipping a manifest, not by forking the
server.

## What is exposed, and why it is read-only

The server answers both MCP protocol eras in the wild: the modern revision (per-request `_meta`, no handshake) and the
legacy one (`initialize` -> `notifications/initialized` -> requests) that most deployed clients still speak.

**`w2m_run` is deliberately absent.** A process that can start an MCP server would otherwise be handed fleet execution
rights. The exposed tools read state and cannot change it; each one is a thin wrapper over an endpoint the plugin
already calls.

## Claude Code

Two routes, both from this repository:

**As a plugin marketplace** -- which is what `.claude-plugin/marketplace.json` is for:

    /plugin marketplace add TwinsEarth/dsh-windows2macos
    /plugin install w2m-fleet@twinsearth-w2m

The plugin manifest is `.claude-plugin/plugin.json`; its `mcpServers` entry resolves through `${CLAUDE_PLUGIN_ROOT}`,
which Claude Code substitutes with the installed plugin directory. **That variable is why the manifest carries its own
server entry instead of pointing at the top-level `mcp.json`** -- the top-level file uses the agent-plugins schema's
`${PLUGIN_ROOT}`, and a client that does not know that schema would receive the literal string.

**As a project-scoped server** -- add to the project's `.mcp.json`:

    { "mcpServers": { "w2m-fleet": { "command": "node",
        "args": ["<path-to-package>/bin/w2m-mcp.mjs"] } } }

## Codex (OpenAI)

Codex reads MCP servers from `~/.codex/config.toml`. The block to append is kept as a reviewable, testable file rather
than prose: [`codex/mcp-servers.toml`](../codex/mcp-servers.toml).

It invokes the published package through `npx`, so the same block works on Windows, macOS and Linux with no install
step, and the version is pinned exactly.

## OpenAI's plugin directory (`openai/plugins`, `openai/mcp-extensions`)

This one is **not** a filesystem layout to conform to. `openai/plugins` is a Codex-oriented example library
distributed through an official submission portal, and `openai/mcp-extensions` is a directory of extension
descriptors. Our side of that transaction is the npm package plus the manifests in this repository; the submission
itself is a form or a pull request against a repository **we do not own**.

**Status: prepared, not submitted.** See "What still needs a person" below.

## Anthropic's Claude Code marketplaces

`anthropics/claude-plugins-official`, `anthropics/claude-plugins-community` and `anthropics/claude-code` are the
upstream repositories. A listing there is a pull request against a third-party repository.

**Status: prepared, not submitted.** The manifests they would review are already in this repository and validated by
`test/portable-plugins.test.mjs`.

## Anything else (Cursor, Windsurf, a script of your own)

Any client that accepts a generic MCP server list can use the `mcp.json` this package already ships, or the same
`command`/`args` pair from the Claude Code section.

## What still needs a person

Publishing to the three third-party destinations above requires write access to repositories this project does not
own. The token used for release automation is scoped to `TwinsEarth/dsh-windows2macos`; acting on a third-party
repository with it is refused by design, and that refusal is correct.

So the split is:

| Step | Who | State |
|---|---|---|
| npm publish, GitHub release, SHA256SUMS | automation | **done** (see the release page) |
| Claude Code marketplace manifests | this repository | **shipped and tested** |
| Codex configuration snippet | this repository | **shipped and tested** |
| Adding the repo as a Claude Code marketplace | any operator | one command, above |
| PR to `anthropics/claude-plugins-official` / `-community` / `claude-code` | a person with access | **not done** |
| Submission to OpenAI's portal | a person with the account | **not done** |

Marking the last two rows "prepared" rather than "done" is deliberate: a manifest that exists is not a listing, and
this project has already shipped a "mechanism with no caller" seven times.
