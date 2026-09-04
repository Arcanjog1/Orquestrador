/**
 * A hash router.
 *
 * The prototype ran on TanStack Start, which is a server-rendered stack: it has
 * no place in a packaged desktop app loading from `file://`, where there is no
 * server and history routing does not resolve. This replaces it with the
 * smallest thing that keeps the design's own navigation API intact - `<Link to
 * search>`, `useSearch`, `navigate` - so every page's markup is unchanged.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

export type RoutePath = "/" | "/onboarding" | "/configuracoes" | "/historico";

const ROUTES: RoutePath[] = ["/", "/onboarding", "/configuracoes", "/historico"];

export interface Location {
  path: RoutePath;
  search: Record<string, string>;
}

function parse(hash: string): Location {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const candidate = (pathPart || "/") as RoutePath;
  const path = ROUTES.includes(candidate) ? candidate : "/";
  const search: Record<string, string> = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) search[key] = value;
  }
  return { path, search };
}

function serialise(path: RoutePath, search?: Record<string, string>): string {
  const query = new URLSearchParams(search ?? {}).toString();
  return `#${path}${query ? `?${query}` : ""}`;
}

interface RouterValue extends Location {
  navigate: (path: RoutePath, search?: Record<string, string>) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setLocation(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((path: RoutePath, search?: Record<string, string>) => {
    window.location.hash = serialise(path, search);
  }, []);

  const value = useMemo<RouterValue>(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter usado fora do RouterProvider");
  return value;
}

/** The current route's query string, typed by the caller. */
export function useSearch<T extends Record<string, string>>(): Partial<T> {
  return useRouter().search as Partial<T>;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: RoutePath;
  search?: Record<string, string>;
}

/**
 * Same props as the design used, so no page markup had to change.
 *
 * Renders a real anchor (the design styles some links as anchors) but keeps
 * navigation inside the hash, never letting the renderer leave its own page.
 */
export function Link({ to, search, onClick, ...props }: LinkProps) {
  return (
    <a
      href={serialise(to, search)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        window.location.hash = serialise(to, search);
      }}
      {...props}
    />
  );
}
