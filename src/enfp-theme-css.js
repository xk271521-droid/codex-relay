export const ENFP_THEME_CSS = `
:root.codex-relay-skin {
  color-scheme: light !important;
  --cr-theme-accent: oklch(0.63 0.13 180);
  --cr-theme-accent-ink: oklch(0.99 0.004 180);
  --cr-theme-art-position: 78% 44%;
  --cr-theme-canvas: oklch(0.975 0.012 160);
  --cr-theme-surface: oklch(0.985 0.009 160);
  --cr-theme-surface-raised: oklch(0.995 0.005 160);
  --cr-theme-sidebar: oklch(0.966 0.012 165);
  --cr-theme-text: oklch(0.28 0.045 190);
  --cr-theme-text-muted: oklch(0.46 0.038 185);
  --cr-theme-task-text: oklch(0.255 0.04 190);
  --cr-theme-task-muted: oklch(0.43 0.034 185);
  --cr-theme-line: oklch(0.78 0.045 178);
  --cr-theme-line-soft: color-mix(in oklab, var(--cr-theme-accent) 18%, transparent);
  --cr-theme-accent-soft: color-mix(in oklab, var(--cr-theme-accent) 12%, var(--cr-theme-surface-raised));
  --cr-theme-accent-hover: color-mix(in oklab, var(--cr-theme-accent) 19%, var(--cr-theme-surface-raised));
  --cr-theme-coral: oklch(0.68 0.18 28);
  --cr-theme-amber: oklch(0.78 0.16 78);
  --cr-theme-sky: oklch(0.68 0.13 232);
  --cr-theme-violet: oklch(0.67 0.13 292);
  --cr-theme-immersive-sidebar: color-mix(in oklab, var(--cr-theme-sidebar) 88%, transparent);
  --cr-theme-immersive-edge: color-mix(in oklab, var(--cr-theme-surface) 94%, transparent);
  --cr-theme-immersive-mid: color-mix(in oklab, var(--cr-theme-surface) 68%, transparent);
  --cr-theme-immersive-far: color-mix(in oklab, var(--cr-theme-surface) 18%, transparent);
  --cr-theme-task-edge: color-mix(in oklab, var(--cr-theme-surface) 98%, transparent);
  --cr-theme-task-mid: color-mix(in oklab, var(--cr-theme-surface) 92%, transparent);
  --cr-theme-task-far: color-mix(in oklab, var(--cr-theme-surface) 86%, transparent);
  --cr-theme-composer: color-mix(in oklab, var(--cr-theme-surface-raised) 94%, var(--cr-theme-accent) 2%);
}

html.codex-relay-skin body {
  color: var(--cr-theme-text) !important;
  background-color: var(--cr-theme-canvas) !important;
  font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif !important;
  font-kerning: normal;
  font-optical-sizing: auto;
}

html.codex-relay-skin.cr-theme-art-wide:has(main.main-surface.cr-theme-home-shell) body,
html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner):has(main.main-surface:not(.cr-theme-home-shell)) body {
  background-image: var(--cr-theme-art) !important;
  background-position: var(--cr-theme-art-position) !important;
  background-size: cover !important;
  background-repeat: no-repeat !important;
  background-attachment: fixed !important;
}

html.codex-relay-skin aside.app-shell-left-panel {
  color: var(--cr-theme-text) !important;
  background: var(--cr-theme-sidebar) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: inset -1px 0 var(--cr-theme-line-soft) !important;
  backdrop-filter: none !important;
}

html.codex-relay-skin.cr-theme-art-wide:has(main.main-surface.cr-theme-home-shell) aside.app-shell-left-panel,
html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner):has(main.main-surface:not(.cr-theme-home-shell)) aside.app-shell-left-panel {
  background: linear-gradient(90deg, var(--cr-theme-immersive-sidebar), var(--cr-theme-immersive-edge)) !important;
}

html.codex-relay-skin aside.app-shell-left-panel nav { background: transparent !important; }

html.codex-relay-skin aside.app-shell-left-panel :where(button, a, [role="button"]) {
  color: var(--cr-theme-text) !important;
  transition: background-color 180ms cubic-bezier(.22, 1, .36, 1), color 180ms cubic-bezier(.22, 1, .36, 1) !important;
}

html.codex-relay-skin aside.app-shell-left-panel :where(button, a, [role="button"]) * { color: inherit !important; }

html.codex-relay-skin aside.app-shell-left-panel :where(button, a, [role="button"]):hover {
  color: oklch(0.42 0.1 180) !important;
  background: var(--cr-theme-accent-soft) !important;
}

html.codex-relay-skin aside.app-shell-left-panel [class~="bg-token-list-hover-background"],
html.codex-relay-skin aside.app-shell-left-panel [aria-current="page"] {
  color: oklch(0.35 0.085 180) !important;
  background: var(--cr-theme-accent-hover) !important;
  box-shadow: inset 0 0 0 1px var(--cr-theme-line-soft) !important;
}

html.codex-relay-skin aside.app-shell-left-panel svg { color: currentColor !important; }

html.codex-relay-skin aside.app-shell-left-panel :is(
  [class*="text-token-text-tertiary"],
  [class*="text-token-text-quaternary"],
  [class*="text-token-input-placeholder-foreground"],
  [class*="text-token-description-foreground"],
  [aria-disabled="true"],
  [disabled]
) {
  color: var(--cr-theme-text-muted) !important;
  opacity: .78 !important;
}

html.codex-relay-skin aside.app-shell-left-panel button[class*="text-token-input-placeholder-foreground"] {
  color: var(--cr-theme-text-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-text-muted) !important;
  opacity: .78 !important;
}

html.codex-relay-skin aside.app-shell-left-panel button[aria-label^="切换模式"] {
  color: oklch(0.38 0.095 180) !important;
  background: transparent !important;
  border-color: transparent !important;
}

html.codex-relay-skin main.main-surface {
  position: relative;
  isolation: isolate;
  overflow: hidden !important;
  color: var(--cr-theme-text) !important;
  background: var(--cr-theme-surface) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

html.codex-relay-skin.cr-theme-art-wide main.main-surface.cr-theme-home-shell {
  background: linear-gradient(90deg, var(--cr-theme-immersive-edge), var(--cr-theme-immersive-mid) 64%, var(--cr-theme-immersive-far)) !important;
}

html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner) main.main-surface:not(.cr-theme-home-shell) {
  background: linear-gradient(90deg, var(--cr-theme-task-edge), var(--cr-theme-task-mid) 68%, var(--cr-theme-task-far)) !important;
}

html.codex-relay-skin main.main-surface > header.app-header-tint {
  color: var(--cr-theme-text) !important;
  background: color-mix(in oklab, var(--cr-theme-surface) 88%, transparent) !important;
  border-color: var(--cr-theme-line-soft) !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
}

html.codex-relay-skin.cr-theme-art-wide main.main-surface > header.app-header-tint {
  background: transparent !important;
  border-bottom: 0 !important;
  text-shadow: 0 1px 2px var(--cr-theme-surface-raised), 0 0 8px var(--cr-theme-surface-raised) !important;
}

html.codex-relay-skin main.main-surface > header :where(button, a, [role="button"]) {
  color: var(--cr-theme-text) !important;
}

html.codex-relay-skin main.main-surface > header :where(button, a, [role="button"]) * { color: inherit !important; }

html.codex-relay-skin main.main-surface > header [role="group"][aria-label="Composer mode"] {
  color: var(--cr-theme-text) !important;
  background: var(--cr-theme-accent-soft) !important;
  box-shadow: inset 0 0 0 1px var(--cr-theme-line-soft) !important;
}

html.codex-relay-skin main.main-surface > header [role="group"][aria-label="Composer mode"] > span:first-child {
  background: transparent !important;
  box-shadow: none !important;
}

html.codex-relay-skin main.main-surface > header [role="group"][aria-label="Composer mode"] > span:nth-child(2) {
  background: var(--cr-theme-accent) !important;
  box-shadow: none !important;
}

html.codex-relay-skin main.main-surface > header [role="group"][aria-label="Composer mode"] button[aria-pressed="true"] {
  color: var(--cr-theme-accent-ink) !important;
}

html.codex-relay-skin [class~="group/application-menu-top-bar"] {
  color: var(--cr-theme-text) !important;
  background: linear-gradient(
    90deg,
    color-mix(in oklab, var(--cr-theme-sidebar) 92%, transparent) 0 calc(100% - 188px),
    color-mix(in oklab, var(--cr-theme-text) 88%, var(--cr-theme-accent)) calc(100% - 188px) 100%
  ) !important;
  border-bottom: 1px solid var(--cr-theme-line-soft) !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
}

html.codex-relay-skin [class~="group/application-menu-top-bar"] :where(button, [role="button"]),
html.codex-relay-skin [class~="group/application-menu-top-bar"] svg { color: var(--cr-theme-text) !important; }

html.codex-relay-skin [class~="group/application-menu-top-bar"] > :last-child {
  color: var(--cr-theme-accent-ink) !important;
}

#codex-relay-theme-chrome {
  display: none !important;
  pointer-events: none !important;
}

html.codex-relay-skin [role="main"] {
  color: var(--cr-theme-text);
  background: transparent !important;
  scrollbar-color: color-mix(in oklab, var(--cr-theme-accent) 48%, transparent) transparent;
}

html.codex-relay-skin :is(
  .cr-theme-task,
  main.main-surface:not(.cr-theme-home-shell) [role="main"]
) {
  position: relative;
  isolation: isolate;
  min-height: 100%;
  background: transparent !important;
}

html.codex-relay-skin :is(
  .cr-theme-task,
  main.main-surface:not(.cr-theme-home-shell) [role="main"]
) :is(article, [data-message-author-role], [data-testid="conversation-turn"]) {
  color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin :is(
  .cr-theme-task,
  main.main-surface:not(.cr-theme-home-shell) [role="main"]
) :is(
  [class*="text-token-foreground"],
  [class*="text-token-text-primary"],
  [class*="text-token-text-secondary"],
  [class*="text-token-button-tertiary-foreground"]
) {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin :is(
  .cr-theme-task,
  main.main-surface:not(.cr-theme-home-shell) [role="main"]
) :is(
  [class*="text-token-text-tertiary"],
  [class*="text-token-text-quaternary"],
  [class*="text-token-description-foreground"],
  [class*="text-token-input-placeholder-foreground"]
) {
  color: var(--cr-theme-task-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-task-muted) !important;
}

/* Current Codex task turns place action buttons beside messages instead of under a shared turn root. */
html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) :is(
  button[class*="text-token-text-tertiary"],
  button[class*="text-token-text-quaternary"],
  [class*="text-token-text-tertiary"],
  [class*="text-token-text-quaternary"],
  [class*="text-token-description-foreground"],
  .text-size-chat
) {
  color: var(--cr-theme-task-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-task-muted) !important;
}

/* Codex 0.112+ applies white directly to Markdown classes instead of a text token. */
html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) :is(
  p[class*="_markdownText_"],
  li[class*="_markdownText_"],
  th[class*="_tableHeaderCell_"],
  td[class*="_tableCell_"]
) {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) :is(
  p[class*="_markdownText_"],
  li[class*="_markdownText_"],
  th[class*="_tableHeaderCell_"],
  td[class*="_tableCell_"]
) :not(pre, pre *, code, code *) {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) [class*="_inlineMarkdown_"]:not(pre *, code *) {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) [class*="_cadencedShimmerHighlight_"] {
  color: var(--cr-theme-task-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-task-muted) !important;
}

html.codex-relay-skin main.main-surface:not(.cr-theme-home-shell) :is(
  p[class*="_markdownText_"],
  li[class*="_markdownText_"]
) > code {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
  background: var(--cr-theme-accent-soft) !important;
}

html.codex-relay-skin .cr-theme-home :is(
  .cr-theme-fallback-action,
  .group\/home-suggestions button,
  [class*="home-suggestions"] button
) :is(
  [class*="text-token-foreground"],
  [class*="text-token-text-primary"],
  [class*="text-token-text-secondary"]
) {
  color: var(--cr-theme-text) !important;
  -webkit-text-fill-color: var(--cr-theme-text) !important;
}

html.codex-relay-skin .cr-theme-home :is(
  .cr-theme-fallback-action,
  .group\/home-suggestions button,
  [class*="home-suggestions"] button
) :is(
  [class*="text-token-text-tertiary"],
  [class*="text-token-text-quaternary"],
  [class*="text-token-description-foreground"]
) {
  color: var(--cr-theme-text-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-text-muted) !important;
}

html.codex-relay-skin main.main-surface > header :is(
  [data-thread-title],
  [class*="text-token-foreground"],
  [class*="text-token-text-primary"],
  [class*="text-token-text-secondary"]
) {
  color: var(--cr-theme-task-text) !important;
  -webkit-text-fill-color: var(--cr-theme-task-text) !important;
}

html.codex-relay-skin main.main-surface > header :is(
  [class*="text-token-text-tertiary"],
  [class*="text-token-description-foreground"]
) {
  color: var(--cr-theme-task-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-task-muted) !important;
}

html.codex-relay-skin :is(
  .cr-theme-task,
  main.main-surface:not(.cr-theme-home-shell) [role="main"]
) > * { position: relative; z-index: 1; }

.cr-theme-home {
  --thread-content-max-width: min(1180px, calc(100cqw - 56px)) !important;
  overflow-x: hidden !important;
  background: transparent !important;
}

.cr-theme-home > div:first-child {
  min-height: 100% !important;
  padding-top: 24px !important;
  grid-template-rows: 520px auto !important;
}

.cr-theme-home > div:first-child > div:first-child {
  position: relative !important;
  flex: 0 0 auto !important;
  min-height: 0 !important;
  height: 100% !important;
  align-items: flex-start !important;
  padding-bottom: 0 !important;
}

.cr-theme-home > div:first-child > div:first-child > div:first-child {
  position: relative !important;
  isolation: isolate;
  width: calc(100% - 56px) !important;
  max-width: 1180px !important;
  height: 252px !important;
  min-height: 252px !important;
  flex: 0 1 auto !important;
  padding: 0 !important;
  overflow: visible !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  height: 100%;
  align-items: center !important;
  justify-content: flex-start !important;
  padding: 30px 40px;
}

.cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child > div:first-child {
  width: min(50%, 540px) !important;
  align-items: flex-start !important;
  gap: 0 !important;
}

.cr-theme-home [data-testid="home-icon"] { display: none !important; }

.cr-theme-home [data-feature="game-source"] {
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  justify-content: flex-start !important;
  max-width: 100% !important;
  color: var(--cr-theme-text) !important;
  font-size: 1.85rem !important;
  line-height: 1.2 !important;
  font-weight: 720 !important;
  letter-spacing: -0.025em;
  text-align: left !important;
  text-wrap: balance;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
}

.cr-theme-home [data-feature="game-source"]::after {
  content: "把灵感拆成下一步，把下一步做成作品。";
  display: block;
  max-width: 36ch;
  margin-top: 12px;
  color: var(--cr-theme-text-muted);
  font-size: 0.875rem;
  font-weight: 480;
  line-height: 1.6;
  letter-spacing: 0;
  text-wrap: pretty;
}

.cr-theme-home [data-feature="game-source"] button {
  margin: 0 4px;
  padding: 2px 7px;
  color: oklch(0.39 0.09 180) !important;
  background: var(--cr-theme-accent-soft) !important;
  border: 1px solid var(--cr-theme-line) !important;
  border-radius: 999px;
  font-size: 0.48em;
  font-weight: 720;
}

.cr-theme-home > div:first-child > div:first-child > div:first-child > div:nth-child(2) {
  left: 0 !important;
  right: 0 !important;
  top: 100% !important;
  margin-top: 16px !important;
}

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) { overflow: visible !important; }

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button,
.cr-theme-fallback-action {
  position: relative !important;
  min-width: 0;
  min-height: 112px !important;
  padding: 16px 14px !important;
  color: var(--cr-theme-text) !important;
  background: color-mix(in oklab, var(--cr-theme-surface-raised) 88%, transparent) !important;
  border: 1px solid var(--cr-theme-line-soft) !important;
  border-radius: 14px !important;
  box-shadow: none !important;
  text-align: left !important;
  transition: transform 180ms cubic-bezier(.22, 1, .36, 1), border-color 180ms cubic-bezier(.22, 1, .36, 1), background-color 180ms cubic-bezier(.22, 1, .36, 1) !important;
}

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button:hover,
.cr-theme-fallback-action:hover {
  color: oklch(0.34 0.08 180) !important;
  background: var(--cr-theme-accent-soft) !important;
  border-color: var(--cr-theme-line) !important;
  transform: translateY(-2px) !important;
}

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button:focus-visible,
.cr-theme-fallback-action:focus-visible {
  outline: 3px solid color-mix(in oklab, var(--cr-theme-accent) 52%, transparent) !important;
  outline-offset: 2px !important;
}

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button > span:first-child > span:first-child {
  width: 38px;
  height: 38px;
  display: grid !important;
  place-items: center;
  color: var(--cr-theme-accent-ink) !important;
  background: var(--cr-theme-accent) !important;
  border-radius: 12px;
  box-shadow: none !important;
}

.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button:nth-child(2) > span:first-child > span:first-child { background: var(--cr-theme-coral) !important; }
.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button:nth-child(3) > span:first-child > span:first-child { background: var(--cr-theme-sky) !important; }
.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button:nth-child(4) > span:first-child > span:first-child { color: oklch(0.28 0.05 75) !important; background: var(--cr-theme-amber) !important; }
.cr-theme-home :is(.group\/home-suggestions, [class*="home-suggestions"]) button svg { color: currentColor !important; }

.cr-theme-fallback-actions {
  position: absolute;
  z-index: 6;
  left: max(28px, calc((100% - min(1180px, calc(100% - 56px))) / 2));
  right: max(28px, calc((100% - min(1180px, calc(100% - 56px))) / 2));
  top: 268px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.cr-theme-fallback-action {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
}

.cr-theme-fallback-action-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  margin-bottom: 12px;
  color: var(--cr-theme-accent-ink);
  background: var(--cr-theme-accent);
  border-radius: 12px;
}

.cr-theme-fallback-action:nth-child(2) .cr-theme-fallback-action-icon { background: var(--cr-theme-coral); }
.cr-theme-fallback-action:nth-child(3) .cr-theme-fallback-action-icon { background: var(--cr-theme-sky); }
.cr-theme-fallback-action:nth-child(4) .cr-theme-fallback-action-icon { color: oklch(0.28 0.05 75); background: var(--cr-theme-amber); }
.cr-theme-fallback-action-icon svg { width: 20px; height: 20px; stroke: currentColor; }
.cr-theme-fallback-action strong {
  display: block;
  margin-bottom: 5px;
  color: var(--cr-theme-text) !important;
  -webkit-text-fill-color: var(--cr-theme-text) !important;
  font-size: 0.9rem;
  line-height: 1.3;
}

.cr-theme-fallback-action small {
  display: block;
  color: var(--cr-theme-text-muted) !important;
  -webkit-text-fill-color: var(--cr-theme-text-muted) !important;
  font-size: 0.75rem;
  line-height: 1.45;
  text-wrap: pretty;
}

html.codex-relay-skin .cr-theme-home-utility {
  color: var(--cr-theme-text) !important;
  background: var(--cr-theme-composer) !important;
  border: 1px solid var(--cr-theme-line-soft) !important;
  border-bottom: 0 !important;
  border-radius: 16px 16px 0 0 !important;
  box-shadow: none !important;
}

html.codex-relay-skin .cr-theme-home-utility * { color: inherit !important; }

html.codex-relay-skin .composer-surface-chrome {
  overflow: visible !important;
  color: var(--cr-theme-text) !important;
  background: var(--cr-theme-composer) !important;
  border: 0 !important;
  border-radius: 16px !important;
  box-shadow: 0 4px 8px color-mix(in oklab, var(--cr-theme-accent) 12%, transparent), inset 0 0 0 1px var(--cr-theme-line-soft) !important;
  backdrop-filter: none !important;
}

html.codex-relay-skin .cr-theme-home:has(.cr-theme-home-utility) .composer-surface-chrome {
  border-radius: 0 0 16px 16px !important;
}

html.codex-relay-skin .composer-surface-chrome :where(button, [role="button"]) { color: var(--cr-theme-text) !important; }
html.codex-relay-skin .composer-surface-chrome :where(button, [role="button"]) * { color: inherit !important; }
html.codex-relay-skin .ProseMirror { color: var(--cr-theme-text) !important; caret-color: var(--cr-theme-accent) !important; }

html.codex-relay-skin .composer-surface-chrome [data-placeholder]::before,
html.codex-relay-skin .composer-surface-chrome .ProseMirror p.is-editor-empty:first-child::before,
html.codex-relay-skin .composer-surface-chrome .ProseMirror p.placeholder::after {
  color: var(--cr-theme-text-muted) !important;
  opacity: .82 !important;
}

html.codex-relay-skin button[class~="bg-token-foreground"] {
  color: var(--cr-theme-accent-ink) !important;
  background: var(--cr-theme-accent) !important;
  box-shadow: none !important;
}

html.codex-relay-skin button[class~="bg-token-foreground"] * { color: inherit !important; }

html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner)
  main.main-surface:not(.cr-theme-home-shell) div.sticky:has(input[type="text"]),
html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner)
  main.main-surface:not(.cr-theme-home-shell) div.sticky:has(input[type="text"])::after {
  background: transparent !important;
}

html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner)
  main.main-surface:not(.cr-theme-home-shell) div.no-drag:has(> input[type="text"]) {
  background: var(--cr-theme-composer) !important;
  border: 0 !important;
  box-shadow: inset 0 0 0 1px var(--cr-theme-line-soft) !important;
  backdrop-filter: none !important;
}

html.codex-relay-skin.cr-theme-art-wide:is(.cr-theme-task-ambient, .cr-theme-task-banner)
  main.main-surface:not(.cr-theme-home-shell)
  [class~="bg-token-main-surface-primary"][class~="h-full"][class~="w-full"] { background: transparent !important; }

html.codex-relay-skin.cr-theme-art-wide main.main-surface .app-shell-main-content-frame { border-top: 0 !important; }
html.codex-relay-skin.cr-theme-art-wide main.main-surface .app-shell-main-content-top-fade { display: none !important; background: transparent !important; }
html.codex-relay-skin.cr-theme-art-wide main.main-surface .thread-scroll-container .bg-gradient-to-t.from-token-main-surface-primary { background: transparent !important; }

@media (max-width: 1120px) {
  .cr-theme-home { --thread-content-max-width: min(940px, calc(100cqw - 36px)) !important; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child { width: calc(100% - 36px) !important; }
  .cr-theme-fallback-actions { left: 18px; right: 18px; }
}

@media (max-width: 900px) {
  .cr-theme-home > div:first-child { padding-top: 16px !important; grid-template-rows: 470px auto !important; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child { height: 220px !important; min-height: 220px !important; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child { padding: 24px; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child > div:first-child { width: 62% !important; }
  .cr-theme-home [data-feature="game-source"] { font-size: 1.45rem !important; }
  .cr-theme-fallback-actions { top: 236px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cr-theme-fallback-action { min-height: 104px !important; }
}

@media (max-width: 620px) {
  html.codex-relay-skin.cr-theme-art-wide:has(main.main-surface.cr-theme-home-shell) body { background-position: 82% 44% !important; }
  html.codex-relay-skin.cr-theme-art-wide main.main-surface.cr-theme-home-shell {
    background: color-mix(in oklab, var(--cr-theme-surface) 84%, transparent) !important;
  }
  .cr-theme-home > div:first-child { grid-template-rows: 690px auto !important; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child { justify-content: center !important; padding: 20px; }
  .cr-theme-home > div:first-child > div:first-child > div:first-child > div:first-child > div:first-child { width: min(90%, 440px) !important; align-items: center !important; text-align: center !important; }
  .cr-theme-home [data-feature="game-source"] { align-items: center !important; font-size: 1.3rem !important; text-align: center !important; }
  .cr-theme-home [data-feature="game-source"]::after { font-size: 0.75rem; }
  .cr-theme-fallback-actions { top: 228px; grid-template-columns: 1fr; gap: 10px; }
  .cr-theme-fallback-action { min-height: 76px !important; padding: 12px 14px !important; flex-direction: row; align-items: center; justify-content: flex-start; gap: 12px; }
  .cr-theme-fallback-action-icon { flex: 0 0 auto; margin-bottom: 0; }
}

@media (prefers-reduced-motion: reduce) {
  html.codex-relay-skin *,
  html.codex-relay-skin *::before,
  html.codex-relay-skin *::after {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
`;
