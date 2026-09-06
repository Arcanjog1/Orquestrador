/**
 * The theme, applied for real.
 *
 * styles.css defines dark as the base palette and `.light` as the other one;
 * index.html starts with `class="dark"`. Applying a theme means putting the
 * right class on the root element, which is all the tokens need. "System"
 * follows the OS and keeps following it while the window is open.
 */

export const THEMES = ["Dark", "Light", "System"] as const;
export type ThemeName = (typeof THEMES)[number];

let stopFollowingSystem: (() => void) | null = null;

export function applyTheme(name: string | null | undefined): void {
  const theme: ThemeName = name === "Light" || name === "System" ? name : "Dark";
  stopFollowingSystem?.();
  stopFollowingSystem = null;

  const set = (light: boolean) => {
    const root = document.documentElement;
    root.classList.toggle("light", light);
    root.classList.toggle("dark", !light);
    root.style.colorScheme = light ? "light" : "dark";
  };

  if (theme === "System") {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    set(query?.matches ?? false);
    if (query) {
      const listener = (event: MediaQueryListEvent) => set(event.matches);
      query.addEventListener("change", listener);
      stopFollowingSystem = () => query.removeEventListener("change", listener);
    }
    return;
  }
  set(theme === "Light");
}
