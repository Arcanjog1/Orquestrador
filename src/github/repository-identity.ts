/**
 * When two things a person typed are the same repository.
 *
 * The folder had this problem first, and `src/workspace/folder-identity.ts`
 * solved it: the same directory, spelled two ways, became two projects. A
 * repository has exactly the same problem and more spellings of it —
 *
 * | Typed | | |
 * |---|---|---|
 * | `https://github.com/Arcanjog1/Orquestrador` | | the link from the browser |
 * | `https://github.com/Arcanjog1/Orquestrador.git` | | the link the clone button gives |
 * | `git@github.com:Arcanjog1/Orquestrador.git` | | the ssh remote |
 * | `Arcanjog1/Orquestrador` | | what a person types from memory |
 * | `arcanjog1/orquestrador` | | what a person types in a hurry |
 *
 * — and all five are one repository. Comparing the visible name is not enough
 * either: `Arcanjog1/Orquestrador` and `someone-else/Orquestrador` are two
 * different repositories that would collapse into one if the leaf decided.
 *
 * ## The rule
 *
 * The identity is **host + owner + name**, folded to lower case, with any
 * `.git` suffix and any `tree/<branch>` tail removed. GitHub treats owner and
 * repository names case-insensitively for lookup, so folding is what the
 * server does too. The branch is deliberately *not* part of the identity: two
 * branches of one repository are one project with one history, not two
 * projects that would each accumulate their own conversations.
 *
 * An empty string means "not a repository", and — as with a folder key —
 * an empty key matches nothing, not even another empty key. Otherwise every
 * project that is only a folder would collapse into one.
 */

import { parseRepositoryUrl, type RepositoryRef } from './repository-reader.js';

/** The host every form above resolves to. Kept explicit so the key can grow one. */
const HOST = 'github.com';

/**
 * The canonical identity of a repository: equal keys mean the same repository.
 *
 * Returns `''` for anything that is not recognisably a repository, which is
 * the same thing an unlinked project stores.
 */
export function repositoryKey(input: string | null | undefined): string {
  if (!input) return '';
  const ref = parseRepositoryUrl(input);
  if (!ref) return '';
  return keyOfRef(ref);
}

/** The key for a reference that has already been parsed. */
export function keyOfRef(ref: Pick<RepositoryRef, 'owner' | 'repo'>): string {
  const owner = ref.owner.trim().toLowerCase();
  const repo = ref.repo.trim().replace(/\.git$/i, '').toLowerCase();
  if (owner.length === 0 || repo.length === 0) return '';
  return `${HOST}/${owner}/${repo}`;
}

/** True when both inputs name the same repository. */
export function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = repositoryKey(a);
  if (left.length === 0) return false;
  return left === repositoryKey(b);
}

/**
 * `owner/name`, in the casing the person supplied.
 *
 * The key is folded so that lookups work; this is what gets *shown*, because
 * `Arcanjog1/Orquestrador` is how its owner writes it and `arcanjog1/orquestrador`
 * would look like a typo of their own project's name.
 */
export function displayFullName(input: string | null | undefined): string | null {
  if (!input) return null;
  const ref = parseRepositoryUrl(input);
  if (!ref) return null;
  return `${ref.owner}/${ref.repo.replace(/\.git$/i, '')}`;
}

/** The canonical https URL, for opening in a browser. Null when not a repository. */
export function canonicalUrl(input: string | null | undefined): string | null {
  const full = displayFullName(input);
  return full ? `https://${HOST}/${full}` : null;
}

/**
 * A project name to offer for a repository that has none yet.
 *
 * The repository's own name, not `owner/name`: the owner is nearly always the
 * same person for every project in the sidebar, so repeating it in each row
 * spends width on the one part that never distinguishes anything.
 */
export function suggestedRepositoryName(input: string | null | undefined): string {
  const ref = input ? parseRepositoryUrl(input) : null;
  const name = ref?.repo.replace(/\.git$/i, '').trim() ?? '';
  return name.length > 0 ? name : 'Projeto';
}

/** The branch a URL pointed at (`/tree/<branch>`), when it pointed at one. */
export function refInUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  return parseRepositoryUrl(input)?.ref ?? null;
}
