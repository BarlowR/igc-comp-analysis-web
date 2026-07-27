/**
 * Controller for the shared loading screen (components/LoadingOverlay.astro):
 * advance its step line, dismiss it, or park it on an error message.
 *
 * The overlay is in the served HTML, so a page that never calls `done()` leaves
 * it up — which is the intent: it comes down when there's something behind it.
 */
export interface LoadingOverlay {
  /** Replace the step line, e.g. "Loading results… 1.2 / 4.5 MB". */
  step: (message: string) => void;
  /** Fade out and remove — the page has something to show. */
  done: () => void;
  /** Stop and say why. The overlay stays up; there's nothing behind it. */
  fail: (message: string) => void;
}

export function makeLoading(): LoadingOverlay {
  const el = document.getElementById('loading');
  const stepEl = document.getElementById('loading-step');
  const setStep = (message: string): void => {
    if (stepEl) stepEl.textContent = message;
  };
  return {
    step: setStep,
    done() {
      el?.classList.add('hidden');
      window.setTimeout(() => el?.remove(), 700);
    },
    fail(message: string) {
      el?.classList.add('error');
      setStep(message);
    },
  };
}

/** Take the overlay away now, without the fade — for swapping it for another
 * full-cover panel (the 3D sign-in gate), where a fade would show the page
 * underneath in between. */
export function removeLoading(): void {
  document.getElementById('loading')?.remove();
}
