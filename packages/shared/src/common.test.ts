import { describe, expect, it } from 'vitest';
import {
  FlavorSchema,
  NotionIdSchema,
  RepoIdSchema,
  UsernameSchema,
  isSafeBranchName,
  isSafeBranchPrefix,
  isSafeVersion,
} from './common';

describe('isSafeBranchName', () => {
  it.each([
    'main',
    'develop',
    'feature/foo-bar',
    'release/v1.0.16-alpha-8',
    'release_1.2',
    'a',
    'Improvement/CRD-34382/jdoe/{MO}adjustment',
  ])('accepts %s', (s) => expect(isSafeBranchName(s)).toBe(true));

  it.each([
    '',
    '-rf',
    '--upload-pack=x',
    'a..b',
    'a//b',
    'a/',
    '/a',
    'a.',
    'a.lock',
    'a/b.lock',
    'a/.hidden',
    'a b',
    'a;rm -rf /',
    '$(id)',
    '`id`',
    'a~1',
    'a^',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a@{1}',
    'a{b,c}',
    'a{1..3}',
    'a\nb',
    'é',
    'x'.repeat(201),
  ])('rejects %j', (s) => expect(isSafeBranchName(s)).toBe(false));
});

describe('isSafeBranchPrefix', () => {
  it.each(['release/v', 'release/', 'v', 'a/b/c/'])('accepts %s', (s) =>
    expect(isSafeBranchPrefix(s)).toBe(true),
  );
  it.each(['', '/x', '-x', 'a//', 'a..b', 'a b', 'a;b', '.x', 'a/.x/'])('rejects %j', (s) =>
    expect(isSafeBranchPrefix(s)).toBe(false),
  );
});

describe('isSafeVersion', () => {
  it.each([
    '1.0.16',
    '1.0.16-alpha-8',
    '1.0.16-alpha.8',
    '1.0.16-alpha8',
    '1.0.16+202511010930',
    '1.0.16-alpha-8+3',
    '10.20.30',
    '1.0.0-beta',
    '1.0.0-alpha',
    '1.0.0+-x',
    '1.0.0+a-b',
  ])('accepts %s', (s) => expect(isSafeVersion(s)).toBe(true));

  it.each([
    '',
    '1.0',
    'v1.0.0',
    '1.0.0 ',
    ' 1.0.0',
    '1.0.0;ls',
    '--version',
    '1.0.0+',
    '1.0.0+a b',
    '1.0.0\n',
    '1.2.3.4',
  ])('rejects %j', (s) => expect(isSafeVersion(s)).toBe(false));
});

describe('id schemas', () => {
  it('RepoIdSchema is path/URL safe', () => {
    for (const ok of ['app-a', 'a', '0app', 'x'.repeat(63)]) {
      expect(RepoIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['', 'App', 'a/b', '..', '.', 'a b', '-a', 'a_b', 'x'.repeat(64), 'a\\b']) {
      expect(RepoIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('UsernameSchema', () => {
    expect(UsernameSchema.safeParse('sam.reviewer').success).toBe(true);
    expect(UsernameSchema.safeParse('a b').success).toBe(false);
    expect(UsernameSchema.safeParse('-x').success).toBe(false);
    expect(UsernameSchema.safeParse('').success).toBe(false);
  });

  it('FlavorSchema', () => {
    for (const ok of ['auto', 'staging', 'development', 'production', 'preprod_2']) {
      expect(FlavorSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['', 'Staging', 'a b', 'a;b', '-x', '1x', 'a/b', '../x']) {
      expect(FlavorSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('NotionIdSchema accepts 32-hex and dashed UUID', () => {
    expect(NotionIdSchema.safeParse('0123456789abcdef0123456789abcdef').success).toBe(true);
    expect(NotionIdSchema.safeParse('01234567-89ab-cdef-0123-456789abcdef').success).toBe(true);
    expect(NotionIdSchema.safeParse('xyz').success).toBe(false);
    expect(NotionIdSchema.safeParse('0123456789abcdef0123456789abcde').success).toBe(false);
  });
});
