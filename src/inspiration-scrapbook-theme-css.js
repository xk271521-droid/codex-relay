import { ENFP_THEME_CSS } from "./enfp-theme-css.js";

// The shared ENFP foundation keeps native controls, responsive breakpoints, and
// lifecycle-safe DOM handling consistent. This layer deliberately owns only the
// second theme's visual language, so it can evolve without changing the first preset.
export const INSPIRATION_SCRAPBOOK_THEME_CSS = `${ENFP_THEME_CSS}

:root.codex-relay-skin {
  --cr-theme-accent: oklch(0.64 0.145 184);
  --cr-theme-accent-ink: oklch(0.99 0.006 184);
  --cr-theme-canvas: oklch(0.986 0.018 90);
  --cr-theme-surface: oklch(0.995 0.012 91);
  --cr-theme-surface-raised: oklch(1 0.006 92);
  --cr-theme-sidebar: oklch(0.978 0.021 100);
  --cr-theme-text: oklch(0.29 0.045 178);
  --cr-theme-text-muted: oklch(0.48 0.045 178);
  --cr-theme-line: oklch(0.8 0.065 173);
  --cr-theme-line-soft: color-mix(in oklab, var(--cr-theme-accent) 26%, transparent);
  --cr-theme-accent-soft: color-mix(in oklab, var(--cr-theme-accent) 12%, var(--cr-theme-surface-raised));
  --cr-theme-accent-hover: color-mix(in oklab, var(--cr-theme-accent) 22%, var(--cr-theme-surface-raised));
  --cr-theme-coral: oklch(0.68 0.18 28);
  --cr-theme-amber: oklch(0.81 0.16 82);
  --cr-theme-sky: oklch(0.7 0.13 232);
  --cr-theme-violet: oklch(0.67 0.14 305);
  --cr-theme-composer: color-mix(in oklab, oklch(1 0.008 92) 95%, var(--cr-theme-accent) 5%);
  --cr-theme-immersive-sidebar: color-mix(in oklab, var(--cr-theme-sidebar) 95%, transparent);
  --cr-theme-immersive-edge: color-mix(in oklab, var(--cr-theme-surface) 95%, transparent);
  --cr-theme-immersive-mid: color-mix(in oklab, var(--cr-theme-surface) 76%, transparent);
  --cr-theme-immersive-far: color-mix(in oklab, var(--cr-theme-surface) 22%, transparent);
}

html.codex-relay-skin body {
  font-family: "Segoe UI Variable Text", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif !important;
  background-color: var(--cr-theme-canvas) !important;
}

html.codex-relay-skin aside.app-shell-left-panel {
  background-image: linear-gradient(180deg, color-mix(in oklab, #fffdf6 92%, transparent), var(--cr-theme-sidebar)) !important;
}

html.codex-relay-skin aside.app-shell-left-panel :where(button, a, [role="button"]):hover,
html.codex-relay-skin aside.app-shell-left-panel [aria-current="page"] {
  color: oklch(0.38 0.115 182) !important;
  background: linear-gradient(90deg, color-mix(in oklab, var(--cr-theme-accent) 16%, #fffdf6), color-mix(in oklab, var(--cr-theme-amber) 14%, #fffdf6)) !important;
}

html.codex-relay-skin.cr-theme-art-wide main.main-surface.cr-theme-home-shell {
  background: linear-gradient(90deg, var(--cr-theme-immersive-edge) 0%, var(--cr-theme-immersive-mid) 58%, var(--cr-theme-immersive-far) 100%) !important;
}

.cr-theme-home [data-feature="game-source"] {
  border: 1px solid color-mix(in oklab, var(--cr-theme-accent) 34%, #fff) !important;
  border-radius: 26px !important;
  box-shadow: 0 18px 44px color-mix(in oklab, var(--cr-theme-accent) 13%, transparent), inset 0 1px 0 #fff !important;
}

.cr-theme-home [data-feature="game-source"]::after {
  color: oklch(0.44 0.09 178) !important;
  text-shadow: 0 1px 0 #fff !important;
}

.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button,
.cr-theme-fallback-action {
  border-radius: 20px !important;
  border-color: color-mix(in oklab, var(--cr-theme-accent) 30%, #fff) !important;
  background: color-mix(in oklab, #fff 92%, var(--cr-theme-accent) 8%) !important;
  box-shadow: 0 8px 22px color-mix(in oklab, var(--cr-theme-accent) 11%, transparent), inset 0 1px 0 #fff !important;
}

.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button:nth-child(1),
.cr-theme-fallback-action:nth-child(1) { --cr-scrapbook-card: #ff876d; }
.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button:nth-child(2),
.cr-theme-fallback-action:nth-child(2) { --cr-scrapbook-card: #1bb3a4; }
.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button:nth-child(3),
.cr-theme-fallback-action:nth-child(3) { --cr-scrapbook-card: #42a9df; }
.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button:nth-child(4),
.cr-theme-fallback-action:nth-child(4) { --cr-scrapbook-card: #eab636; }

.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button,
.cr-theme-fallback-action {
  box-shadow: inset 0 4px 0 var(--cr-scrapbook-card, var(--cr-theme-accent)), 0 8px 22px color-mix(in oklab, var(--cr-scrapbook-card, var(--cr-theme-accent)) 14%, transparent), inset 0 1px 0 #fff !important;
}

.cr-theme-home :is(.group\\/home-suggestions, [class*="home-suggestions"]) button:hover,
.cr-theme-fallback-action:hover {
  transform: translateY(-3px) rotate(-.25deg) !important;
  background: color-mix(in oklab, #fff 87%, var(--cr-scrapbook-card, var(--cr-theme-accent)) 13%) !important;
}

.cr-theme-fallback-action-icon {
  color: #fff !important;
  background: var(--cr-scrapbook-card, var(--cr-theme-accent)) !important;
  box-shadow: 0 6px 14px color-mix(in oklab, var(--cr-scrapbook-card, var(--cr-theme-accent)) 28%, transparent) !important;
}

html.codex-relay-skin .composer-surface-chrome,
html.codex-relay-skin .cr-theme-home-utility {
  border-color: color-mix(in oklab, var(--cr-theme-accent) 42%, #fff) !important;
  box-shadow: 0 12px 30px color-mix(in oklab, var(--cr-theme-accent) 12%, transparent), inset 0 1px 0 #fff !important;
}

html.codex-relay-skin .composer-surface-chrome [data-placeholder]::before,
html.codex-relay-skin .composer-surface-chrome .ProseMirror p.is-editor-empty:first-child::before,
html.codex-relay-skin .composer-surface-chrome .ProseMirror p.placeholder::after {
  color: oklch(0.47 0.045 178) !important;
  opacity: 1 !important;
}

html.codex-relay-skin button[class~="bg-token-foreground"] {
  background: linear-gradient(135deg, var(--cr-theme-accent), oklch(0.67 0.135 208)) !important;
  box-shadow: 0 7px 15px color-mix(in oklab, var(--cr-theme-accent) 34%, transparent) !important;
}

html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) {
  background: linear-gradient(135deg, color-mix(in oklab, #fffdf4 95%, var(--cr-theme-accent)), color-mix(in oklab, #fffdf4 92%, var(--cr-theme-amber))) !important;
}
`;
