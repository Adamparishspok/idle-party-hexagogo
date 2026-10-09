import { escapeHtml } from './ItemIcon';

export interface EmptyStateOpts {
  /** Trusted SVG markup for the emblem (drawn inside a gold `.gc-octicon`). */
  emblem: string;
  title: string;
  body: string;
  /** Trusted HTML for the one primary action, if any. */
  actionHtml?: string;
  /** Single-row variant for in-panel use. */
  compact?: boolean;
}

/** Kit `.gc-empty`: friendly illustrated empty state — emblem, headline, line, one action. */
export function renderEmptyState(o: EmptyStateOpts): string {
  const text = `<div class="gc-empty__title">${escapeHtml(o.title)}</div>
    <p class="gc-empty__body">${escapeHtml(o.body)}</p>`;
  return `<div class="gc-empty${o.compact ? ' gc-empty--compact' : ''}">
    <span class="gc-octicon gc-octicon--lg gc-octicon--gold gc-empty__emblem" aria-hidden="true">${o.emblem}</span>
    ${o.compact ? `<div>${text}</div>` : text}
    ${o.actionHtml ?? ''}
  </div>`;
}
