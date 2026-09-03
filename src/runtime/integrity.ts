/**
 * Integrity and publisher verification.
 *
 * A missing checksum is not the same as a passing one. When nothing
 * cryptographic could be checked, the result is recorded as
 * `UNVERIFIED_BINARY_SOURCE` and the source it came from is ranked below any
 * source that can prove what it served.
 */

import { createHash } from 'node:crypto';
import { ProcessManager } from '../process/process-manager.js';

export type IntegrityStrategy =
  /** The npm registry publishes a Subresource Integrity string per artifact. */
  | 'NPM_INTEGRITY'
  /** The release channel publishes a SHA-256 for the artifact. */
  | 'SHA256'
  /** The release manifest itself is signed. */
  | 'SIGNED_MANIFEST'
  /** The downloaded executable carries a Windows Authenticode signature. */
  | 'AUTHENTICODE'
  /** Nothing to verify beyond the transport. Lowest trust. */
  | 'HTTPS_ONLY_LAST_RESORT';

export type TrustLevel =
  /** Something cryptographic was checked and it passed. */
  | 'VERIFIED'
  /** Nothing cryptographic could be checked. Transport security only. */
  | 'UNVERIFIED_BINARY_SOURCE';

export interface IntegrityVerdict {
  strategy: IntegrityStrategy;
  trustLevel: TrustLevel;
  /** True only when a check ran and passed. `false` means it ran and failed. */
  verified: boolean;
  /** Short explanation, kept in the manifest and shown in the developer view. */
  detail: string;
  /** Publisher observed on a signed binary, when one could be read. */
  observedPublisher?: string;
}

/** Ranks trust so sources that can prove themselves are preferred. */
export function trustRank(level: TrustLevel): number {
  return level === 'VERIFIED' ? 0 : 1;
}

/** Verifies a checksum-style strategy over the downloaded bytes. */
export function verifyBytes(
  strategy: IntegrityStrategy,
  bytes: Buffer,
  expected: string | undefined,
): IntegrityVerdict {
  if (strategy === 'HTTPS_ONLY_LAST_RESORT' || !expected) {
    return {
      strategy,
      trustLevel: 'UNVERIFIED_BINARY_SOURCE',
      verified: false,
      detail:
        'Nenhum checksum ou assinatura foi publicado por esta origem: a integridade não pôde ser comprovada.',
    };
  }

  if (strategy === 'NPM_INTEGRITY' || strategy === 'SIGNED_MANIFEST') {
    const passed = verifySubresourceIntegrity(bytes, expected);
    return passed
      ? {
          strategy,
          trustLevel: 'VERIFIED',
          verified: true,
          detail: 'Integridade conferida contra o valor publicado pela origem.',
        }
      : {
          strategy,
          trustLevel: 'UNVERIFIED_BINARY_SOURCE',
          verified: false,
          detail: 'O conteúdo baixado não corresponde ao valor publicado.',
        };
  }

  if (strategy === 'SHA256') {
    const actual = createHash('sha256').update(bytes).digest('hex');
    const passed = actual.toLowerCase() === expected.replace(/^sha256[-:]/i, '').toLowerCase();
    return passed
      ? { strategy, trustLevel: 'VERIFIED', verified: true, detail: 'SHA-256 conferido.' }
      : {
          strategy,
          trustLevel: 'UNVERIFIED_BINARY_SOURCE',
          verified: false,
          detail: 'O SHA-256 do arquivo baixado não corresponde ao publicado.',
        };
  }

  // AUTHENTICODE is checked on the extracted executable, not on the archive.
  return {
    strategy,
    trustLevel: 'UNVERIFIED_BINARY_SOURCE',
    verified: false,
    detail: 'A assinatura ainda não foi verificada neste ponto.',
  };
}

