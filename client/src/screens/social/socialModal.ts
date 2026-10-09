import { bringToFront, release, wireFocusOnInteract } from '../../ui/ModalStack';
import { esc } from './socialHtml';

/**
 * Parchment modal shell (`.gc-modal`) shared by the user popup, View Player,
 * trade, and gift dialogs. Title sits on a slate tab, a parchment X closes,
 * the body scrolls, and an optional footer pins the action buttons below it.
 *
 * Dismissal: X, backdrop tap, or Escape (topmost social modal only).
 */
export interface SocModal {
  root: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  setTitle(title: string): void;
  close(): void;
}

const openStack: SocModal[] = [];

export function openSocModal(opts: { title: string; variant?: string; onClose?: () => void }): SocModal {
  const root = document.createElement('div');
  root.className = `gc-modal soc-modal${opts.variant ? ` soc-modal--${opts.variant}` : ''}`;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', opts.title);
  root.innerHTML = `
    <div class="gc-modal__panel gc-parchment soc-modal__panel" tabindex="-1">
      <div class="gc-title-tab gc-modal__title soc-modal__title">${esc(opts.title)}</div>
      <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
      <div class="gc-modal__body soc-modal__body"></div>
      <div class="soc-modal__footer"></div>
    </div>
  `;
  const panel = root.querySelector<HTMLElement>('.soc-modal__panel')!;
  const body = root.querySelector<HTMLElement>('.soc-modal__body')!;
  const footer = root.querySelector<HTMLElement>('.soc-modal__footer')!;
  const titleEl = root.querySelector<HTMLElement>('.soc-modal__title')!;

  let closed = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (openStack[openStack.length - 1] !== modal) return;
    e.preventDefault();
    modal.close();
  };

  const modal: SocModal = {
    root,
    panel,
    body,
    footer,
    setTitle(title: string) {
      titleEl.textContent = title;
      root.setAttribute('aria-label', title);
    },
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      const i = openStack.indexOf(modal);
      if (i >= 0) openStack.splice(i, 1);
      release(root);
      root.remove();
      opts.onClose?.();
    },
  };

  root.addEventListener('click', (e) => {
    if (e.target === root) { modal.close(); return; }
    if ((e.target as HTMLElement).closest('.gc-modal__close')) modal.close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(root);
  openStack.push(modal);
  bringToFront(root);
  wireFocusOnInteract(root);
  panel.focus({ preventScroll: true });
  return modal;
}

/** Re-render a scroll region's HTML without losing the reader's place. */
export function setHtmlKeepScroll(el: HTMLElement, html: string): void {
  const top = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = top;
}
