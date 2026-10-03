import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter, asString } from '../dist/index.js';

test('reads scalars, quotes, numbers and booleans', () => {
  const { data, present } = parseFrontmatter(
    ['---', 'name: deploy', 'description: "Ship it, carefully"', 'timeout: 30', 'enabled: true', '---', 'body'].join('\n'),
  );
  assert.equal(present, true);
  assert.equal(data.name, 'deploy');
  assert.equal(data.description, 'Ship it, carefully');
  assert.equal(data.timeout, 30);
  assert.equal(data.enabled, true);
});

test('reads inline and block lists', () => {
  const { data } = parseFrontmatter(
    ['---', 'tools: [Read, Write, Bash]', 'allowed-tools:', '  - Grep', '  - Glob', '---', ''].join('\n'),
  );
  assert.deepEqual(data.tools, ['Read', 'Write', 'Bash']);
  assert.deepEqual(data['allowed-tools'], ['Grep', 'Glob']);
});

test('returns the body separately from the frontmatter', () => {
  const { body } = parseFrontmatter(['---', 'name: x', '---', '', '# Heading', 'text'].join('\n'));
  assert.equal(body.trim(), '# Heading\ntext');
});

test('a file with no frontmatter is reported as absent, not empty', () => {
  const result = parseFrontmatter('# Just a heading\n');
  assert.equal(result.present, false);
  assert.deepEqual(result.data, {});
  assert.equal(result.body, '# Just a heading\n');
});

test('an unterminated fence is not treated as frontmatter', () => {
  const result = parseFrontmatter('---\nname: x\nno closing fence\n');
  assert.equal(result.present, false);
});

test('a leading byte-order mark does not hide the fence', () => {
  const result = parseFrontmatter('﻿---\nname: x\n---\nbody');
  assert.equal(result.present, true);
  assert.equal(result.data.name, 'x');
});

test('asString flattens whatever frontmatter produced', () => {
  assert.equal(asString(['a', 'b']), 'a, b');
  assert.equal(asString(42), '42');
  assert.equal(asString(true), 'true');
  assert.equal(asString(undefined), null);
});

test('stripComments drops trailing YAML comments the org templates carry', () => {
  const text = [
    '---',
    'status: pending      # pending → approved | denied → done',
    'requested_by:        # agent name',
    'action: publish      # publish | send | spend',
    'tier: 1',
    'title: "Issue #42 # not a comment inside quotes"',
    'note: price#1 stays',
    'tags:',
    '  - a   # first',
    '---',
    '',
  ].join('\n');
  const { data } = parseFrontmatter(text, { stripComments: true });
  assert.equal(data.status, 'pending');
  assert.equal(data.requested_by, undefined, 'a value that is only a comment is empty');
  assert.equal(data.action, 'publish');
  assert.equal(data.tier, 1);
  assert.equal(data.title, 'Issue #42 # not a comment inside quotes');
  assert.equal(data.note, 'price#1 stays', 'a # without leading space is literal, as in YAML');
  assert.deepEqual(data.tags, ['a']);
});

test('comments are kept verbatim unless asked for, so existing callers are unchanged', () => {
  const { data } = parseFrontmatter('---\ndescription: Fix issue #42 fast\n---\n');
  assert.equal(data.description, 'Fix issue #42 fast');
});
