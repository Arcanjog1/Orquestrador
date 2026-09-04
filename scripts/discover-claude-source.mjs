/**
 * Reads Anthropic's official Claude Code installer and reports what it does.
 *
 * The application must fetch Claude Code the way Anthropic publishes it, and
 * the only documented entry points are `claude.ai/install.sh` and
 * `claude.ai/install.ps1`. Rather than guess at a manifest URL - which is how
 * the current source ended up pointing at an endpoint that answers 403 - this
 * fetches the real installer and prints the URLs it actually uses, so the
 * resolver can be written against evidence.
 *
 * Informational by design: it changes nothing and installs nothing.
 */

const ENTRY_POINTS = [
  'https://claude.ai/install.ps1',
  'https://claude.ai/install.sh',
];

const TIMEOUT_MS = 30_000;

for (const entry of ENTRY_POINTS) {
  console.log(`\n=== ${entry} ===`);
  try {
    const response = await fetch(entry, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    console.log(`HTTP ${response.status} -> ${response.url}`);
    if (!response.ok) continue;

    const body = await response.text();
    console.log(`bytes: ${body.length}`);

    // Every absolute URL the installer mentions: that is the contract.
    const urls = [...new Set(body.match(/https?:\/\/[^\s"'`)\\]+/g) ?? [])];
    console.log('URLs referenced by the installer:');
    for (const url of urls) console.log(`  ${url}`);

    // Lines that look like they build a download path or pick a version.
    const interesting = body
      .split(/\r?\n/)
      .filter((line) =>
        /(version|manifest|stable|latest|download|platform|arch|checksum|sha256|GCS|bucket)/i.test(
          line,
        ),
      )
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .slice(0, 60);
    console.log('Lines that shape the download:');
    for (const line of interesting) console.log(`  ${line}`);
  } catch (error) {
    console.log(`unreachable: ${error?.message ?? String(error)}`);
  }
}

// Then the paths the installer's own host is known to serve, so we learn which
// of them answer and in what shape.
const CANDIDATES = [
  'https://downloads.claude.ai/claude-code-releases/stable',
  'https://downloads.claude.ai/claude-code-releases/latest',
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/stable',
];

for (const url of CANDIDATES) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.text();
    console.log(`\n${url} -> HTTP ${response.status} (${body.length} bytes)`);
    console.log(`  first 300 chars: ${body.slice(0, 300).replace(/\n/g, ' ')}`);
  } catch (error) {
    console.log(`\n${url} -> unreachable: ${error?.message ?? String(error)}`);
  }
}
