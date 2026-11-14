import { MOVE_DURATION, cubeDistance, offsetToCube } from '@idle-party-rpg/shared';

export interface Point {
  x: number;
  y: number;
}

export interface Room {
  col: number;
  row: number;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** A server move is one hop to a neighbouring room; anything else (reconnect, resume, teleport) snaps. */
export function isSingleHop(from: Room, to: Room): boolean {
  return cubeDistance(offsetToCube(from), offsetToCube(to)) === 1;
}

/**
 * A map marker's position as a pure function of its last move: the hop starts
 * where the marker was drawn when the move arrived and lands on the new room
 * MOVE_DURATION later, matching the server's move window.
 */
export class MarkerGlide {
  private from: Point;
  private to: Point;
  private start = 0;
  private duration: number;

  constructor(at: Point, duration = MOVE_DURATION) {
    this.from = at;
    this.to = at;
    this.duration = duration;
  }

  moveTo(to: Point, now: number, glide: boolean): void {
    this.from = glide ? this.at(now) : to;
    this.to = to;
    this.start = now;
  }

  at(now: number): Point {
    const t = this.duration > 0 ? (now - this.start) / this.duration : 1;
    if (t >= 1) return this.to;
    const e = easeInOut(Math.max(0, t));
    return { x: this.from.x + (this.to.x - this.from.x) * e, y: this.from.y + (this.to.y - this.from.y) * e };
  }

  isMoving(now: number): boolean {
    return now - this.start < this.duration && (this.from.x !== this.to.x || this.from.y !== this.to.y);
  }
}
