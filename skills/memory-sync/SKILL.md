---
name: memory-sync
description: Use when writing or reading a block through w2m_memory, when a field was omitted rather than nulled, when a block names an ancestor the caller cannot produce, or when deciding whether a fact belongs in durable memory at all. Covers the seven CAT7 fields by their real names, the per-field cost a receiver pays, the one field no authority can accept, and why a refused ancestor is never re-rooted.
---

# Memory sync

`w2m_memory` stores blocks that carry **provenance**, and it decides field by field what each reader may see.
The tool is small; the rules are the part that matters.

## The seven fields, by their real names

```
CAT7_FIELDS = [origin, subject, body, evidence, confidence, observed_at, lineage]
```

**The order is part of the hash**, so a block is not a bag of fields — it is a canonical serialization.
`blockHash` covers all seven, which is why tampering with any one of them fails `verifyBlock` with
`BLOCK_HASH_MISMATCH`.

They split into exactly two groups, and the split is the reason a receiver cannot rewrite provenance:

| Group | Fields | Why |
|---|---|---|
| **inherited** | `origin`, `observed_at`, `lineage` | where it came from and when it was seen — **never offered to a receiver's chooser** |
| **receiver-choosable** | `subject`, `body`, `evidence`, `confidence` | what the receiver decides to keep |

**The two lists partition the seven**, so neither can grow without the other shrinking.

### Names that are NOT part of this implementation

A description circulating elsewhere names the seven as *focus, issue, intent, motivation, commitment,
perspective, mood*, and refers to **`SVAF`** and **`remix`**. **None of those names exist here.** Measured:
`SVAF` and `remix` occur **zero** times in the source. The mechanisms have different names:

| Described elsewhere | What this implementation actually has |
|---|---|
| the seven-field cognitive model | `CAT7_FIELDS`, as listed above |
| `SVAF`, per-receiver role anchoring | `RECEIVER_CHOOSABLE_FIELDS` + `acceptField(field, actor)` |
| lineage by content-hash parent | `lineage` + `blockHash` + `ancestry` + `isDescendantOf` |
| `remix` storing only the receiver's own evaluation | `INHERITED_FIELDS` and `defaultChoose` |

**Writing the other names produces `BLOCK_UNKNOWN_FIELD` or `FIELD_NOT_A_FIELD`**, so a block built from that
description is refused at the wire rather than silently misread.

## Cost is per field, and one field is not a threshold

```js
FIELD_LEVELS = { subject: 0, body: 0, evidence: 50 }
NEVER_ACCEPTED = { confidence: "a receiver does not adopt the sender's certainty (invariant, not a default)" }
```

**`evidence` costs 50** — the bottom of the `captain` band, which is why the number is what it is. Level 49 is
refused with `FIELD_BELOW_AUTHORITY` and `required: 50`; level 50 is allowed.

**`confidence` is refused at every level, including 90 and above**, with `FIELD_ALWAYS_REFUSED` and
`required: null`. **The reason string says "invariant" on purpose: a reader who thinks it is a threshold will
try to raise it.** There is no level that satisfies it.

`origin`, `observed_at` and `lineage` answer `FIELD_UNDECLARED` to `acceptField` — **which does not mean
"forbidden".** They have no rule because **a receiver does not choose them**, and `acceptWithAuthority` still
returns them in `accepted`. **Reading `UNDECLARED` as a refusal would drop the ancestry that makes the block
meaningful.**

## Acceptance is per field, and omission is not null

When an actor's authority cannot cover a field, **the field is absent from what they receive — it is not
present-with-`null`, and it is not an error.**

```
level 0   accepted = [origin, observed_at, lineage, subject, body]   refused = [evidence, confidence]
level 50  accepted = [origin, observed_at, lineage, subject, body, evidence]   refused = [confidence]
```

**Test for the key, not for a falsy value.** `if (!block.evidence)` cannot tell "omitted" from "empty", and
those mean different things: one is a permission decision, the other is content.

`acceptBlock` returns a **partition**, not a filtered copy — *"the refused half is evidence: 'this machine
declined the confidence and kept the body' is a decision worth being able to inspect, and a filtered object
silently loses it."*

**Never reconstruct a refused field.** If you need it, the answer is a higher-authority actor or a different
block, not a guess.

## A block cannot name an ancestor its caller cannot produce

`acceptBlock(block, { lineage })` refuses a block whose `lineage` names an ancestor outside the set the
receiver can produce:

```
{ accepted: null, refused: [{ field: 'lineage', why: 'BLOCK_MISSING_PARENT: cannot produce ancestor(s) …;
  refusing rather than re-rooting' }], accepted_fields: [], verified: true }
```

**`verified: true` — the block itself is well formed; the ancestry is what is absent.** And it is refused
rather than re-rooted, for the reason the source states:

> Re-rooting — keeping the block and emptying its lineage — turns a claim with an unverifiable history into one
> with **no history**, which reads as a fresh, independent assertion. **That is precisely how a fabricated
> claim acquires respectability.**

**`ancestry` answers a different question and does not fail.** It takes a `Map<hash, block>` and returns
`{chain, missing, cycle, depth}` — **there is no `ok` and no `code`.** Gaps are **collected** in `missing`
because *"knowing how much of a history is absent is more useful than knowing that some of it is."*

**`isDescendantOf` returns `{descendant, chain, missing, checked}` — not a boolean.** It returns more than a
boolean on purpose: *"a claim that descends from something this machine already thought is an **echo**, not
corroboration, and a fleet that cannot tell those apart will confidently agree with itself."*

**You cannot construct a cycle.** `blockHash` covers `lineage`, so rebuilding a block changes its hash and the
edge no longer closes — a real cycle would need a hash preimage. `BLOCK_CYCLE` guards a `have` map whose keys
disagree with the blocks under them: **a corrupted or hostile store, where terminating is the point.**

## Writing: say what you can prove

- **Name the ancestor only if you hold it.** A parent you cannot produce fails the whole block.
- **Put the load-bearing fact in the cheapest field that can carry it.** A fact in `evidence` is invisible
  below level 50, so a block whose meaning lives in `evidence` means nothing to most readers.
- **Never write `confidence` expecting it to travel.** It is refused by every receiver by construction.
- **One block, one claim.** Ancestry is how blocks relate; packing two claims into one block makes each
  unreadable to whoever may see only one of them.
- **Expect omission to be silent.** Nothing in the result says "a field was hidden from you" beyond the field
  being absent, so a reader who needs a field must check for it.

## Before you write

1. What is the **cheapest field** that can carry this fact?
2. Do you **hold the parent** you are about to name?
3. Who needs to read this, and **what band do they hold**? `ordinary` is 0–49, `captain` 50–69, `org_admin`
   70–89, `system_admin` 90+. If the answer is "everyone", the fact does not belong in `evidence`.
