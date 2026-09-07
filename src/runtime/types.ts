/**
 * Runtime management types.
 *
 * The product promise is that the user never installs anything by hand: no
 * Node, no npm, no PATH surgery, no terminal. That means the application owns
 * the agent runtimes itself, and every adapter asks this layer for an absolute
 * executable path rather than hoping the global PATH has one.
 */

import type { IntegrityStrategy, IntegrityVerdict, TrustLevel } from './integrity.js';
import type { VersionRequest } from './compatibility.js';

export type RuntimeId = 'codex' | 'claude-code' | 'git';

/**
 * How far a download source can be trusted.
 *
 * This is deliberately explicit. A host string found inside a shipped binary is
 * an implementation detail, not a supported interface, and must never quietly
 * become the foundation the installer is built on.
 */
export type ContractLevel =
  /** A published, supported way to obtain the runtime. */
  | 'DOCUMENTED'
  /** Depends on the internal layout of a package. Works, but can change. */
  | 'PACKAGE_INTERNAL'
  /** An implementation detail. Usable only as a controlled fallback. */
  | 'NOT_PUBLIC_CONTRACT';

export const CONTRACT_LABELS: Record<ContractLevel, string> = {
  DOCUMENTED: 'DOCUMENTED',
  PACKAGE_INTERNAL: 'PACKAGE INTERNAL',
  NOT_PUBLIC_CONTRACT: 'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT',
};

/** Target platform for a download. Kept explicit so it is testable off-Windows. */
export interface RuntimeTarget {
  platform: NodeJS.Platform;
  arch: 'x64' | 'arm64';
}

export type ArchiveKind = 'tgz' | 'zip' | 'raw';

/** A concrete, downloadable artifact resolved from a source. */
export interface ResolvedDownload {
  url: string;
  version: string;
  archiveKind: ArchiveKind;
  /**
   * Integrity value published by the source: an npm-style `sha512-<base64>`
   * string, or a bare SHA-256 hex digest, depending on the source's declared
   * strategy. When present it is verified and a mismatch aborts the install.
   */
  integrity?: string;
  /** Executable names to look for inside the extracted tree, in priority order. */
  executableNames: string[];
  /** Bytes, when the source advertises it. Used for progress reporting. */
  expectedBytes?: number;
}

/**
 * One way of obtaining a runtime.
 *
 * Sources are tried in order. An adapter never sees a URL: it sees a runtime,
 * which owns this list, so the acquisition strategy can change without touching
 * any adapter.
 */
export interface RuntimeSource {
  readonly id: string;
  readonly label: string;
  readonly contract: ContractLevel;
  /** How this source proves what it served. */
  readonly integrityStrategy: IntegrityStrategy;
  /**
   * Publisher expected on a signed binary, when one has been confirmed on a
   * real machine. Left unset rather than guessed: an unset expectation records
   * the observed publisher instead of enforcing an invented one.
   */
  readonly expectedPublisher?: string;
  /**
   * Returns a concrete download, or `null` when this source cannot serve the
   * request. Network failures throw.
   */
  resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null>;
}

/** Where a usable runtime was found, if anywhere. */
export type RuntimeOrigin =
  /** Installed and owned by this application. */
  | 'managed'
  /** A compatible installation already present on the machine. */
  | 'system'
  /** Not available. */
  | 'missing';

export interface RuntimeDetection {
  runtimeId: RuntimeId;
  origin: RuntimeOrigin;
  executablePath: string | null;
  version: string | null;
  /** Present when `origin === 'managed'`. */
  manifest: RuntimeManifest | null;
  /**
   * Why the executable found may not be used, when it may not: a version
   * outside the compatibility window. Absent when it is usable or missing.
   */
  incompatible?: string;
}

