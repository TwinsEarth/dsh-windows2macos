---
name: session-ref
description: Use when a session must be named across tools, when a w2m tool takes a session_id, when constructing or parsing a dsh-session: URI, or when the error "invalid session reference URI" appears. Covers the canonical encoding, the three checks a URI must pass, and which per-session state the W2M plugin keys by session id.
---

# Session references

Several things in this system are **per session**, and naming a session is where they break when a caller
guesses at the format.

## The canonical URI is not the session id with a prefix

`dsh-session:` carries a **base64url-encoded JSON string**, not the raw id:

```
dsh-session: + base64url(JSON.stringify(sessionId))
```

**A DSH session id is a UUID** (36 characters), so the encoded form is its JSON string quoted and re-encoded —
**it looks nothing like the id.** Writing `dsh-session:` + the raw UUID produces a URI that fails decoding.

To build one, call `formatSessionReferenceMention({ sessionId, label })` from
`@deepseek-ai/dsh-session-reference`. **Never concatenate the scheme by hand.**

## Three checks, and the error names none of them

`decodeSessionReferenceUri` rejects a URI that fails any of:

1. it does not start with `dsh-session:`;
2. the payload is not `/^[A-Za-z0-9_-]+$/`;
3. the payload does not decode to a **JSON string**, or **re-encoding it does not reproduce the URI
   byte-for-byte**.

All three throw the same `invalid session reference URI "<uri>"` with code
`SESSION_REFERENCE_INVALID_REFERENCE`. **The message names the URI and never the check**, so diagnose by
re-encoding: take the decoded value, encode it again, and compare.

**Check 3 is the one that surprises people.** It requires the *canonical* encoding, not merely a decodable
one — base64url has several spellings for the same bytes, and a non-canonical one is refused even though it
decodes correctly.

## Bare URIs are extracted too, and that is a real trap

The text pattern matches two forms:

```
@[label](dsh-session:payload)      an explicit Markdown mention -- fails on ANY malformed URI
dsh-session:payload                a bare URI -- taken as a reference when the payload is base64url-shaped
```

**So a `dsh-session:`-looking string inside ordinary prose is parsed as a reference**, and in an explicit
mention a malformed URI is a hard failure rather than a fallback to text. **If you are quoting a URI —
in a changelog, a bug report, an example — quote it in a fenced code block or break the scheme**, or a parser
downstream will try to resolve it.

## Per-session state in this plugin

`w2m_run` accepts an optional `session_id`, and the fleet-target store keys the session's chosen machine by it:

- **The bucket is the session id**, so one chat's target cannot silently steer another chat's dispatch.
- **A dispatch with no session in reach falls back to a single `(no-session)` bucket** rather than throwing —
  so a bare `execute()` in a test and a future non-session caller share one bucket instead of two.
- `session_id` is capped at **200** characters, which exists to bound the number of buckets, not the bytes.
  A DSH session id is 36 characters, so the cap is room to spare rather than a limit you should approach.

**Pass the id you actually hold.** A fabricated id creates a bucket nothing else will ever read, which looks
like a target that silently fails to apply.

## Diagnosing an invalid-reference error

1. **Find where the URI was built.** If it was `'dsh-session:' + id`, that is the bug — build it with the
   codec instead.
2. **Re-encode and compare.** Decode the payload, `JSON.stringify` it, `base64url` it, and compare to the
   original. A difference means check 3.
3. **Look for prose.** A URI quoted in a message body is extracted as a bare reference, so the failure may be
   nowhere near the code that handles sessions.
