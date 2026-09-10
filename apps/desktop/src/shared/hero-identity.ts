/** Presentation only: aliases never change the agent's persisted execution role. */
export const HEROES = {
  orchestrator: { asset: 'orchestrator-white-mage', title: 'Arquimago', role: 'Orquestrador', rune: '✦' },
  programmer: { asset: 'programmer-arcane-smith', title: 'Ferreiro Arcano', role: 'Programador', rune: '⚒' },
  analyst: { asset: 'analyst-scholar', title: 'Erudito', role: 'Analista', rune: '◇' },
  designer: { asset: 'designer-bard', title: 'Bardo Artista', role: 'Designer', rune: '✧' },
  tester: { asset: 'tester-guardian', title: 'Cavaleiro Guardião', role: 'Testador', rune: '✓' },
  researcher: { asset: 'researcher-explorer', title: 'Explorador Alquimista', role: 'Pesquisador', rune: '⌖' },
  image: { asset: 'image-generator-illusionist', title: 'Ilusionista', role: 'Gerador de imagens', rune: '▧' },
} as const;
export type HeroKey = keyof typeof HEROES;
export type HeroState = 'idle' | 'working' | 'success' | 'blocked' | 'needs-human' | 'offline';
export function heroKey(role: string): HeroKey | null {
  const key = role.toUpperCase().replace(/[ -]/g, '_');
  const aliases: Record<string, HeroKey> = {
    ORCHESTRATOR: 'orchestrator', CODING_WORKER: 'programmer', PROGRAMMER: 'programmer', WORKER: 'programmer',
    ANALYST: 'analyst', REVIEWER: 'analyst', REVIEW: 'analyst', DESIGNER: 'designer',
    TESTER: 'tester', RESEARCHER: 'researcher', IMAGE_GENERATOR: 'image',
  };
  return aliases[key] ?? null;
}
export function heroState(status: string): HeroState {
  const key = status.toLowerCase().replace(/_/g, '-');
  if (['running', 'started', 'working', 'executing'].includes(key)) return 'working';
  if (['done', 'completed', 'success', 'passed', 'succeeded'].includes(key)) return 'success';
  if (['needs-human', 'paused', 'waiting-human'].includes(key)) return 'needs-human';
  if (['blocked', 'failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(key)) return 'blocked';
  if (['offline', 'disabled', 'unavailable'].includes(key)) return 'offline';
  return 'idle';
}
export const HERO_STATE_LABELS: Record<HeroState, string> = {
  idle: 'Aguardando', working: 'Executando', success: 'Concluído', blocked: 'Bloqueado',
  'needs-human': 'Precisa de você', offline: 'Offline',
};
export function questStatus(status: string): string {
  const labels: Record<string, string> = {
    running: 'Executando', started: 'Executando', pending: 'Aguardando', queued: 'Aguardando',
    read: 'Registrado', idle: 'Aguardando', done: 'Concluído', completed: 'Concluído', passed: 'Validado',
    failed: 'Falhou', error: 'Erro', blocked: 'Bloqueado', partial: 'Parcial', stopped: 'Interrompido',
    cancelled: 'Cancelado', canceled: 'Cancelado', 'needs-human': 'Precisa de você', paused: 'Pausado',
  };
  return labels[status.toLowerCase().replace(/_/g, '-')] ?? status;
}

/** Compact presentation only; source messages remain available in full. */
export function briefText(text: string, limit = 160): string {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const prefix = value.slice(0, Math.max(0, limit - 1));
  const breakAt = prefix.lastIndexOf(' ');
  return (breakAt > limit * .6 ? prefix.slice(0, breakAt) : prefix) + '…';
}
