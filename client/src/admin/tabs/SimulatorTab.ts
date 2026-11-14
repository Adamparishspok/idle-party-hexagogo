import { ALL_CLASS_NAMES, DISPLAY_EQUIP_SLOTS, autoSkillLoadout, canClassUse, simSlotChoices, slotAccepts } from '@idle-party-rpg/shared';
import type { ClassName, EquipSlot, SimReport, SimStats } from '@idle-party-rpg/shared';
import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { ContentData } from '../types';
import { escapeHtml, fetchAdmin, postAdmin } from '../api';

interface PartyChoice { username: string; members: { username: string; className: ClassName; level: number }[] }
interface PartiesResponse { parties: PartyChoice[]; maxPartySize: number; maxBattles: number }
interface SimStatus { state: 'idle' | 'running' | 'done' | 'cancelled' | 'error'; completed: number; total: number; report?: SimReport; error?: string }
type OpponentType = 'encounter' | 'zone' | 'dungeon' | 'worldBoss';

const OPPONENT_LABELS: Record<OpponentType, string> = {
  encounter: 'Encounter', zone: 'Zone encounter pool', dungeon: 'Dungeon (full run)', worldBoss: 'World boss (one attempt)',
};

export class SimulatorTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Simulator</h2></div>
        <p class="admin-form-hint">Runs battles headlessly on the real combat engine using the content selected in the status bar (a draft) or the live server content otherwise. A copied party keeps its current live stats and gear. Nothing here touches a player, party, boss, ledger or save.</p>
        <fieldset class="admin-form-fieldset"><legend>Party</legend>
          <div class="admin-form-row">
            <label><input type="radio" name="sim-mode" value="copy" checked> Copy a player's party</label>
            <label><input type="radio" name="sim-mode" value="build"> Build a party</label>
          </div>
          <div id="sim-copy"><select id="sim-copy-select"><option value="">Loading...</option></select></div>
          <div id="sim-build" hidden>
            <div id="sim-members"></div>
            <button class="admin-btn admin-btn-sm" id="sim-add-member" type="button">+ Add member</button>
            <div class="admin-form-row" id="sim-henchmen"></div>
          </div>
        </fieldset>
        <fieldset class="admin-form-fieldset"><legend>Opponent</legend>
          <div class="admin-form-row">
            <select id="sim-opp-type">${(Object.keys(OPPONENT_LABELS) as OpponentType[]).map(t => `<option value="${t}">${OPPONENT_LABELS[t]}</option>`).join('')}</select>
            <select id="sim-opp-id"></select>
          </div>
        </fieldset>
        <div class="admin-form-row">
          <label>Battles <input type="number" id="sim-battles" min="1" max="1000" value="200"></label>
          <label>Seed (optional) <input type="number" id="sim-seed" placeholder="random"></label>
          <button class="admin-btn admin-btn-primary" id="sim-run" type="button">Run simulation</button>
          <button class="admin-btn" id="sim-cancel" type="button" hidden>Cancel</button>
          <progress id="sim-progress" max="1" value="0" hidden></progress>
          <span id="sim-status" class="admin-form-hint"></span>
        </div>
        <div id="sim-result"></div>
      </div>`;

    const $ = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
    const oppType = $<HTMLSelectElement>('sim-opp-type');
    const fillOpponents = () => {
      $('sim-opp-id').innerHTML = opponentOptions(content, oppType.value as OpponentType);
    };
    oppType.addEventListener('change', fillOpponents);
    fillOpponents();

    container.querySelectorAll<HTMLInputElement>('input[name="sim-mode"]').forEach(r => r.addEventListener('change', () => {
      const build = r.value === 'build' && r.checked;
      $('sim-copy').hidden = build;
      $('sim-build').hidden = !build;
    }));

    $('sim-henchmen').innerHTML = Object.values(content.henchmen ?? {})
      .map(h => `<label class="admin-form-checkbox"><input type="checkbox" class="sim-henchman" value="${escapeHtml(h.id)}"> ${escapeHtml(h.name)}</label>`).join('');

    let maxParty = 5;
    const members = $('sim-members');
    const addMember = () => {
      if (members.children.length >= maxParty) return;
      members.insertAdjacentHTML('beforeend', memberRow());
      const row = members.lastElementChild as HTMLElement;
      const refresh = () => { refreshGear(row, content); refreshSkills(row, content); };
      row.querySelector('.sim-class')!.addEventListener('change', refresh);
      row.querySelector('.sim-level')!.addEventListener('change', () => refreshSkills(row, content));
      row.querySelector('.sim-remove')!.addEventListener('click', () => row.remove());
      refresh();
    };
    $('sim-add-member').addEventListener('click', addMember);
    addMember();

    fetchAdmin<PartiesResponse>('/api/admin/simulator/parties').then(data => {
      maxParty = data.maxPartySize;
      $<HTMLInputElement>('sim-battles').max = String(data.maxBattles);
      $<HTMLSelectElement>('sim-copy-select').innerHTML = data.parties.length
        ? data.parties.map(p => `<option value="${escapeHtml(p.username)}">${escapeHtml(p.members.map(m => `${m.username} (${m.className} ${m.level})`).join(', '))}</option>`).join('')
        : '<option value="">No loaded parties</option>';
    }).catch(err => {
      $('sim-copy-select').innerHTML = `<option value="">${escapeHtml(String(err.message))}</option>`;
    });

    $('sim-run').addEventListener('click', async () => {
      const build = container.querySelector<HTMLInputElement>('input[name="sim-mode"]:checked')!.value === 'build';
      const party = build
        ? {
          members: [...members.children].map(row => readMember(row as HTMLElement)),
          henchmanIds: [...container.querySelectorAll<HTMLInputElement>('.sim-henchman:checked')].map(c => c.value),
        }
        : { copyFrom: $<HTMLSelectElement>('sim-copy-select').value };
      const seed = $<HTMLInputElement>('sim-seed').value;
      const versionId = new URLSearchParams(ctx.versionQueryParam()).get('versionId');
      const button = $<HTMLButtonElement>('sim-run');
      const cancel = $<HTMLButtonElement>('sim-cancel');
      const progress = $<HTMLProgressElement>('sim-progress');
      let cancelled = false;
      cancel.onclick = () => { cancelled = true; void postAdmin('/api/admin/simulator/cancel', {}); };
      button.disabled = true;
      cancel.hidden = progress.hidden = false;
      progress.value = 0;
      $('sim-status').textContent = 'Running...';
      try {
        await postAdmin('/api/admin/simulator/run', {
          party,
          opponent: { type: oppType.value, id: $<HTMLSelectElement>('sim-opp-id').value },
          battles: Number($<HTMLInputElement>('sim-battles').value),
          ...(seed ? { seed: Number(seed) } : {}),
          ...(versionId ? { versionId } : {}),
        });
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 300));
          const status = await fetchAdmin<SimStatus>('/api/admin/simulator/status');
          if (status.state === 'running') {
            progress.value = status.completed / status.total;
            $('sim-status').textContent = `Running... ${status.completed} / ${status.total} battles`;
            continue;
          }
          if (status.state === 'error') throw new Error(status.error ?? 'Simulation failed');
          if (status.state === 'done' && status.report) {
            $('sim-result').innerHTML = renderReport(status.report);
            $('sim-status').textContent = versionId ? 'Simulated the selected draft.' : '';
          } else {
            $('sim-status').textContent = cancelled ? 'Cancelled.' : 'Stopped.';
          }
          break;
        }
      } catch (err) {
        $('sim-status').textContent = err instanceof Error ? err.message : 'Simulation failed';
      } finally {
        button.disabled = false;
        cancel.hidden = progress.hidden = true;
      }
    });
  }
}

function opponentOptions(content: ContentData, type: OpponentType): string {
  const entries: { id: string; name: string }[] = {
    encounter: Object.values(content.encounters).map(e => ({ id: e.id, name: e.name })),
    zone: Object.values(content.zones).map(z => ({ id: z.id, name: z.displayName })),
    dungeon: Object.values(content.dungeons ?? {}).map(d => ({ id: d.id, name: d.name })),
    worldBoss: Object.values(content.worldBosses ?? {}).map(b => ({ id: b.id, name: b.name })),
  }[type];
  return entries.sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
}

function memberRow(): string {
  const classes = ALL_CLASS_NAMES.map(c => `<option value="${c}">${c}</option>`).join('');
  const slots = DISPLAY_EQUIP_SLOTS.map(slot => `<label>${slot} <select class="sim-gear" data-slot="${slot}"></select></label>`).join('');
  return `<div class="admin-form-fieldset sim-member">
    <div class="admin-form-row">
      <label>Class <select class="sim-class">${classes}</select></label>
      <label>Level <input type="number" class="sim-level" min="1" max="200" value="10"></label>
      <button class="admin-btn admin-btn-sm admin-btn-danger sim-remove" type="button">Remove</button>
    </div>
    <details><summary>Skills</summary><div class="admin-form-row sim-skills"></div></details>
    <details><summary>Gear</summary><div class="admin-form-row">${slots}</div></details>
  </div>`;
}

function refreshGear(row: HTMLElement, content: ContentData): void {
  const className = row.querySelector<HTMLSelectElement>('.sim-class')!.value;
  row.querySelectorAll<HTMLSelectElement>('.sim-gear').forEach(select => {
    const slot = select.dataset.slot as EquipSlot;
    const items = Object.values(content.items)
      .filter(i => slotAccepts(slot, i.equipSlot) && canClassUse(i, className))
      .sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = '<option value="">(empty)</option>'
      + items.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('');
  });
}

function refreshSkills(row: HTMLElement, content: ContentData): void {
  const className = row.querySelector<HTMLSelectElement>('.sim-class')!.value as ClassName;
  const level = Number(row.querySelector<HTMLInputElement>('.sim-level')!.value) || 1;
  const skillContent = { skills: content.skills, slotSchedules: content.skillSlotSchedules };
  const auto = autoSkillLoadout(className, level, skillContent);
  row.querySelector('.sim-skills')!.innerHTML = simSlotChoices(className, level, skillContent).map(slot => {
    const options = slot.options.map(s => `<option value="${escapeHtml(s.id)}"${s.id === auto[slot.slotIndex] ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    return `<label>${escapeHtml(slot.type)} ${slot.slotIndex + 1} <select class="sim-skill"${slot.unlocked ? '' : ' disabled'}><option value="">(empty)</option>${options}</select></label>`;
  }).join('');
}

