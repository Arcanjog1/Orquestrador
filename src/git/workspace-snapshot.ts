/**
 * The workspace as a bounded list of files.
 *
 * This exists because git is not always the answer. A person can point this
 * product at a plain folder that was never `git init`-ed, and on a machine
 * where the managed Git has not been installed the git executable may not run
 * at all. In both cases the previous collector answered "no changes" - which
 * is indistinguishable, to everything downstream, from a worker that did
 * nothing. A run where the file really was created then looks like a failure,
 * forever, and no amount of re-delegating fixes it.
 *
 * So when git cannot answer, the program walks the folder itself. It is still
 * evidence gathered by the program, never the worker's account of its own
 * work, which is the property that matters.
 *
 * Bounded deliberately. A workspace can hold a `node_modules` with a hundred
 * thousand files; walking it every iteration would cost more than the run. The
 * walk skips the usual heavy directories, stops at a file cap, and *says* when
 * it stopped - because a truncated walk cannot prove a file is absent, and
 * pretending otherwise would be the same dishonesty from the other direction.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileSnapshot } from '../core/types.js';

/**
 * Directories never worth walking: they are large, machine-generated, and a
 * change inside them is not the evidence anybody is looking for.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-tests',
  'dist-renderer',
  'dist-coordinator',
  'build',
  'out',
  'release',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

/** Above this the walk stops and says so. */
const MAX_FILES = 20_000;

/** Files larger than this are fingerprinted by size alone, not read. */
const MAX_HASHED_BYTES = 2 * 1024 * 1024;

export interface SnapshotOptions {
  maxFiles?: number;
  /** Extra directory names to skip, by name at any depth. */
  skip?: readonly string[];
}

/**
 * Walks `root` and fingerprints every file it covers.
 *
 * The fingerprint is `size:sha256` for a small file and `size:large` for a big
 * one - enough to notice a file appearing, disappearing or changing content,
 * without reading gigabytes to find out.
 */
export function snapshotWorkspace(root: string, options: SnapshotOptions = {}): FileSnapshot {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const skip = new Set([...SKIPPED_DIRECTORIES, ...(options.skip ?? [])]);
  const entries: Record<string, string> = {};
  const skipped: string[] = [];
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    let children: Dirent[];
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory this process cannot read is recorded by its absence from
      // the snapshot; it is not a reason to abandon the whole walk.
      return;
    }
    for (const child of children) {
      if (truncated) return;
      const full = join(directory, child.name);
      if (child.isDirectory()) {
        if (skip.has(child.name)) {
          skipped.push(relative(root, full).split(sep).join('/'));
          continue;
        }
        walk(full);
        continue;
      }
      // Symbolic links are not followed: a link out of the workspace would
      // make the snapshot describe somewhere else entirely.
      if (!child.isFile()) continue;
      if (Object.keys(entries).length >= maxFiles) {
        truncated = true;
        return;
      }
      const key = relative(root, full).split(sep).join('/');
      entries[key] = fingerprint(full);
    }
  };

  walk(root);
  return { entries, truncated, skipped };
}

/** What changed between two snapshots. */
export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
  get changed(): boolean;
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [path, digest] of Object.entries(after.entries)) {
    const previous = before.entries[path];
    if (previous === undefined) added.push(path);
    else if (previous !== digest) modified.push(path);
  }
  for (const path of Object.keys(before.entries)) {
    if (after.entries[path] === undefined) removed.push(path);
  }

  added.sort();
  removed.sort();
  modified.sort();
  return {
    added,
    removed,
    modified,
    get changed() {
      return added.length > 0 || removed.length > 0 || modified.length > 0;
    },
  };
}

function fingerprint(path: string): string {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return 'unreadable';
  }
  if (size > MAX_HASHED_BYTES) return `${size}:large`;
  try {
    return `${size}:${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)}`;
  } catch {
    return `${size}:unreadable`;
  }
}
