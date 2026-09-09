/**
 * The repository's file paths, in a form a supervisor can plan from.
 *
 * ## What went wrong
 *
 * A person asked, of a public repository with no checkout: *"consegue ler os
 * arquivos q tem nesse repositorio?"* The application resolved the repository,
 * the branch and the commit correctly - and then the supervisor delegated
 * *"liste os arquivos do projeto disponíveis no workspace"* to a worker whose
 * working directory is deliberately empty. The worker said so, correctly, and
 * the run ended in human review over a listing the application could have
 * fetched in one request.
 *
 * The cause was structural, not a wording problem: the supervisor was told to
 * use `fileReads`, and `fileReads` needs a **path**. Nothing gave it a way to
 * learn one. Reading a file it cannot name is not a capability.
 *
 * ## What this is
 *
 * A rendering of the tree, capped so a large repository cannot fill a prompt,
 * and a filter so the supervisor can ask for the rest. The cap is stated every
 * time it applies: a partial listing presented as complete is how a run
 * concludes about files nobody looked at.
 */

import type { RepositoryTree, TreeEntry } from './repository-operations.js';

/** How many paths ride along in the prompt before the supervisor must ask. */
export const TREE_PREVIEW_LIMIT = 300;
/** The ceiling on one answered `listFiles`, whatever it asked for. */
export const TREE_LISTING_LIMIT = 1000;

export interface ListFilesRequest {
  readonly prefix?: string | null;
  readonly contains?: string | null;
  readonly limit?: number | null;
}

export interface FileListing {
  readonly paths: readonly string[];
  /** Everything that matched, before the limit. */
  readonly matched: number;
  /** True when the answer is shorter than what matched. */
  readonly capped: boolean;
  /** True when GitHub itself could not return the whole tree. */
  readonly treeTruncated: boolean;
}

/** The blobs of a tree, sorted, as paths. Directories are not files. */
export function filePaths(tree: RepositoryTree): string[] {
  return tree.entries
    .filter((entry: TreeEntry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Answers one `listFiles`, by filtering a list already in hand. */
export function listFiles(tree: RepositoryTree, request: ListFilesRequest = {}): FileListing {
  const prefix = (request.prefix ?? '').trim();
  const contains = (request.contains ?? '').trim().toLowerCase();
  const matches = filePaths(tree).filter((path) => {
    if (prefix && !path.startsWith(prefix)) return false;
    if (contains && !path.toLowerCase().includes(contains)) return false;
    return true;
  });
  const limit = Math.min(request.limit ?? TREE_LISTING_LIMIT, TREE_LISTING_LIMIT);
  return {
    paths: matches.slice(0, limit),
    matched: matches.length,
    capped: matches.length > limit,
    treeTruncated: tree.truncated,
  };
}

/**
 * The listing as the supervisor reads it.
 *
 * Sizes are included where GitHub reported them, because "which file holds the
 * login logic" is often answered as much by shape as by name. Every limit that
 * applied is said out loud.
 */
export function renderListing(
  listing: FileListing,
  tree: RepositoryTree,
  heading: string,
): string {
  const sizes = new Map(tree.entries.map((entry) => [entry.path, entry.size]));
  const lines = [heading];
  if (listing.paths.length === 0) {
    lines.push('  (nenhum arquivo corresponde)');
    return lines.join('\n');
  }
  for (const path of listing.paths) {
    const size = sizes.get(path);
    lines.push(`  ${path}${typeof size === 'number' ? ` (${size} bytes)` : ''}`);
  }
  if (listing.capped) {
    lines.push(
      `  ... ${listing.matched - listing.paths.length} caminho(s) a mais correspondem e não estão`,
      '  nesta lista. Use "listFiles" com "prefix" ou "contains" para ver o resto.',
    );
  }
  if (listing.treeTruncated) {
    lines.push(
      '  ATENÇÃO: o próprio GitHub truncou a árvore deste repositório, então nem esta lista nem',
      '  qualquer filtro sobre ela é completa. Não trate a ausência de um caminho como prova de',
      '  que ele não existe.',
    );
  }
  return lines.join('\n');
}

/** The block that rides along in every orchestrator prompt for a GitHub run. */
export function renderTreePreview(tree: RepositoryTree): string {
  const listing = listFiles(tree, { limit: TREE_PREVIEW_LIMIT });
  return renderListing(
    listing,
    tree,
    `FILES IN THIS REPOSITORY at ${tree.commitSha.slice(0, 12)} ` +
      `(${listing.matched} arquivo(s) no total):`,
  );
}
