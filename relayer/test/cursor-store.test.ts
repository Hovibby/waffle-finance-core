import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { CursorStore, type CursorRecord } from '../src/utils/cursor-store.js';

const TEST_DIR = join(process.cwd(), '.cursor-test');

describe('CursorStore', () => {
  let store: CursorStore;

  beforeEach(() => {
    // Clean slate before each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    store = new CursorStore({ storageDir: TEST_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns null when no cursor has been saved for a label', () => {
    expect(store.load('nonexistent')).toBeNull();
  });

  it('persists and retrieves a cursor value', () => {
    store.save('test-poller', 42);
    expect(store.load('test-poller')).toBe(42);
  });

  it('overwrites previous value on subsequent save', () => {
    store.save('test-poller', 100);
    store.save('test-poller', 200);
    expect(store.load('test-poller')).toBe(200);
  });

  it('supports multiple independent labels', () => {
    store.save('poller-a', 10);
    store.save('poller-b', 20);
    expect(store.load('poller-a')).toBe(10);
    expect(store.load('poller-b')).toBe(20);
  });

  it('persists to disk so a new instance can read it', () => {
    store.save('disk-test', 999);
    const store2 = new CursorStore({ storageDir: TEST_DIR });
    expect(store2.load('disk-test')).toBe(999);
  });

  it('sanitizes label to safe filename characters', () => {
    store.save('my contract!@# poller', 77);
    const store2 = new CursorStore({ storageDir: TEST_DIR });
    expect(store2.load('my contract!@# poller')).toBe(77);
  });

  it('stores a valid JSON file on disk', () => {
    store.save('json-check', 55);
    const files = readFileSync(join(TEST_DIR, 'json-check.json'), 'utf-8');
    const parsed = JSON.parse(files);
    expect(parsed.label).toBe('json-check');
    expect(parsed.cursor).toBe(55);
    expect(parsed.updatedAt).toBeTypeOf('number');
  });

  it('clearCache forces a fresh disk read', () => {
    store.save('cached', 1);
    expect(store.load('cached')).toBe(1);

    store.clearCache();
    // should still load from disk
    expect(store.load('cached')).toBe(1);
  });

  // ── Label-mismatch guard ─────────────────────────────────────────────────
  // A file copied from another listener must never silently advance the wrong
  // stream.  load() must reject any record whose stored label differs from the
  // label requested by the caller.

  it('rejects a record whose stored label does not match the requested label', () => {
    // Write a valid record for "poller-a" but save it under "poller-b"'s path.
    // This simulates copying a cursor file from one listener to another.
    store.save('poller-a', 500);

    // Manually write the poller-a content into the poller-b file path.
    const mismatchRecord: CursorRecord = {
      label: 'poller-a',   // wrong label in the record
      cursor: 500,
      updatedAt: Date.now(),
    };
    writeFileSync(
      join(TEST_DIR, 'poller-b.json'),
      JSON.stringify(mismatchRecord),
      'utf-8',
    );

    // A new instance has no cache, so it reads from disk.
    const freshStore = new CursorStore({ storageDir: TEST_DIR });
    // Must return null — mismatched label triggers the recovery path.
    expect(freshStore.load('poller-b')).toBeNull();
  });

  it('accepts a record whose stored label matches the requested label', () => {
    store.save('exact-match', 123);
    store.clearCache();
    // Same label in file and in request — should return the cursor.
    expect(store.load('exact-match')).toBe(123);
  });

  it('returns null for a malformed record (missing label field)', () => {
    // Write a record that has cursor but no label — malformed JSON structure.
    const malformed = { cursor: 42, updatedAt: Date.now() };   // no "label" key
    writeFileSync(
      join(TEST_DIR, 'no-label.json'),
      JSON.stringify(malformed),
      'utf-8',
    );

    const freshStore = new CursorStore({ storageDir: TEST_DIR });
    // record.label is undefined, which !== 'no-label', so recovery path applies.
    expect(freshStore.load('no-label')).toBeNull();
  });

  it('returns null for a malformed record (missing cursor field)', () => {
    // Write a record that has the right label but no cursor value.
    const malformed = { label: 'no-cursor', updatedAt: Date.now() };
    writeFileSync(
      join(TEST_DIR, 'no-cursor.json'),
      JSON.stringify(malformed),
      'utf-8',
    );

    const freshStore = new CursorStore({ storageDir: TEST_DIR });
    // typeof record.cursor !== 'number', so the outer guard blocks before the
    // label check even runs — still returns null.
    expect(freshStore.load('no-cursor')).toBeNull();
  });
});
