/**
 * The working screen: projects and accounts on the left, chat on the right.
 *
 * Deliberately plain. The point of this phase is that the whole path — add a
 * project, pick who supervises and who executes, send a task, watch the loop
 * run — works without a terminal, not that it looks finished.
 */

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api.js';
import type {
  AccountView,
  AgentView,
  ChatMessageView,
  ChatSessionView,
  RunView,
  WorkspaceView,
} from '../shared/ipc-contract.js';

export function Workbench({ onBack }: { onBack: () => void }): ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [ws, accs, ags] = await Promise.all([
        api.workspace.list(),
        api.accounts.list(),
        api.agents.list(),
      ]);
      setWorkspaces(ws as WorkspaceView[]);
      setAccounts(accs as AccountView[]);
      setAgents(ags as AgentView[]);
      setSelected((current) => current ?? ws[0]?.id ?? null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const workspace = workspaces.find((w) => w.id === selected) ?? null;

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', height: '100%' }}
    >
      <aside
        className="col"
        style={{
          borderRight: '1px solid var(--line)',
          padding: 14,
          overflowY: 'auto',
          // A flex item refuses to shrink below its content by default, which
          // pushes the buttons out of a fixed-width sidebar.
          minWidth: 0,
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>AI Orchestrator</strong>
          <button onClick={onBack}>Runtimes</button>
        </div>

        <Accounts accounts={accounts} onChanged={reload} />
        <Projects
          workspaces={workspaces}
          selected={selected}
          onSelect={setSelected}
          onChanged={reload}
        />
        {workspace ? <AgentPicker workspace={workspace} agents={agents} onChanged={reload} /> : null}
        {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : null}
      </aside>

      {workspace ? (
        <Chat workspace={workspace} />
      ) : (
        <div className="col" style={{ padding: 24 }}>
          <p className="muted">Adicione um projeto para começar.</p>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- accounts */

function Accounts({
  accounts,
  onChanged,
}: {
  accounts: AccountView[];
  onChanged: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Record<string, string>>({});

  useEffect(
    () =>
      api.events.accountProgress((event) => {
        setStage((current) => ({ ...current, [event.accountId]: event.label }));
      }),
    [],
  );

  const create = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    setBusy(true);
    try {
      await api.accounts.create({ name: name.trim() });
      setName('');
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const connect = async (accountId: string): Promise<void> => {
    setBusy(true);
    try {
      await api.accounts.connect({ accountId });
      await onChanged();
    } catch (err) {
      setStage((current) => ({ ...current, [accountId]: messageOf(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card col">
      <strong>Contas</strong>
      {accounts.length === 0 ? <span className="muted">Nenhuma conta ainda.</span> : null}
      {accounts.map((account) => (
        <div key={account.id} className="col" style={{ gap: 2 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row">
              <span className={`dot ${account.state === 'connected' ? 'ok' : 'warn'}`} />
              {account.name}
            </span>
            <button onClick={() => void connect(account.id)} disabled={busy}>
              {account.state === 'connected' ? 'Reconectar' : 'Conectar Anthropic'}
            </button>
          </div>
          <span className="muted">{stage[account.id] ?? account.detail}</span>
        </div>
      ))}
      <div className="row">
        <input
          placeholder="Claude Trabalho"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={() => void create()} disabled={busy || name.trim().length === 0}>
          Adicionar
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- projects */

function Projects({
  workspaces,
  selected,
  onSelect,
  onChanged,
}: {
  workspaces: WorkspaceView[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState('');

  const addFolder = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.workspace.selectFolder();
      if (!path) return;
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'Projeto';
      await api.workspace.create({ name, localPath: path });
      await onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const clone = async (): Promise<void> => {
    if (repositoryUrl.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.workspace.selectFolder();
      if (!path) return;
      const name = repositoryUrl.trim().split('/').pop()?.replace(/\.git$/, '') ?? 'projeto';
      await api.workspace.clone({ repositoryUrl: repositoryUrl.trim(), parentPath: path, name });
      setRepositoryUrl('');
      await onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card col">
      <strong>Projetos</strong>
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          onClick={() => onSelect(workspace.id)}
          style={{
            textAlign: 'left',
            borderColor: workspace.id === selected ? 'var(--accent)' : 'var(--line)',
          }}
        >
          {workspace.name}
          <br />
          <span className="muted" style={{ fontSize: 12 }}>
            {workspace.localPath}
          </span>
        </button>
      ))}
      <button onClick={() => void addFolder()} disabled={busy}>
        Selecionar pasta
      </button>
      <div className="row">
        <input
          placeholder="https://github.com/..."
          value={repositoryUrl}
          onChange={(e) => setRepositoryUrl(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={() => void clone()} disabled={busy}>
          Clonar
        </button>
      </div>
      {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ agents */

function AgentPicker({
  workspace,
  agents,
  onChanged,
}: {
  workspace: WorkspaceView;
  agents: AgentView[];
  onChanged: () => Promise<void>;
}): ReactElement {
  const orchestrators = agents.filter((a) => a.role === 'ORCHESTRATOR');
  const workers = agents.filter((a) => a.role === 'CODING_WORKER');
  const [orchestrator, setOrchestrator] = useState(
    workspace.orchestratorAgentId ?? orchestrators[0]?.id ?? '',
  );
  const [worker, setWorker] = useState(workspace.workerAgentId ?? workers[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrchestrator(workspace.orchestratorAgentId ?? orchestrators[0]?.id ?? '');
    setWorker(workspace.workerAgentId ?? workers[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, agents.length]);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.workspace.setAgents({
        workspaceId: workspace.id,
        orchestratorAgentId: orchestrator,
        workerAgentId: worker,
      });
      await onChanged();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <section className="card col">
      <strong>Agentes deste projeto</strong>
      <label className="col" style={{ gap: 2 }}>
        <span className="muted">Supervisiona</span>
        <select value={orchestrator} onChange={(e) => setOrchestrator(e.target.value)}>
          {orchestrators.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="col" style={{ gap: 2 }}>
        <span className="muted">Executa</span>
        <select value={worker} onChange={(e) => setWorker(e.target.value)}>
          {workers.length === 0 ? <option value="">Conecte uma conta Claude</option> : null}
          {workers.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => void save()} disabled={!orchestrator || !worker}>
        Salvar
      </button>
      {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : null}
    </section>
  );
}

/* -------------------------------------------------------------------- chat */

function Chat({ workspace }: { workspace: WorkspaceView }): ReactElement {
  const [session, setSession] = useState<ChatSessionView | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string>('');
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const existing = (await api.chat.listSessions({ workspaceId: workspace.id })) as ChatSessionView[];
      const active =
        existing[0] ??
        ((await api.chat.createSession({ workspaceId: workspace.id, title: 'Conversa' })) as ChatSessionView);
      if (cancelled) return;
      setSession(active);
      setMessages((await api.chat.listMessages({ sessionId: active.id })) as ChatMessageView[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  useEffect(
    () =>
      api.events.runProgress((event) => {
        setStatus(event.status === 'RUNNING' ? event.label : '');
        if (event.message) {
          setMessages((current) =>
            current.some((m) => m.id === event.message!.id) ? current : [...current, event.message!],
          );
        }
        if (event.status !== 'RUNNING') {
          setRun((current) => (current ? { ...current, status: event.status } : current));
        }
      }),
    [],
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, status]);

  const send = async (): Promise<void> => {
    if (!session || text.trim().length === 0) return;
    setError(null);
    const body = text.trim();
    setText('');
    try {
      const result = await api.chat.sendMessage({ sessionId: session.id, text: body });
      setMessages((current) => [...current, result.message]);
      setRun(result.run);
      setStatus('Analisando...');
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const running = status.length > 0;

  return (
    <div className="col" style={{ height: '100%', padding: 16, gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="col" style={{ gap: 0 }}>
          <strong>{workspace.name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {workspace.localPath}
          </span>
        </div>
        {running && run ? (
          <button onClick={() => void api.run.cancel({ runId: run.id })} data-testid="cancel-run">
            Cancelar
          </button>
        ) : null}
      </div>

      <div className="card col" style={{ flex: 1, overflowY: 'auto' }} data-testid="messages">
        {messages.map((message) => (
          <div key={message.id} className="col" style={{ gap: 0 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {authorLabel(message.author)}
            </span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span>
          </div>
        ))}
        {running ? (
          <span className="muted" data-testid="status">
            {status}
          </span>
        ) : null}
        <div ref={bottom} />
      </div>

      {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : null}

      <div className="row">
        <input
          placeholder="Digite sua mensagem..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void send();
          }}
          style={{ flex: 1 }}
          data-testid="composer"
        />
        <button className="primary" onClick={() => void send()} disabled={!session}>
          Enviar
        </button>
      </div>
    </div>
  );
}

function authorLabel(author: string): string {
  switch (author) {
    case 'user':
      return 'Você';
    case 'orchestrator':
      return 'Codex';
    case 'worker':
      return 'Claude Code';
    default:
      return 'Sistema';
  }
}