function readMember(row: HTMLElement) {
  const equipment: Record<string, string> = {};
  row.querySelectorAll<HTMLSelectElement>('.sim-gear').forEach(s => { if (s.value) equipment[s.dataset.slot!] = s.value; });
  return {
    className: row.querySelector<HTMLSelectElement>('.sim-class')!.value,
    level: Number(row.querySelector<HTMLInputElement>('.sim-level')!.value),
    equipment,
    skillIds: [...row.querySelectorAll<HTMLSelectElement>('.sim-skill')].map(s => s.value || null),
  };
}

const n = (v: number, digits = 0) => v.toLocaleString(undefined, { maximumFractionDigits: digits });
const statCells = (s: SimStats, digits = 1) => `${n(s.avg, digits)} / ${n(s.median, digits)} / ${n(s.p90, digits)}`;

function renderReport(r: SimReport): string {
  const memberRows = r.members.map(m => `<tr>
    <td>${escapeHtml(m.name)}${m.isHenchman ? ' (henchman)' : ''}</td><td>${m.className} ${m.level}</td><td>${n(m.maxHp)}</td>
    <td>${n(m.damageDealt)}</td><td>${n(m.damageTaken)}</td><td>${n(m.deathsPerBattle, 2)}</td></tr>`).join('');
  const boss = r.worldBoss
    ? `<p><strong>World boss attempt:</strong> damage avg / median / p90 ${statCells(r.worldBoss.damage, 0)} of ${n(r.worldBoss.maxHp)} HP (${statCells({
      avg: r.worldBoss.damagePct.avg * 100, median: r.worldBoss.damagePct.median * 100, p90: r.worldBoss.damagePct.p90 * 100, max: 0,
    })} %)</p>` : '';
  return `
    <h3>${escapeHtml(r.opponent)} <span class="admin-form-hint">${r.battles} battles, seed ${r.seed}</span></h3>
    <p><strong>Win rate ${n(r.winRate * 100, 1)}%</strong> (${r.wins} wins, ${r.losses} losses${r.stalemates ? `, ${r.stalemates} stalemates` : ''}) &middot; deaths per battle ${n(r.deathsPerBattle, 2)}</p>
    <p>Ticks avg / median / p90: ${statCells(r.ticks)} &middot; avg cycle ${n(r.cycleSeconds, 1)}s incl. result pause</p>
    <p>Per player: ${n(r.xpPerBattle, 1)} XP and ${n(r.goldPerBattle, 1)} gold per battle &middot; <strong>${n(r.xpPerHour)} XP/h, ${n(r.goldPerHour)} gold/h</strong></p>
    ${boss}
    ${renderDrops(r)}
    <div class="admin-table-wrap"><table class="admin-table">
      <thead><tr><th>Member</th><th>Class</th><th>Max HP</th><th>Damage dealt / battle</th><th>Damage taken / battle</th><th>Deaths / battle</th></tr></thead>
      <tbody>${memberRows}</tbody></table></div>
    <p class="admin-form-hint">Effects (DoTs and other non-attack damage) dealt ${n(r.effectsDamageDealt)} per battle. Damage taken counts HP lost per tick, so healing in the same tick hides some of it. A dungeon counts as one battle per full run.</p>`;
}

function renderDrops(r: SimReport): string {
  const rows = r.drops.map(d => `<tr><td>${escapeHtml(d.name)}</td><td>${n(d.perBattle, 3)}</td><td>${n(d.perHour, 2)}</td></tr>`).join('');
  const first = r.firstClear;
  const firstItems = first?.items.map(i => `${escapeHtml(i.name)} x${n(i.expected, 2)}`).join(', ');
  return `
    <h4>Item drops (whole party, to players)</h4>
    ${rows ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Item</th><th>Per battle</th><th>Per hour</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="admin-form-hint">No item drops.</p>'}
    ${first && (first.gold || first.xp || first.items.length) ? `<p class="admin-form-hint">One-time first-clear rewards per player: ${n(first.gold)} gold, ${n(first.xp)} XP${firstItems ? `, ${firstItems} (expected)` : ''}. Not included in the hourly figures. Floor-clear rewards are.</p>` : ''}`;
}
