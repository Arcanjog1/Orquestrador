import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { RouterProvider, useRouter } from "@/router";
import { WorkspacePage } from "@/pages/Workspace";
import { OnboardingPage } from "@/pages/Onboarding";
import { SettingsPage } from "@/pages/Settings";
import { HistoryPage } from "@/pages/History";
import { bridgeAvailable, useChannel } from "@/lib/bridge";

/**
 * The app shell.
 *
 * Holds the one piece of state every page needs - `app:state` - and refreshes
 * it whenever main says something changed, so no page keeps its own copy of a
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

function Shell() {
  const router = useRouter();
  const state = useChannel("app:state", undefined, { refreshOn: ["app:stateChanged"] });

  // First run goes to onboarding rather than an empty workspace.
  useEffect(() => {
    if (state.loading || !state.data) return;
    if (!state.data.onboarded && router.path === "/" && state.data.workspaces.length === 0) {
      router.navigate("/onboarding");
    }
  }, [state.loading, state.data, router]);

  if (!bridgeAvailable()) {
    return (
      <Fatal
        title="A ponte com o aplicativo não carregou"
        detail="Feche e abra o AI Orchestrator novamente."
      />
    );
  }

  if (state.error) {
    return <Fatal title="Não foi possível iniciar" detail={state.error} />;
  }

  if (state.loading && !state.data) {
    return (
      <div className="grid h-screen place-items-center bg-background">
        <span className="text-sm text-muted-foreground">Carregando…</span>
      </div>
    );
  }

  const props = { state: state.data, reloadState: state.reload };

  switch (router.path) {
    case "/onboarding":
      return <OnboardingPage {...props} />;
    case "/configuracoes":
      return <SettingsPage {...props} />;
    case "/historico":
      return <HistoryPage state={state.data} />;
    default:
      return <WorkspacePage {...props} />;
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
