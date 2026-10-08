# UI cards: what the contract actually is, and why nothing was added

Status: **settled.** No new card types were introduced, because the shipped runtime has no card
registry to choose from. This file records the evidence so the question is not re-opened from memory.

## The question that was open

"UI cards" was listed as a v0.3.3 item, implying the eight W2M tools should render as something richer
than they do. All eight return `card: 'generic'`. That looks like a placeholder awaiting real card
types, and it sat open for several rounds for that reason.

## What the runtime does

`defineTool` treats the return value as **opaque**. From the shipped
`@deepseek-ai/dsh-tools/lib/index.js`:

```js
if (userPresentCall) tool.presentCall = (args) => {
  if (validate(args).length > 0) return void 0;
  return userPresentCall(args);
};
```

That is the entire handling. The object is forwarded unvalidated — not `card`, not `title`, not
`kind`, not `rawInput`. Two consequences:

1. **There is no list of card types to pick from.** Nothing in the shipped bundle reads `card`, so
   there is no vocabulary to be wrong about and none to expand into.
2. **A wrong field cannot be caught by the runtime.** If a card value were invalid, it would fail
   silently in the UI rather than at the boundary — which is why guessing richer cards was the wrong
   move, and why this file exists instead.

## The only two reference implementations

These are the sole evidence for what the fields mean, and they agree on `card`:

| where | card | kind | rawInput |
|---|---|---|---|
| `dsh-tools/lib/index.js:1445` — built-in `run_code` | `"generic"` | `"execute"` | `args.code` (a **string**) |
| `dsh-plugin-manager/lib/types/tools.js:85` — the plugin manager | `'generic'` | `args.action.startsWith('list_') ? 'read' : 'other'` | `args` |

Both use `generic`. `kind` varies by action: the plugin manager reports `read` for its listing actions
and `other` for the ones that change something. `rawInput` is not necessarily an object.

## The decision

Keep `card: 'generic'` everywhere — it is the only value with a reference implementation — and make
`kind` **truthful**, since that is the one field whose meaning is demonstrated by example and the one a
user actually reads. Concretely:

| tool | before | after | why |
|---|---|---|---|
| `w2m_devices`, `w2m_wait`, `w2m_report`, `w2m_status`, `w2m_history`, `w2m_stats` | `read` | `read` | accurate; unchanged |
| `w2m_run` with `write: true` | `write` | `write` | kept: it executes on other machines, which `read` would understate |
| `w2m_run` without `write` | `read` | `read` | unchanged |
| **`w2m_update`, `action: 'check'`** | **`read`** | **`other`** | **the defect: this action can install a new version into the profile it runs in** |
| `w2m_update`, `action: 'status'` | `read` | `read` | accurate; it only reports |

`w2m_update` reporting `read` for a check-and-install cycle was a false claim about safety in exactly
the place a user looks to judge safety — the same class of defect as the `intervalDays` option that
silently did nothing, and worth fixing for the same reason: a hint that lies is worse than no hint.

## What was not done, and why

- **No new card types.** None exist to use.
- **`presentResult` was not adopted either.** It is a second, equally unvalidated hook
  (`dsh-tools/lib/index.js:878`) whose result-side contract appears nowhere in the shipped bundle.
  Adopting it would be the same guess this file declines to make.

To go further, the missing input is a **consumer**: the Web UI code that switches on `card`. It was not
in the extracted bundle (`dsh-tools`, `dsh-plugin-manager`), and finding it would mean extracting
further packages from the 121 MB `app.asar`. That is not worth doing for a cosmetic hint while a
correct and verified one is already in place.

## Verification

`test/tool-cards.test.mjs` — five tests covering: every tool yields a `generic` card with a non-empty
title and a `kind`; the check-and-install action is `other` while `status` and the default are `read`;
a write-capable run stays distinguishable from a read-only one; **no credential reaches `rawInput`**,
which matters because that field is rendered; and every `presentCall` survives being called with no
arguments, which is what the runtime does on a schema-invalid call.
