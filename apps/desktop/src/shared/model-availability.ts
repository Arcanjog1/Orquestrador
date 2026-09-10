export type ModelAvailability = 'CONFIRMED_FOR_ACCOUNT' | 'KNOWN_BUT_UNVERIFIED' | 'UNAVAILABLE';
export const MODEL_AVAILABILITY_LABELS: Record<ModelAvailability, string> = {
  CONFIRMED_FOR_ACCOUNT: 'Disponível nesta conta',
  KNOWN_BUT_UNVERIFIED: 'Disponível no catálogo — ainda não verificado nesta conta',
  UNAVAILABLE: 'Indisponível nesta conta',
};
export const availabilityOf = (allowed: boolean | null): ModelAvailability =>
  allowed === true ? 'CONFIRMED_FOR_ACCOUNT' : allowed === false ? 'UNAVAILABLE' : 'KNOWN_BUT_UNVERIFIED';
export interface AccountModelVerification {
  accountId: string;
  provider: 'openai' | 'anthropic';
  checkedAt: string;
  confirmed: string[];
  denied: string[];
  detail: string;
}
