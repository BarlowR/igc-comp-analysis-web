// "Your flights" on the account page: claim your name in the archive, then see
// every task you flew.
//
// Pilot labels come out of IGC headers written by whatever instrument the pilot
// flew, so everything user-visible is built with createElement/textContent —
// never innerHTML.
import { claimPilot, listMyClaims, removeClaim, type PilotClaim } from '../lib/claims';
import {
  compsForPilot,
  fetchRoster,
  searchPilots,
  type Roster,
  type RosterPilot,
} from '../lib/roster';

const listEl = document.getElementById('claims-list');
const statusEl = document.getElementById('claims-status');
const formEl = document.getElementById('claim-form') as HTMLFormElement | null;
const queryEl = document.getElementById('claim-query') as HTMLInputElement | null;
const resultsEl = document.getElementById('claim-results');

let roster: Roster | null = null;
let claims: PilotClaim[] = [];

function setStatus(message: string, kind: 'ok' | 'error' | '' = '') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = kind ? `form-status ${kind}` : 'form-status';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The claimed pilot keys, each with the comps this user owns. */
function claimedPilots(): Map<string, PilotClaim[]> {
  const byKey = new Map<string, PilotClaim[]>();
  for (const claim of claims) {
    const list = byKey.get(claim.pilot_key);
    if (list) list.push(claim);
    else byKey.set(claim.pilot_key, [claim]);
  }
  return byKey;
}

function renderClaims() {
  if (!listEl) return;
  listEl.replaceChildren();

  const byKey = claimedPilots();
  if (byKey.size === 0) {
    listEl.appendChild(el('p', 'field-hint', 'No flights claimed yet.'));
    return;
  }

  for (const [key, group] of byKey) {
    const pilot = roster?.pilots.find((p) => p.key === key);
    const card = el('div', 'claim-card');

    const head = el('div', 'claim-card-head');
    head.appendChild(el('span', 'claim-name', group[0].pilot_label ?? pilot?.label ?? key));

    const drop = el('button', 'claim-remove', 'Remove');
    drop.type = 'button';
    drop.addEventListener('click', async () => {
      drop.disabled = true;
      setStatus('Removing…');
      try {
        for (const claim of group) await removeClaim(claim.id);
        claims = claims.filter((c) => c.pilot_key !== key);
        setStatus('');
        renderClaims();
      } catch (err) {
        setStatus(describe(err), 'error');
        drop.disabled = false;
      }
    });
    head.appendChild(drop);
    card.appendChild(head);

    // The tasks themselves. A name claim (day null) covers every day this pilot
    // flew in that comp; a one-off claim covers just its own day.
    const ownedComps = new Set(group.filter((c) => c.day === null).map((c) => c.comp));
    const ownedDays = new Set(
      group.filter((c) => c.day !== null).map((c) => `${c.comp}/${c.day}`),
    );
    const days = (pilot?.flights ?? [])
      .map((i) => roster!.days[i])
      .filter((d) => d && (ownedComps.has(d.comp) || ownedDays.has(`${d.comp}/${d.day}`)));

    if (days.length === 0) {
      card.appendChild(el('p', 'field-hint', 'No archived tasks found for this pilot.'));
    } else {
      let lastComp = '';
      const list = el('ul', 'claim-days');
      for (const day of days) {
        if (day.comp !== lastComp) {
          lastComp = day.comp;
          list.appendChild(el('li', 'claim-comp', day.compLabel));
        }
        const item = el('li', 'claim-day');
        const link = el('a', 'claim-day-link', day.dayLabel);
        link.href = `/archive/${day.comp}/${day.day}`;
        item.appendChild(link);
        if (day.date) item.appendChild(el('span', 'claim-day-date', day.date));
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    listEl.appendChild(card);
  }
}

function renderSearchResults(matches: RosterPilot[]) {
  if (!resultsEl || !roster) return;
  resultsEl.replaceChildren();
  if (matches.length === 0) return;

  const claimedKeys = new Set(claims.map((c) => c.pilot_key));
  for (const pilot of matches) {
    const comps = compsForPilot(roster, pilot);
    const row = el('div', 'claim-option');

    const info = el('div', 'claim-option-info');
    info.appendChild(el('span', 'claim-option-name', pilot.label));
    const taskCount = `${pilot.flights.length} task${pilot.flights.length === 1 ? '' : 's'}`;
    const compNames = comps.map((c) => c.compLabel).join(', ');
    info.appendChild(el('span', 'claim-option-meta', `${taskCount} · ${compNames}`));
    row.appendChild(info);

    const button = el('button', 'account-btn small', claimedKeys.has(pilot.key) ? 'Claimed' : 'This is me');
    button.type = 'button';
    button.disabled = claimedKeys.has(pilot.key);
    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus('Claiming…');
      try {
        const { claimed } = await claimPilot(
          pilot.key,
          pilot.label,
          comps.map((c) => c.comp),
        );
        claims = await listMyClaims();
        renderClaims();
        // Comps already on this account are a no-op, not a failure — several
        // accounts may claim the same pilot, so the only way to "fail" here is
        // to have claimed it yourself already.
        setStatus(claimed.length === 0 ? 'Already claimed.' : 'Claimed.', 'ok');
        if (queryEl) queryEl.value = '';
        resultsEl.replaceChildren();
      } catch (err) {
        setStatus(describe(err), 'error');
        button.disabled = false;
      }
    });
    row.appendChild(button);
    resultsEl.appendChild(row);
  }
}

/** Called once the user is known to be signed in. */
export async function mountClaims(): Promise<void> {
  if (!listEl) return;
  setStatus('');
  // An empty box reads as "you've claimed nothing"; say we're still looking.
  listEl.replaceChildren(el('p', 'field-hint', 'Loading your flights…'));
  try {
    [roster, claims] = await Promise.all([fetchRoster(), listMyClaims()]);
  } catch (err) {
    setStatus(describe(err), 'error');
    return;
  }
  renderClaims();

  formEl?.addEventListener('submit', (event) => event.preventDefault());
  queryEl?.addEventListener('input', () => {
    if (!roster) return;
    renderSearchResults(searchPilots(roster, queryEl.value));
  });
}
