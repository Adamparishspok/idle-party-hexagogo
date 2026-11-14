let promptEl: HTMLElement | null = null;

/** Persistent "new version" banner; reloading picks up the matching client build. */
export function showReloadPrompt(): void {
  if (promptEl) return;
  promptEl = document.createElement('div');
  promptEl.className = 'reload-prompt';
  promptEl.setAttribute('role', 'alert');
  promptEl.innerHTML = '<span>A new version of the game is available.</span>'
    + '<button type="button" class="gc-btn gc-btn--gold">Reload</button>';
  promptEl.querySelector('button')!.addEventListener('click', () => location.reload());
  document.body.appendChild(promptEl);
}
