// "Claim your result" on an archived day page.
//
// Name-level claims (the account page) assume the name on a result is yours.
// That breaks whenever a tracker is borrowed or shared — the flight is yours,
// the name isn't — so this claims exactly one task and asserts nothing about
// the name.
//
// The day page already ships a ~2 MB results JSON, so cost matters here: the
// 209 KB Supabase SDK is only loaded once readCachedSession() says someone is
// signed in. Signed-out visitors get a link and nothing else.
import { claimDay, listMyClaimsForDay, removeClaim, type PilotClaim } from '../lib/claims';
import { fetchRoster, pilotsForDay, type RosterPilot } from '../lib/roster';
import { isConfigured, readCachedSession } from '../lib/supabase';

interface DayRef {
  comp: string;
  day: string;
}

const card = document.getElementById('day-claim');
const body = document.getElementById('day-claim-body');
const statusEl = document.getElementById('day-claim-status');

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

function setStatus(message: string, kind: 'ok' | 'error' | '' = '') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = kind ? `form-status ${kind}` : 'form-status';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readDayRef(): DayRef | null {
  const raw = document.getElementById('archive-entry')?.textContent;
  if (!raw) return null;
  // "/archive/<comp>/<day>"
  const base = (JSON.parse(raw) as { base?: string }).base ?? '';
  const parts = base.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return { comp: parts[1], day: parts[2] };
}

/** Signed-out: one link, no SDK, no roster fetch. */
function renderSignedOut() {
  if (!body) return;
  const p = el('p', 'field-hint');
  p.append('Flew this task? ');
  const link = el('a', 'day-claim-link', 'Sign in');
  link.href = '/account';
  p.append(link, ' to add it to your flights.');
  body.replaceChildren(p);
}

function renderClaimed(claims: PilotClaim[], onChanged: () => void) {
  if (!body) return;
  const list = el('div', 'day-claim-mine');

  for (const claim of claims) {
    const row = el('div', 'day-claim-row');
    row.appendChild(el('span', 'day-claim-name', claim.pilot_label ?? claim.pilot_key));
    row.appendChild(
      el(
        'span',
        'day-claim-scope',
        claim.day === null ? 'claimed for the whole comp' : 'claimed for this task',
      ),
    );

    // A comp-wide claim is managed on the account page — dropping it here would
    // silently remove the pilot's other tasks too.
    if (claim.day !== null) {
      const drop = el('button', 'claim-remove', 'Remove');
      drop.type = 'button';
      drop.addEventListener('click', async () => {
        drop.disabled = true;
        setStatus('Removing…');
        try {
          await removeClaim(claim.id);
          setStatus('');
          onChanged();
        } catch (err) {
          setStatus(describe(err), 'error');
          drop.disabled = false;
        }
      });
      row.appendChild(drop);
    }
    list.appendChild(row);
  }
  body.replaceChildren(list);
}

function renderPicker(pilots: RosterPilot[], ref: DayRef, onChanged: () => void) {
  if (!body) return;
  if (pilots.length === 0) {
    body.replaceChildren(el('p', 'field-hint', 'No tracks found for this task.'));
    return;
  }

  const form = el('form', 'day-claim-form');
  const label = el('label', 'field-label', 'Which result is yours?');
  label.htmlFor = 'day-claim-pilot';

  const select = el('select', 'day-claim-select');
  select.id = 'day-claim-pilot';
  const placeholder = el('option', undefined, 'Choose a pilot…');
  placeholder.value = '';
  select.appendChild(placeholder);
  for (const pilot of pilots) {
    const option = el('option', undefined, pilot.label);
    option.value = pilot.key;
    select.appendChild(option);
  }

  const button = el('button', 'account-btn small', 'This is me');
  button.type = 'submit';

  form.append(label, select, button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pilot = pilots.find((p) => p.key === select.value);
    if (!pilot) {
      setStatus('Pick a pilot first.', 'error');
      return;
    }
    button.disabled = true;
    setStatus('Claiming…');
    try {
      const added = await claimDay(ref.comp, ref.day, pilot.key, pilot.label);
      setStatus(added ? 'Claimed.' : 'Already claimed.', 'ok');
      onChanged();
    } catch (err) {
      setStatus(describe(err), 'error');
      button.disabled = false;
    }
  });

  const hint = el(
    'p',
    'field-hint',
    'This claims only this task — use it when the name on your result belongs to a borrowed or shared tracker.',
  );
  body.replaceChildren(form, hint);
}

async function mount() {
  if (!card || !body || !isConfigured) return;
  const ref = readDayRef();
  if (!ref) return;

  card.removeAttribute('hidden');

  if (!readCachedSession()) {
    renderSignedOut();
    return;
  }

  const refresh = async (): Promise<void> => {
    try {
      const [roster, claims] = await Promise.all([
        fetchRoster(),
        listMyClaimsForDay(ref.comp, ref.day),
      ]);
      if (claims.length > 0) renderClaimed(claims, () => void refresh());
      else renderPicker(pilotsForDay(roster, ref.comp, ref.day), ref, () => void refresh());
    } catch (err) {
      // An expired cached session lands here; the account page will sort it out.
      setStatus(describe(err), 'error');
      renderSignedOut();
    }
  };
  await refresh();
}

void mount();
