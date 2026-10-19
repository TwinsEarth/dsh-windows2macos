/**
 * Authoring rules DSH enforces on tool schemas, checked here so the failure happens at build time in this repository
 * rather than at mount time in someone else's profile.
 *
 * The rule this exists for: DSH's `parameterSchemaSpecToJsonSchema` requires an EXPLICIT `additionalProperties` on every
 * `type: 'object'` node and throws otherwise. Local tests passed while the packed artifact failed in a real profile,
 * which is exactly the gap a pure checker closes: the same walk runs in the suite and at registration.
 */

/**
 * Every `type: 'object'` node in a JSON-schema-shaped value, with its path.
 *
 * @param {unknown} schema
 * @param {string} [path]
 * @returns {Array<{path: string, node: object}>}
 */
export function objectNodes(schema, path = 'schema') {
  const found = [];
  if (schema === null || typeof schema !== 'object') return found;
  const node = schema;
  if (node.type === 'object') found.push({ path, node });
  if (node.properties !== null && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) {
      found.push(...objectNodes(child, path + '.properties.' + name));
    }
  }
  if (node.items !== undefined) found.push(...objectNodes(node.items, path + '[]'));
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) {
      node[key].forEach((child, index) => found.push(...objectNodes(child, path + '.' + key + '[' + index + ']')));
    }
  }
  return found;
}

/**
 * The problems a schema would be refused for, as `{path, why}` values rather than a thrown error, so a caller can report
 * all of them at once instead of fixing one per run.
 *
 * @param {unknown} schema
 * @param {string} [name] tool name, used in the path
 * @returns {Array<{path: string, why: string}>}
 */
export function schemaProblems(schema, name = 'tool') {
  return objectNodes(schema, 'parameters')
    .filter(({ node }) => typeof node.additionalProperties !== 'boolean')
    .map(({ path }) => ({ path: path + '.additionalProperties', why: 'an object parameter must state additionalProperties: true or false' }))
    .map((problem) => ({ ...problem, path: name + '.' + problem.path }));
}
