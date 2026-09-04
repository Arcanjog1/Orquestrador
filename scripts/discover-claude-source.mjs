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

// Then walk the channel exactly as the installer does: version, manifest,
// platform table. The platform keys are the part that cannot be read from the
// POSIX script, and they are what the resolver has to match.
const BASE = 'https://downloads.claude.ai/claude-code-releases';

for (const channel of ['stable', 'latest']) {
  try {
    const response = await fetch(`${BASE}/${channel}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const version = (await response.text()).trim();
    console.log(`\n${BASE}/${channel} -> HTTP ${response.status}: ${version}`);
    if (!response.ok || !/^\d+\.\d+\.\d+/.test(version)) continue;

    const manifestUrl = `${BASE}/${version}/manifest.json`;
    const manifestResponse = await fetch(manifestUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    console.log(`${manifestUrl} -> HTTP ${manifestResponse.status}`);
    if (!manifestResponse.ok) continue;

    const manifest = await manifestResponse.json();
    const platforms = manifest?.platforms ?? {};
    console.log('  platform keys and digests:');
    for (const [key, value] of Object.entries(platforms)) {
      const checksum = typeof value?.checksum === 'string' ? value.checksum : '(none)';
      const size = typeof value?.size === 'number' ? value.size : '(none)';
      console.log(`    ${key.padEnd(20)} sha256=${checksum} size=${size}`);
    }
  } catch (error) {
    console.log(`\n${BASE}/${channel} -> unreachable: ${error?.message ?? String(error)}`);
  }
}
