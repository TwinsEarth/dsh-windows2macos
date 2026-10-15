---
name: memory-sync
description: Use when writing or reading a block through w2m_memory, when a field was omitted rather than nulled, when a block names an ancestor the caller cannot produce, or when deciding whether a fact belongs in durable memory at all. Covers field-level acceptance, the per-actor cost of each field, and the refusal codes that mean "kept, but not for you".
---

# Memory sync

`w2m_memory` stores blocks that carry **provenance**, and it decides field by field what each reader may see.
The tool is small; the rules are the part that matters.

## Acceptance is per field, and omission is not null

A block is a set of named fields. When an actor's authority cannot cover a field, **the field is absent from
what they receive — it is not present-with-`null`, and it is not an error.**

```
accepted = [subject, body]      refused = [evidence]
hasOwnProperty('evidence') === false
```

**Test for the key, not for a falsy value.** `if (!block.evidence)` cannot tell "omitted" from "empty", and
those mean different things: one is a permission decision, the other is content.

**Never reconstruct a refused field.** If you need it, the answer is a higher-authority actor or a different
block, not a guess.

## A block cannot name an ancestor its caller cannot produce

Providing a block whose `parent` is not in the caller's own reachable set is refused as `BLOCK_MISSING_PARENT`,
and **the block is rejected rather than re-rooted.**

**This is deliberate.** Silently re-rooting would make the ancestry claim unfalsifiable — every block would
"fit" somewhere, and the chain would stop carrying information. When you hit this refusal, supply the missing
ancestor or drop the claim; do not look for a flag that relaxes it.

## Cost is a property of the field, not of the request

Authority bands, and what they reach:

| Band | Range | Reaches |
|---|---|---|
| `ordinary` | 0–49 | the low-cost fields |
| `captain` | 50–69 | more, including some evidence |
| `org_admin` | 70–89 | `evidence` and above |
| `system_admin` | 90+ | everything |

**A field's cost is declared where the field is declared**, and the acceptance decision is made against the
actor's level at write and at read. So the same block read by two actors is two different objects, and that is
the feature rather than a leak.

Do not design a workflow that depends on a high-authority actor being present to make a low-authority read
work. **Model the read you actually need.**

## Writing: say what you can prove

- **Name the ancestor only if you hold it.** A parent you cannot produce fails the whole block.
- **Put the load-bearing fact in the cheapest field that can carry it.** A fact in `evidence` is invisible to
  everyone below `org_admin`, so a block whose meaning lives in `evidence` means nothing to most readers.
- **One block, one claim.** Ancestry is how blocks relate; packing two claims into one block makes each
  unreadable to whoever may see only one of them.
- **Expect omission to be silent.** Nothing in the result says "a field was hidden from you" beyond the field
  being absent, so a reader who needs a field must check for it.

## Before you write

1. What is the **cheapest field** that can carry this fact?
2. Do you **hold the parent** you are about to name?
3. Who needs to read this, and **what band do they hold**? If the answer is "everyone", the fact does not
   belong in a costly field.
