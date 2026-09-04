import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { RouterProvider, useRouter } from "@/router";
import { WorkspacePage } from "@/pages/Workspace";
import { OnboardingPage } from "@/pages/Onboarding";
import { SettingsPage } from "@/pages/Settings";
import { HistoryPage } from "@/pages/History";
import { api, messageOf } from "@/lib/api";
import type {
  AccountView,
  AgentView,
  AppInfo,
  DiagnosticView,
  WorkspaceView,
} from "@shared/ipc-contract";

/**
 * The app shell.
 *
 * Holds the state every page needs - app info, diagnostics, accounts, agents,
 * workspaces - and reloads it on demand, so no page keeps its own copy of a
 * fact the main process owns.
 */
export function App() {
  return (
    <RouterProvider>
      <Shell />
      <Toaster />
    </RouterProvider>
  );
}

interface AppState {
  appInfo: AppInfo | null;
  diagnostics: DiagnosticView | null;
  accounts: readonly AccountView[];
  agents: readonly AgentView[];
  workspaces: readonly WorkspaceView[];
}

const EMPTY: AppState = {
  appInfo: null,
  diagnostics: null,
  accounts: [],
  agents: [],
  workspaces: [],
};

function Shell() {
  const router = useRouter();
  const [state, setState] = useState<AppState>(EMPTY);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redirected, setRedirected] = useState(false);

  const reload = useCallback(() => {
    void (async () => {
      try {
        const [appInfo, diagnostics, accounts, agents, workspaces] = await Promise.all([
          api.app.info(),
          api.runtime.diagnose(),
          api.accounts.list(),
          api.agents.list(),
          api.workspace.list(),
        ]);
        setState({ appInfo, diagnostics, accounts, agents, workspaces });
        setWorkspaceId((current) =>
          current && workspaces.some((w) => w.id === current) ? current : workspaces[0]?.id ?? null,
        );
        setError(null);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(reload, [reload]);

  // First run goes to onboarding rather than an empty workspace, once only.
  useEffect(() => {
    if (loading || redirected) return;
    setRedirected(true);
    const ready =
      (state.diagnostics?.ready ?? false) &&
      state.accounts.some((a) => a.state === "connected") &&
      state.workspaces.length > 0;
    if (!ready && router.path === "/") router.navigate("/onboarding");
  }, [loading, redirected, state, router]);

  if (typeof window === "undefined" || !window.api) {
    return (
      <Fatal
        title="A ponte com o aplicativo não carregou"
        detail="Feche e abra o AI Orchestrator novamente."
      />
    );
  }

  if (loading) {
    return (
      <div className="grid h-screen place-items-center bg-background">
        <span className="text-sm text-muted-foreground">Carregando…</span>
      </div>
    );
  }

  if (error) return <Fatal title="Não foi possível iniciar" detail={error} />;

  const workspace = state.workspaces.find((w) => w.id === workspaceId) ?? null;

  switch (router.path) {
    case "/onboarding":
      return (
        <OnboardingPage
          diagnostics={state.diagnostics}
          accounts={state.accounts}
          agents={state.agents}
          workspaces={state.workspaces}
          workspace={workspace}
          reload={reload}
          onSelectWorkspace={setWorkspaceId}
        />
      );
    case "/configuracoes":
      return (
        <SettingsPage
          accounts={state.accounts}
          workspace={workspace}
          diagnostics={state.diagnostics}
          appInfo={state.appInfo}
          reload={reload}
        />
      );
    case "/historico":
      return <HistoryPage workspace={workspace} />;
    default:
      return (
        <WorkspacePage
          workspaces={state.workspaces}
          workspace={workspace}
          accounts={state.accounts}
          agents={state.agents}
          reload={reload}
          onSelectWorkspace={setWorkspaceId}
        />
      );
  }
}

function Fatal({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
