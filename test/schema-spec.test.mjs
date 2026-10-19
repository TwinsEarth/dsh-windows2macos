/**
 * The authoring rule the packed artifact failed in a real host: an object parameter must state additionalProperties.
 * These tests are on the checker itself, because its job is to be right about schemas the suite never mounts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { objectNodes, schemaProblems } from '../src/plugin/schema-spec.mjs';

describe('objectNodes', () => {
  it('finds nested objects through properties, items and unions', () => {
    const schema = {
      properties: {
        plain: { type: 'object', additionalProperties: true },
        list: { type: 'array', items: { type: 'object', additionalProperties: false } },
        choice: { oneOf: [{ type: 'object', additionalProperties: true }] },
      },
    };
    const paths = objectNodes(schema).map((node) => node.path);
    assert.ok(paths.includes('schema.properties.plain'));
    assert.ok(paths.includes('schema.properties.list[]'));
    assert.ok(paths.includes('schema.properties.choice.oneOf[0]'));
  });

  it('handles a null or scalar schema without throwing', () => {
    assert.deepEqual(objectNodes(null), []);
    assert.deepEqual(objectNodes({}), []);
    assert.deepEqual(objectNodes({ type: 'string' }), []);
  });
});

describe('schemaProblems', () => {
  it('names each object parameter that does not state additionalProperties', () => {
    const problems = schemaProblems({
      type: 'object',
      additionalProperties: false,
      properties: {
        good: { type: 'object', additionalProperties: false },
        bad: { type: 'object' },
      },
    }, 'w2m_demo');
    assert.equal(problems.length, 1);
    assert.match(problems[0].path, /w2m_demo\.parameters\.properties\.bad\.additionalProperties/);
  });

  it('reports every offender at once instead of throwing on the first', () => {
    const problems = schemaProblems({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'object' }, b: { type: 'array', items: { type: 'object' } } },
    }, 'w2m_demo');
    assert.equal(problems.length, 2);
  });

  it('accepts additionalProperties: true as well as false', () => {
    assert.deepEqual(schemaProblems({ type: 'object', additionalProperties: false, properties: { a: { type: 'object', additionalProperties: true } } }, 'x'), []);
  });
});