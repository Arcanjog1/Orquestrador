import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileCheckResult } from '../verification/file-check.js';
import type { QueryEvidence } from './query-proof.js';
import { progressFingerprint } from './progress-guard.js';

export function fileFactIdentity(check: FileCheckResult): string {
  return progressFingerprint({type:'FILE_MEASUREMENT', path:check.request.path, hash:check.sha256,
    bytes:check.sizeBytes, result:check.outcome, passed:check.passed,
    expected:check.request, source:check.measurement?.measurementSource, snapshot:check.measurement?.snapshot});
}

export function measurementProofs(check: FileCheckResult): string[] {
  if (check.outcome === 'missing') return ['FILE_EXISTENCE'];
  if (!check.measurement) return [];
  return ['FILE_EXISTENCE', 'PATH_EXISTS', 'FILE_HASH', ...(check.measurement.comparedExactBytes ? ['FILE_CONTENT'] : [])];
}

/** A bounded real listing, separate from a measured file. One file cannot
 * certify an entire repository tree. Never traverse symlinks or .git. */
export async function localTreeProof(root: string, snapshot: {repository:string;branch:string;commit:string}): Promise<QueryEvidence> {
  const paths: string[] = [];
  let complete = true;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 32 || paths.length >= 20_000) { complete = false; return; }
    try {
      const entries = await readdir(join(root, relative), {withFileTypes:true});
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        if (paths.length >= 20_000) {complete = false; break;}
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        paths.push(path);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, depth + 1);
      }
    } catch {complete = false;}
  }
  await visit('', 0);
  return {kind:'REPOSITORY_TREE', ...snapshot, paths:paths.sort(), complete};
}
