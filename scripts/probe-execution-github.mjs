/** Explicit opt-in, disposable repository only. Credentials stay in memory. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { RepositoryOperations } from "../dist/github/repository-operations.js";
import { collectGitHubEvidence } from "../dist/github/github-evidence.js";

if (!process.argv.includes("--create-disposable"))
  throw new Error(
    "Pass --create-disposable to authorize creating a private test repository.",
  );
const token = execFileSync("gh", ["auth", "token"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const operations = new RepositoryOperations();
const name =
  "orchestrator-e2e-" +
  new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
const created = await operations.createRepository(
  {
    name,
    private: true,
    autoInit: true,
    description: "Disposable AI Orchestrator GitHub transport E2E; no merge.",
  },
  token,
);
const [owner, repo] = created.fullName.split("/");
const ref = { owner, repo, ref: null };
const metadata = await operations.repository(ref, token);
const base = await operations.resolveRef(ref, metadata.defaultBranch, token);
const tree = await operations.tree(ref, base.commitSha, token);
const original = await operations.readFile(
  ref,
  "README.md",
  base.commitSha,
  token,
);
assert.ok(original.text);
const branch = "codex/execution-worktree-e2e";
await operations.createBranch(ref, branch, base.commitSha, token);
const content =
  original.text + "\nExecution Worktree: independently read and verified.\n";
const committed = await operations.commit(
  ref,
  {
    branch,
    expectedHeadSha: base.commitSha,
    message: "test: verify execution worktree GitHub transport",
    changes: [{ op: "write", path: "README.md", text: content }],
  },
  token,
);
assert.equal(committed.committed, true);
const readback = await operations.readFile(
  ref,
  "README.md",
  committed.commitSha,
  token,
);
assert.equal(readback.text, content);
const evidence = await collectGitHubEvidence({
  operations,
  ref,
  branch,
  baseCommit: base.commitSha,
  token,
});
assert.equal(evidence.changedSinceBaseline, true);
assert.ok(evidence.changedFiles.includes("README.md"));
const pr = await operations.openPullRequest(
  ref,
  {
    head: branch,
    base: metadata.defaultBranch,
    title: "Disposable Execution Worktree E2E",
    body: "Created by the authorized E2E. Exact byte readback and GitHub diff verified. Do not merge.",
    draft: true,
  },
  token,
);
assert.equal(
  await operations.branchHead(ref, metadata.defaultBranch, token),
  base.commitSha,
);
const result = {
  repository: created.htmlUrl,
  baseBranch: metadata.defaultBranch,
  baseCommit: base.commitSha,
  commit: committed.commitSha,
  branch,
  treeFiles: tree.entries?.length,
  readback: true,
  evidenceFiles: evidence.changedFiles,
  pr,
  defaultBranchUnchanged: true,
  scope: "Real GitHub transport; no live Codex/Claude inference",
  at: new Date().toISOString(),
};
writeFileSync("github-e2e-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
