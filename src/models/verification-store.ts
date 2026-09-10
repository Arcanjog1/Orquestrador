/**
 * Where an account's model verification is remembered.
 *
 * The store is keyed by `accountId` and enforces it on the way out: a record
 * that does not carry the requested account's id is discarded rather than
 * returned. Cross-account leakage is the one failure this whole feature exists
 * to prevent, so it is checked at the boundary and not only at the call sites.
 */

import type { AccountModelVerification } from './model-types.js';

export interface ModelVerificationStore {
  read(accountId: string): AccountModelVerification | null;
  write(record: AccountModelVerification): void;
  clear(accountId: string): void;
}

export class InMemoryVerificationStore implements ModelVerificationStore {
  private readonly records = new Map<string, AccountModelVerification>();

  read(accountId: string): AccountModelVerification | null {
    const record = this.records.get(accountId);
    if (!record) return null;
    return record.accountId === accountId ? record : null;
  }

  write(record: AccountModelVerification): void {
    this.records.set(record.accountId, record);
  }

  clear(accountId: string): void {
    this.records.delete(accountId);
  }
}

/** The slice of the settings repository this store needs. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const KEY_PREFIX = 'models.verification.';

/**
 * Persists verifications in the settings table.
 *
 * Only ids and outcomes are stored - never a token, never anything read out of
 * a credential file.
 */
export class SettingsVerificationStore implements ModelVerificationStore {
  constructor(private readonly settings: KeyValueStore) {}

  read(accountId: string): AccountModelVerification | null {
    const raw = this.settings.get(KEY_PREFIX + accountId);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as AccountModelVerification;
    // A record filed under the wrong key is a bug; never answer with it.
    return record.accountId === accountId ? record : null;
  }

  write(record: AccountModelVerification): void {
    this.settings.set(KEY_PREFIX + record.accountId, JSON.stringify(record));
  }

  clear(accountId: string): void {
    this.settings.set(KEY_PREFIX + accountId, '');
  }
}
