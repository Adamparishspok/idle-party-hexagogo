import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../src/network/GameClient';
import { ChatPopout } from '../src/ui/ChatPopout';

function makeClient() {
  let chatCb: ((m: ChatMessage) => void) | null = null;
  const client = {
    lastState: { username: 'me' },
    onChat: (cb: (m: ChatMessage) => void) => { chatCb = cb; },
    onSyncChat: vi.fn(),
    subscribe: vi.fn(),
    onResume: vi.fn(),
    sendSyncChat: vi.fn(),
    sendChat: vi.fn(),
  };
  return { client: client as unknown as GameClient, push: (m: ChatMessage) => chatCb?.(m), raw: client };
}

let seq = 0;
function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  seq++;
  return {
    id: `m${seq}`,
    channelType: 'global',
    channelId: '',
    senderUsername: 'alice',
    text: 'hello',
    timestamp: Date.now(),
    ...over,
  };
}

describe('ChatPopout', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="chat-popout-root"></div>';
  });

  it('groups consecutive messages from the same sender and channel', () => {
    const { client, push } = makeClient();
    const chat = new ChatPopout(client);
    chat.open();
    const t = Date.now();
    push(msg({ timestamp: t }));
    push(msg({ timestamp: t + 1000 }));
    push(msg({ senderUsername: 'bob', timestamp: t + 2000 }));
    const rows = document.querySelectorAll('.chat-msg');
    expect(rows).toHaveLength(3);
    expect(rows[0].classList.contains('chat-msg--cont')).toBe(false);
    expect(rows[1].classList.contains('chat-msg--cont')).toBe(true);
    expect(rows[1].querySelector('.chat-msg-sender-btn')).toBeNull();
    expect(rows[2].classList.contains('chat-msg--cont')).toBe(false);
  });

  it('marks your own messages and renders server lines without buttons', () => {
    const { client, push } = makeClient();
    const chat = new ChatPopout(client);
    chat.open();
    push(msg({ senderUsername: 'me' }));
    push(msg({ channelType: 'server', senderUsername: '' }));
    expect(document.querySelector('.chat-msg--own')).not.toBeNull();
    const server = document.querySelector('.chat-msg--server')!;
    expect(server.querySelector('button')).toBeNull();
  });

  it('escapes message text and attribute values', () => {
    const { client, push } = makeClient();
    const chat = new ChatPopout(client);
    chat.open();
    push(msg({ senderUsername: 'x"><b>', text: '<img src=x>' }));
    expect(document.querySelector('.chat-msg-text')!.innerHTML).toBe('&lt;img src=x&gt;');
    expect(document.querySelector<HTMLElement>('.chat-msg-sender-btn')!.dataset.user).toBe('x"><b>');
  });

  it('hides channels that are filtered off', () => {
    const { client, push } = makeClient();
    const chat = new ChatPopout(client);
    chat.open();
    push(msg({ channelType: 'party' }));
    const chip = document.querySelector<HTMLButtonElement>('.chat-filter[data-ch="party"]')!;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('.chat-msg')).toHaveLength(0);
    expect(document.querySelector('.chat-empty')).not.toBeNull();
  });

  it('shows the DM "To" row for DMs and keeps typed text across incoming messages', () => {
    const { client, push } = makeClient();
    const chat = new ChatPopout(client);
    chat.openDm('bob');
    const row = document.querySelector<HTMLElement>('.chat-popout-dm-row')!;
    expect(row.hidden).toBe(false);
    expect(document.querySelector<HTMLInputElement>('.chat-popout-dm-target')!.value).toBe('bob');
    const input = document.querySelector<HTMLInputElement>('.chat-popout-input')!;
    input.value = 'half-typed';
    push(msg());
    expect(input.value).toBe('half-typed');
  });
});
