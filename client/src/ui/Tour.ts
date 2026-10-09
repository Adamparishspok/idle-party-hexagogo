import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { bringToFront, release } from './ModalStack';
import '../styles/screens/tour.css';

export interface TourStep {
  id: string;
  /** Candidate targets, most specific first; the first one on screen is spotlit. */
  targets: readonly string[];
  title: string;
  body: string;
}

export const TOUR_DONE_KEY = 'idleparty.tourDone';

const NEW_PLAYER_MAX_LEVEL = 2;
const SPOT_PAD = 6;
const GUTTER = 16;
const GAP = 14;
const ARROW_INSET = 24;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'combat',
    targets: ['#screen-combat.active .cb-stage', '.nav-tab[data-screen="combat"]'],
    title: 'Always Fighting',
    body: 'Your party fights on its own, even while you’re away.',
  },
  {
    id: 'map',
    targets: ['.nav-tab[data-screen="map"]'],
    title: 'The Map',
    body: 'Tap the map to travel. Rooms with icons have people to talk to and shops.',
  },
  {
    id: 'character',
    targets: ['.nav-tab[data-screen="items"]'],
    title: 'Your Character',
    body: 'Equip better gear from your bag.',
  },
  {
    id: 'quests',
    targets: ['.nav-tab[data-screen="quests"]'],
    title: 'Quests',
    body: 'Quests from people you meet show up here — look for the gold !',
  },
  {
    id: 'social',
    targets: ['.nav-tab[data-screen="social"]'],
    title: 'Find a Party',
    body: 'Everyone is weak alone and strong together — find a party.',
  },
];

export function isNewPlayer(state: ServerStateMessage | null): boolean {
  const level = state?.character?.level;
  return level !== undefined && level <= NEW_PLAYER_MAX_LEVEL;
}

export function isTourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function markTourDone(): void {
  try {
    localStorage.setItem(TOUR_DONE_KEY, '1');
  } catch {
    // Storage blocked (private mode): the tour may show again next session.
  }
}

function isShown(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.hidden || node.style.display === 'none')) return false;
  }
  return true;
}

export function findTourTarget(step: TourStep, root: ParentNode = document): HTMLElement | null {
  for (const selector of step.targets) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el && isShown(el)) return el;
  }
  return null;
}

/** Coach-mark tour: a parchment callout pointing at each step's target through a spotlight cutout. */
export class Tour {
  private layer: HTMLElement | null = null;
  private spot!: HTMLElement;
  private callout!: HTMLElement;
  private countEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private skipBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private index = -1;
  private target: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;
  private frame = 0;

  constructor(private steps: readonly TourStep[] = TOUR_STEPS) {}

  get isRunning(): boolean {
    return this.layer !== null;
  }

  get currentStepId(): string | null {
    return this.steps[this.index]?.id ?? null;
  }

  /** Returns false when no step has a target on screen. */
  start(): boolean {
    if (this.layer) return true;
    const first = this.nextPresentIndex(0);
    if (first < 0) return false;
    this.mount();
    this.show(first);
    return true;
  }

  next(): void {
    const i = this.nextPresentIndex(this.index + 1);
    if (i < 0) {
      this.finish();
      return;
    }
    this.show(i);
  }

  skip(): void {
    this.finish();
  }

  private nextPresentIndex(from: number): number {
    for (let i = from; i < this.steps.length; i++) {
      if (findTourTarget(this.steps[i])) return i;
    }
    return -1;
  }