/** Checks an npm-style `sha512-<base64>` (possibly several, space separated). */
export function verifySubresourceIntegrity(bytes: Buffer, integrity: string): boolean {
  for (const entry of integrity.trim().split(/\s+/)) {
    const separator = entry.indexOf('-');
    if (separator < 0) continue;
    const algorithm = entry.slice(0, separator);
    const expected = entry.slice(separator + 1);
    if (!['sha256', 'sha384', 'sha512'].includes(algorithm)) continue;
    if (createHash(algorithm).update(bytes).digest('base64') === expected) return true;
  }
  return false;
}

export interface AuthenticodeResult {
  /** `Valid`, `NotSigned`, `HashMismatch`, ... as reported by Windows. */
  status: string;
  /** Certificate subject, e.g. the `O=` of the signing organisation. */
  subject: string | null;
  valid: boolean;
}

/**
 * Reads a Windows Authenticode signature.
 *
 * The publisher is *discovered*, never assumed: this returns whatever Windows
 * reports, and the caller decides whether it matches an expectation that was
 * explicitly configured. No publisher name is hardcoded anywhere.
 *
 * Returns `null` off Windows, where Authenticode does not apply.
 */
export async function readAuthenticode(
  executablePath: string,
  processManager: ProcessManager = new ProcessManager(),
): Promise<AuthenticodeResult | null> {
  if (process.platform !== 'win32') return null;

  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${executablePath.replace(/'/g, "''")}'; ` +
    `[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ ` +
    `status = $s.Status.ToString(); subject = $s.SignerCertificate.Subject }))`;

  const result = await processManager.run({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    cwd: process.cwd(),
    timeoutMs: 60_000,
  });

  if (result.outcome !== 'completed' || result.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout.trim()) as { status?: string; subject?: string };
    const status = parsed.status ?? 'Unknown';
    return {
      status,
      subject: parsed.subject ?? null,
      valid: status === 'Valid',
    };
  } catch {
    return null;
  }
}

/**
 * Turns an Authenticode reading into a verdict.
 *
 * `expectedPublisher` is optional and unset by default. Until someone has
 * confirmed on a real Windows machine what these binaries are actually signed
 * with, the application records the observed subject rather than enforcing a
 * name it guessed.
 */
export function judgeAuthenticode(
  reading: AuthenticodeResult | null,
  expectedPublisher: string | undefined,
): IntegrityVerdict {
  if (!reading) {
    return {
      strategy: 'AUTHENTICODE',
      trustLevel: 'UNVERIFIED_BINARY_SOURCE',
      verified: false,
      detail: 'A assinatura não pôde ser lida neste sistema.',
    };
  }

  if (!reading.valid) {
    return {
      strategy: 'AUTHENTICODE',
      trustLevel: 'UNVERIFIED_BINARY_SOURCE',
      verified: false,
      detail: `O Windows reportou a assinatura como "${reading.status}".`,
      ...(reading.subject ? { observedPublisher: reading.subject } : {}),
    };
  }

  if (expectedPublisher) {
    const matches = (reading.subject ?? '').toLowerCase().includes(expectedPublisher.toLowerCase());
    if (!matches) {
      return {
        strategy: 'AUTHENTICODE',
        trustLevel: 'UNVERIFIED_BINARY_SOURCE',
        verified: false,
        detail: `Assinatura válida, mas de um publicador diferente do esperado (${expectedPublisher}).`,
        ...(reading.subject ? { observedPublisher: reading.subject } : {}),
      };
    }
  }

  return {
    strategy: 'AUTHENTICODE',
    trustLevel: 'VERIFIED',
    verified: true,
    detail: expectedPublisher
      ? 'Assinatura Authenticode válida e do publicador esperado.'
      : 'Assinatura Authenticode válida. O publicador foi registrado para conferência.',
    ...(reading.subject ? { observedPublisher: reading.subject } : {}),
  };
}

/** Picks the stronger of two verdicts, used when both a hash and a signature ran. */
export function strongestVerdict(a: IntegrityVerdict, b: IntegrityVerdict): IntegrityVerdict {
  if (a.verified && !b.verified) return a;
  if (b.verified && !a.verified) return b;
  // Both passed or both failed: prefer the signature, which says more.
  return a.strategy === 'AUTHENTICODE' ? a : b;
}
