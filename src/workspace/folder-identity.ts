/**
 * When two paths are the same folder (spec 2).
 *
 * The complaint this exists for: selecting a folder produced a second entry
 * instead of opening the one that was already there. Deciding that reliably
 * needs one thing the application did not have — a stable identity for a
 * folder, that survives the ways Windows lets the same folder be spelled.
 *
 * ## The rule
 *
 * Two paths are the same folder when they resolve to the same place on disk.
 * Not when they look alike, and **never** when they merely share a name:
 * `D:\clientes\acme\site` and `D:\clientes\beta\site` are two projects, and
 * treating them as one because both end in `site` would silently pour one
 * person's conversations into another's.
 *
 * ## What is folded, and why
 *
 * | Difference | Folded? | Why |
 * |---|---|---|
 * | `C:\Proj` vs `c:\proj` | yes, on Windows | NTFS is case-insensitive by default; the shell hands back either |
 * | `C:/Proj` vs `C:\Proj` | yes | both are accepted separators on Windows |
 * | `C:\Proj\` vs `C:\Proj` | yes | a trailing separator is not a different folder |
 * | `C:\a\..\Proj` vs `C:\Proj` | yes | `resolve` normalises it |
 * | a junction and its target | yes, when both exist | `realpath` answers what the filesystem says |
 * | `/home/x/Proj` vs `/home/x/proj` | **no**, on POSIX | these really are two folders |
 * | two folders with the same name | **no** | identity is the whole path, never the leaf |
 *
 * ## What is deliberately not attempted
 *
 * Short (8.3) names such as `C:\PROGRA~1`, and a folder reached through a
 * network share as well as a drive letter, are not folded when the path does
 * not exist: answering would require asking the filesystem, and there is
 * nothing to ask about a folder that is not there. When the path *does*
 * exist, `realpath` handles both. A missed fold is a duplicate the person can
 * see and fix; a wrong fold merges two projects and loses work, so the
 * uncertain case fails the safe way.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** `win32` folds case; `posix` does not. Injected so tests cover both. */
export type PathPlatform = 'win32' | 'posix';

export function currentPlatform(): PathPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

/**
 * The identity of a folder: equal keys mean the same folder.
 *
 * Empty string for an empty path, which is what a conversation project has —
 * it owns no folder, and must never be matched against one.
 */
export function folderKey(
  localPath: string,
  options: {
    platform?: PathPlatform;
    /** Injected for tests. Returning `null` means "cannot ask the filesystem". */
    realpath?: (path: string) => string | null;
  } = {},
): string {
  const raw = localPath.trim();
  if (raw.length === 0) return '';

  const platform = options.platform ?? currentPlatform();
  const realpathOf = options.realpath ?? defaultRealpath;

  // What the filesystem says, when it can say anything. This is the part that
  // sees through a junction, a symlink or a short name - and the part that
  // simply does not apply to a folder that does not exist yet.
  const resolved = safeResolve(raw);
  const real = realpathOf(resolved) ?? resolved;

  let key = real;
  if (platform === 'win32') {
    // Both separators mean the same thing on Windows, and the shell, the
    // clipboard and a hand-typed path do not agree on which to use.
    key = key.replace(/\//g, '\\');
    // NTFS is case-insensitive by default. Folding here is what makes
    // `C:\Users\...` and `c:\users\...` one project rather than two.
    key = key.toLowerCase();
  }

  // A trailing separator is not a different folder. The root is left alone:
  // `C:\` and `/` are the whole path, not a path with a stray separator.
  key = stripTrailingSeparator(key, platform);
  return key;
}

/** True when both paths name the same folder. */
export function sameFolder(
  a: string,
  b: string,
  options: Parameters<typeof folderKey>[1] = {},
): boolean {
  const left = folderKey(a, options);
  // An empty path has no identity, so it matches nothing - not even another
  // empty path. Two conversation projects are two projects.
  if (left.length === 0) return false;
  return left === folderKey(b, options);
}

/**
 * A name to offer for a folder that has none yet.
 *
 * The last segment, which is what a person calls the folder. Only a
 * suggestion: the project's name is editable afterwards and renaming it never
 * touches the disk.
 */
export function suggestedProjectName(localPath: string): string {
  const cleaned = stripTrailingSeparator(safeResolve(localPath.trim()), currentPlatform());
  const segments = cleaned.split(/[\\/]/).filter((part) => part.length > 0);
  const last = segments.at(-1) ?? '';
  // A root has no leaf. On Windows that is a drive root, and naming the
  // project after the drive (`D:\`) is the honest answer - `D:` alone would
  // be punctuation. On POSIX the root is `/`, which is nothing but a
  // separator and no name at all, so it falls through to the last resort.
  const name = last.length === 0 || /^[a-zA-Z]:$/.test(last) ? cleaned : last;
  // Whatever route it came by, a name has to be readable. A string with no
  // letter or digit in it is not a name a person can pick out of a sidebar.
  return /[A-Za-z0-9]/.test(name) ? name : 'Projeto';
}

function safeResolve(path: string): string {
  try {
    return resolve(path);
  } catch {
    // `resolve` throws on a few malformed inputs. The raw text is still a
    // usable key: it is stable, and the caller validates the folder anyway.
    return path;
  }
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync.native ? realpathSync.native(path) : realpathSync(path);
  } catch {
    // Does not exist, or cannot be read. Both are honest answers to "what is
    // the real path", and both mean the lexical form is the best available.
    return null;
  }
}

function stripTrailingSeparator(path: string, platform: PathPlatform): string {
  const separators = platform === 'win32' ? /[\\/]+$/ : /\/+$/;
  const stripped = path.replace(separators, '');
  if (stripped.length > 0) {
    // `C:` alone is not a path; `C:\` is. Keep the root's separator.
    if (platform === 'win32' && /^[a-zA-Z]:$/.test(stripped)) return `${stripped}${sep}`;
    return stripped;
  }
  // The path was nothing but separators: that is the POSIX root.
  return path.length > 0 ? '/' : '';
}
