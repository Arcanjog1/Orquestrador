import { useEffect, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { reasoningLabel, selectionLabel } from '@/lib/orchestrator-data';
import type { ManagedAgentView, WorkspaceView } from '@shared/ipc-contract';
import { HEROES, heroKey, heroState } from '@shared/hero-identity';
import { HeroPortrait } from './HeroPortrait';
import type { AgentStatus } from './ActivityPanel';

/** Configured project roster, separate from the run's recorded participants. */
export function GuildTeam({ workspace, statuses, onEdit, onManage }: {
  workspace: WorkspaceView; statuses: readonly AgentStatus[];
  onEdit: () => void; onManage: () => void;
}) {
  const [agents, setAgents] = useState<readonly ManagedAgentView[]>([]);
  useEffect(() => {
    let current = true;
    void api.agents.manage().then(rows => { if (current) setAgents(rows); }).catch(() => { if (current) setAgents([]); });
    return () => { current = false; };
  }, [workspace]);
  const members = [workspace.team.orchestrator, ...workspace.team.workers].filter(m => m.agentId);
  return <section className="guild-team guild-paper" aria-label="Equipe configurada" data-testid="guild-team">
    <header className="guild-panel-heading"><div><h2><Users size={18}/> Equipe de agentes</h2><p>Equipe deste projeto.</p></div>
      <button onClick={onManage} className="guild-create"><Plus size={15}/> Gerenciar</button></header>
    <div className="guild-team-grid">
      {members.map((member, index) => {
        const agent = agents.find(a => a.id === member.agentId);
        const status = statuses.find(a => a.agentId === member.agentId);
        const role = agent?.role ?? status?.role ?? member.role;
        const hero = HEROES[heroKey(role) ?? 'programmer'];
        const name = agent?.name ?? status?.name ?? hero.role;
        const state = status ? heroState(status.status) : 'idle';
        const statusLabel = !status ? 'Status indisponível' : status.status === 'idle' ? 'Disponível' : status.status === 'running' ? 'Em execução' : status.status === 'offline' ? 'Desconectado' : 'Bloqueado';
        return <button key={`${member.agentId}-${index}`} className="guild-team-card" onClick={onEdit} aria-label={`Editar equipe: ${name}`}>
          <div className="guild-team-identity"><HeroPortrait role={role} state={state} variant="sprite" size={90}/><div><h3 title={name}>{name}</h3><span data-status={status?.status}>{statusLabel}</span></div></div>
          <dl><dt>Função</dt><dd>{hero.role}</dd><dt>Conta</dt><dd title={member.accountName ?? undefined}>{member.accountName ?? 'Não definida'}</dd><dt>Provedor</dt><dd>{member.provider}</dd><dt>Modelo</dt><dd>{member.selection === 'manual' ? member.model ?? 'Padrão do CLI' : selectionLabel(member.selection)}</dd><dt>Raciocínio</dt><dd>{member.selection === 'manual' ? reasoningLabel(member.reasoning) ?? 'Automático' : 'Automático'}</dd></dl>
        </button>;
      })}
      {members.length === 0 && <div className="guild-team-empty"><HeroPortrait role="ORCHESTRATOR" variant="sprite" size={112}/><p>Monte sua equipe para começar.</p></div>}
    </div>
    <button className="guild-team-edit" onClick={onEdit}><Users size={14}/> Editar equipe</button>
  </section>;
}