  private mount(): void {
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;

    const layer = document.createElement('div');
    layer.className = 'tour';
    layer.innerHTML = `
      <div class="tour__spot" aria-hidden="true"></div>
      <div class="tour__callout gc-parchment" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
        <span class="tour__arrow" aria-hidden="true"></span>
        <p class="tour__count"></p>
        <div class="tour__title gc-display" id="tour-title"></div>
        <p class="tour__body" id="tour-body"></p>
        <div class="tour__actions">
          <button type="button" class="tour__skip">Skip tour</button>
          <button type="button" class="gc-btn gc-btn--gold tour__next"></button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);
    this.layer = layer;
    this.spot = layer.querySelector('.tour__spot') as HTMLElement;
    this.callout = layer.querySelector('.tour__callout') as HTMLElement;
    this.countEl = layer.querySelector('.tour__count') as HTMLElement;
    this.titleEl = layer.querySelector('.tour__title') as HTMLElement;
    this.bodyEl = layer.querySelector('.tour__body') as HTMLElement;
    this.skipBtn = layer.querySelector('.tour__skip') as HTMLButtonElement;
    this.nextBtn = layer.querySelector('.tour__next') as HTMLButtonElement;

    this.skipBtn.addEventListener('click', () => this.skip());
    this.nextBtn.addEventListener('click', () => this.next());
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);
    bringToFront(layer);
  }

  private show(index: number): void {
    this.index = index;
    const step = this.steps[index];
    this.target = findTourTarget(step);

    const present = this.steps.flatMap((s, i) => (i === index || findTourTarget(s) ? [i] : []));
    const isLast = present[present.length - 1] === index;

    this.countEl.textContent = `${present.indexOf(index) + 1} of ${present.length}`;
    this.titleEl.textContent = step.title;
    this.bodyEl.textContent = step.body;
    this.nextBtn.textContent = isLast ? 'Got it' : 'Next';
    this.layer!.dataset.step = step.id;

    this.position();
    this.nextBtn.focus();
  }

  private finish(): void {
    markTourDone();
    if (!this.layer) return;
    cancelAnimationFrame(this.frame);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    release(this.layer);
    this.layer.remove();
    this.layer = null;
    this.target = null;
    this.index = -1;
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = null;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.skip();
      return;
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const onSkip = document.activeElement === this.skipBtn;
    (onSkip ? this.nextBtn : this.skipBtn).focus();
  };

  private onViewportChange = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.position());
  };

  private position(): void {
    if (!this.target) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = this.target.getBoundingClientRect();
    const spotTop = r.top - SPOT_PAD;
    const spotBottom = r.bottom + SPOT_PAD;

    Object.assign(this.spot.style, {
      left: `${r.left - SPOT_PAD}px`,
      top: `${spotTop}px`,
      width: `${r.width + SPOT_PAD * 2}px`,
      height: `${r.height + SPOT_PAD * 2}px`,
    });

    const cw = this.callout.offsetWidth;
    const ch = this.callout.offsetHeight;
    const spaceAbove = spotTop - GUTTER;
    const spaceBelow = vh - spotBottom - GUTTER;
    const needed = ch + GAP;

    let placement: 'above' | 'below' | 'over';
    let top: number;
    if (spaceBelow >= needed && spaceBelow >= spaceAbove) {
      placement = 'below';
      top = spotBottom + GAP;
    } else if (spaceAbove >= needed) {
      placement = 'above';
      top = spotTop - GAP - ch;
    } else {
      placement = 'over';
      top = clamp(spotTop + GAP, GUTTER, vh - ch - GUTTER);
    }

    const centerX = r.left + r.width / 2;
    const left = clamp(centerX - cw / 2, GUTTER, vw - cw - GUTTER);
    this.callout.style.left = `${left}px`;
    this.callout.style.top = `${top}px`;
    this.callout.dataset.placement = placement;
    this.callout.style.setProperty('--arrow-x', `${clamp(centerX - left, ARROW_INSET, cw - ARROW_INSET)}px`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface StartWhenClearOptions {
  pollMs?: number;
  /** Consecutive modal-free polls required, so a modal opened just after game entry still wins. */
  settleChecks?: number;
  maxWaitMs?: number;
}

/** Starts the tour once no `.gc-modal` is showing; gives up if `shouldStart` turns false. Returns a cancel. */
export function startTourWhenClear(
  tour: Tour,
  shouldStart: () => boolean,
  { pollMs = 500, settleChecks = 2, maxWaitMs = 120_000 }: StartWhenClearOptions = {},
): () => void {
  let clearChecks = 0;
  let waited = 0;
  const timer = setInterval(() => {
    waited += pollMs;
    if (tour.isRunning || !shouldStart() || waited > maxWaitMs) {
      clearInterval(timer);
      return;
    }
    clearChecks = document.querySelector('.gc-modal') ? 0 : clearChecks + 1;
    if (clearChecks < settleChecks) return;
    clearInterval(timer);
    tour.start();
  }, pollMs);
  return () => clearInterval(timer);
}
