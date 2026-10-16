/**
 * The shape report for a message the bridge cannot read (v0.58.0).
 *
 * ## Why this is a probe and not an image branch
 *
 * `ITEM_TYPE` declares exactly one member, `TEXT: 1`. **The shape of every other item type is unrecorded in this
 * repository** -- no `image_item`, no sample payload, no fixture, and the protocol file's own comment shows only
 * the text form. A download path written today would be a guess about field names, and **it would fail at the
 * moment a real photograph arrived.**
 *
 * So the bridge reports what it received instead of acting on it. These tests cover the reporter, **including
 * the property that matters most: it never records the content.**
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeItems, planMessage, textOf } from '../src/chatops/ilink-fleet-bridge.mjs';

/** An inbound message in the shape the live service returns, with a caller-supplied item list. */
const inbound = (items) => ({
  from_user_id: 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat',
  context_token: 'AARzJWAFAAABAAAAAAAp',
  message_type: 1,
  item_list: items,
});

describe('describeItems reports shape, never content', () => {
  it('says so when there is nothing to describe', () => {
    assert.equal(describeItems({}), 'item_list is empty or absent');
    assert.equal(describeItems({ item_list: [] }), 'item_list is empty or absent');
  });

  it('names a text item and its type', () => {
    const out = describeItems(inbound([{ type: 1, text_item: { text: 'hello' } }]));
    assert.match(out, /item\[0\]\.type=1/);
    assert.match(out, /text_item:\{text:string\}/);
  });

  it('NEVER records a value, which is the whole reason it is safe to log', () => {
    // The assertion that matters. A discovery aid that quietly wrote a user's message into a log file would be a
    // worse defect than the one it exists to diagnose.
    const secret = 'a-very-distinctive-passphrase-9f3a';
    const out = describeItems(inbound([{ type: 7, image_item: { url: `https://example.test/${secret}.png`, caption: secret } }]));
    assert.equal(out.includes(secret), false, `the value leaked: ${out}`);
    assert.match(out, /url:string/);
    assert.match(out, /caption:string/);
  });

  it('describes a plausible image item by key path and type', () => {
    // Not a claim about what iLink sends -- a demonstration that the reporter answers the question when it does.
    // Only the top level of `image_item` is pinned: the walk's depth bound is an implementation choice, and
    // asserting the exact rendering of a nested object would pin down behaviour nobody needs pinned.
    const out = describeItems(inbound([{
      type: 7,
      image_item: { url: 'https://example.test/a.png', width: 1024, height: 768, thumb: { url: 'https://example.test/t.png' } },
    }]));
    assert.match(out, /image_item:\{url:string,width:number,height:number,thumb:/, `got: ${out}`);
    assert.equal(out.includes('example.test'), false, 'and no URL text');
  });

  it('bounds the walk instead of dumping a surprising payload', () => {
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    const out = describeItems(inbound([{ type: 9, blob: deep }]));
    assert.match(out, /object\{…\}/, `expected truncation, got ${out}`);
  });

  it('describes arrays by length and first element rather than in full', () => {
    const out = describeItems(inbound([{ type: 9, list: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }]));
    assert.match(out, /list:array\[3\] of/);
    assert.equal(out.includes('"b"'), false);
  });

  it('handles a null and a cyclic reference without throwing', () => {
    assert.match(describeItems(inbound([{ type: 9, x: null }])), /x:null/);
    const cyclic = { type: 9 };
    cyclic.self = cyclic;
    // A cyclic payload must not recurse forever; the walk reports it and stops.
    assert.match(describeItems(inbound([cyclic])), /self:object\{cyclic\}/);
  });

  it('describes every item, not only the first', () => {
    const out = describeItems(inbound([{ type: 1, text_item: { text: 'a' } }, { type: 7, image_item: {} }]));
    assert.match(out, /item\[0\]\.type=1/);
    assert.match(out, /item\[1\]\.type=7/);
    assert.equal(out.split('|').length, 2);
  });
});

describe('a non-text message still gets a reply, and now carries its own shape', () => {
  const allowAll = () => true;

  it('replies instead of ignoring, and attaches the shape', () => {
    const plan = planMessage({ message: inbound([{ type: 7, image_item: { url: 'https://example.test/a.png' } }]), authorize: allowAll });
    assert.equal(plan.act, 'reply');
    assert.match(plan.text, /不是文字/);
    assert.equal(typeof plan.shape, 'string');
    assert.match(plan.shape, /item\[0\]\.type=7/);
  });

  it('does not attach a shape to a text reply, so the field means one thing', () => {
    const plan = planMessage({ message: inbound([{ type: 1, text_item: { text: '你好' } }]), authorize: allowAll });
    assert.equal(plan.act, 'reply');
    assert.equal(plan.shape, undefined, 'a text reply has no shape to report');
  });

  it('keeps textOf answering null for the same message, so the branch is unchanged', () => {
    // The reporter is additive: nothing about which messages are readable has changed.
    const message = inbound([{ type: 7, image_item: {} }]);
    assert.equal(textOf(message), null);
    assert.equal(planMessage({ message, authorize: allowAll }).act, 'reply');
  });
});
