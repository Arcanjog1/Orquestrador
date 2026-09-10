import { useState } from 'react';
import { HEROES, HERO_STATE_LABELS, heroKey, type HeroState } from '@shared/hero-identity';

/** One stable asset per identity. States are lightweight CSS, avatars crop the same sprite.
 * Missing assets have an explicit fallback; no network or execution dependencies. */
export function HeroPortrait({ role, state = 'idle', variant = 'avatar', size = 40 }: {
  role: string; state?: HeroState; variant?: 'avatar' | 'sprite'; size?: number;
}) {
  const key = heroKey(role);
  const hero = key ? HEROES[key] : null;
  const [failedSource, fail] = useState<string | null>(null);
  const source = hero ? `./assets/heroes/${hero.asset}.png` : null;
  const fallback = !source || failedSource === source;
  return <span className={`hero-portrait hero-${variant}`} data-hero={key ?? 'unknown'} data-state={state}
    data-placeholder={fallback ? 'true' : undefined} style={{ width: size, height: size }}
    role="img" aria-label={`${hero?.title ?? role} · ${HERO_STATE_LABELS[state]}${fallback ? ' · ícone provisório' : ''}`}>
    {fallback ? <span className="hero-fallback" title="Ícone provisório">{hero?.rune ?? '◇'}</span>
      : <img src={source!} alt="" aria-hidden="true" draggable={false} onError={() => fail(source)} />}
    <span className="hero-state-mark" aria-hidden="true">{state === 'success' ? '✓' : state === 'needs-human' ? '!' : state === 'blocked' ? '×' : state === 'working' ? hero?.rune : ''}</span>
  </span>;
}

export function GuildBanner({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="guild-banner">
    <span className="guild-lantern" aria-hidden="true"><i /></span>
    <div><p className="guild-eyebrow">AI ORCHESTRATOR · GUILDA DE AGENTES</p><h1>{title}</h1><p>{subtitle}</p></div>
    <span className="guild-sigil" aria-hidden="true">✦</span>
  </header>;
}