/** What the application records about a runtime it installed. */
export interface RuntimeManifest {
  runtimeId: RuntimeId;
  version: string;
  /** Which source produced it, and how trustworthy that source is. */
  sourceId: string;
  sourceLabel: string;
  contract: ContractLevel;
  /** Origin URL, kept for support and for the developer view. */
  url: string;
  host: string;
  platform: NodeJS.Platform;
  arch: string;
  bytes: number;
  sha256: string;
  /** What was actually proved about these bytes, and how. */
  integrity: IntegrityVerdict;
  trustLevel: TrustLevel;
  /** Executable path relative to the runtime's `current` directory. */
  executableRelativePath: string;
  installedAt: string;
  /** The version this install replaced, when it replaced one. */
  previousVersion?: string;
  /**
   * Variables this build's child processes must not inherit, proved on this
   * machine at install time (an `OPENSSL_ia32cap` that makes AWS-LC abort).
   */
  environment?: { drop: string[]; reason: string };
  /** Licence notices shipped with the runtime, relative to `current`. */
  licenseFiles?: string[];
}

export interface HealthStatus {
  healthy: boolean;
  version?: string;
  executablePath?: string;
  /** Short, user-facing explanation. Never a raw error string. */
  problem?: string;
  /** What the application can do about it, shown next to an action button. */
  remedy?: string;
  /** The record behind "Detalhes": what the executable did when run. */
  detail?: string;
}

/** Phases reported while a runtime is being prepared, for the progress UI. */
export type InstallPhase =
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'staging-health-check'
  | 'installing'
  | 'health-check'
  | 'rolled-back'
  | 'done';

export interface InstallProgress {
  runtimeId: RuntimeId;
  phase: InstallPhase;
  /** Ready to display, already localised to the product's voice. */
  message: string;
  /** 0-100 when known; omitted for indeterminate phases. */
  percent?: number;
}

export type ProgressReporter = (progress: InstallProgress) => void;

/** Options common to install, repair and update. */
export interface InstallOptions {
  /**
   * Cancels the work. The download aborts and the pipeline stops between
   * phases, so a cancelled install never promotes a half-finished build.
   */
  signal?: AbortSignal | undefined;
}


export interface InstallResult {
  runtimeId: RuntimeId;
  executablePath: string;
  manifest: RuntimeManifest;
  health: HealthStatus;
  /** True when a failed update was undone and the previous build restored. */
  rolledBack?: boolean;
}

/**
 * Raised when something the user might act on goes wrong.
 *
 * `userMessage` is what the interface shows; `detail` is for the developer
 * view. The interface must never surface "codex not found in PATH".
 */
export class RuntimeError extends Error {
  constructor(
    readonly runtimeId: RuntimeId,
    readonly userMessage: string,
    readonly remedy: string,
    readonly detail?: string,
  ) {
    super(`${runtimeId}: ${userMessage}${detail ? ` (${detail})` : ''}`);
    this.name = 'RuntimeError';
  }
}

/**
 * Raised when the only executable available is outside the compatibility
 * window - an old build on the PATH, or a managed install the policy has
 * since moved past. The application installs the tested version instead of
 * running it.
 */
export class RuntimeIncompatibleError extends RuntimeError {
  constructor(runtimeId: RuntimeId, displayName: string, version: string, reason: string) {
    super(
      runtimeId,
      `${displayName} ${version} não é compatível com esta versão do aplicativo. ${reason}`,
      'Atualizar automaticamente',
      `version ${version} is outside the compatibility window`,
    );
    this.name = 'RuntimeIncompatibleError';
  }
}

/** Raised when an adapter asks for an executable that is not installed yet. */
export class RuntimeNotReadyError extends RuntimeError {
  constructor(runtimeId: RuntimeId, displayName: string) {
    super(
      runtimeId,
      `${displayName} ainda não está configurado.`,
      'Configurar automaticamente',
      'no managed install and no compatible system installation was found',
    );
    this.name = 'RuntimeNotReadyError';
  }
}

/**
 * Raised when the user cancelled an installation.
 *
 * Distinct from a failure on purpose: the interface says "Cancelado", not
 * "Não foi possível configurar", and offers the action again rather than
 * apologising for something that went wrong.
 */
export class RuntimeInstallCancelledError extends RuntimeError {
  constructor(runtimeId: RuntimeId) {
    super(runtimeId, 'Instalação cancelada.', 'Configurar automaticamente', 'cancelled by the user');
    this.name = 'RuntimeInstallCancelledError';
  }
}
