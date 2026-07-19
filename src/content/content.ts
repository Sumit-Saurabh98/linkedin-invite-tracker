// Content script: passively observes normal user actions on linkedin.com and
// reports two things to the background worker — a successful invitation send,
// and LinkedIn showing an "invitation limit reached" message.
//
// It uses NO LinkedIn API and no automation. It only listens to clicks the
// user makes and watches the DOM for LinkedIn's own confirmation UI. LinkedIn
// markup changes often, so detection is intentionally tolerant: multiple
// signals, and a short confirmation window after a candidate click.

import type { RuntimeMessage } from "../utils/types";

const LOG_PREFIX = "[InviteTracker]";

/** Send-invite button labels LinkedIn uses across its surfaces. */
const SEND_LABELS = [
  "send invitation",
  "send now",
  "send without a note",
  "send invite",
];

/** Text that indicates LinkedIn confirmed an invite was sent (a toast). */
const SUCCESS_PATTERNS = [
  /invitation sent/i,
  /your invitation to .+ was sent/i,
  /invitation to .+ sent/i,
];

/** Text that indicates the weekly invitation limit was hit. */
const LIMIT_PATTERNS = [
  /you.?ve reached the weekly invitation limit/i,
  /reached the weekly invitation limit/i,
  /no free personalized invitations left/i,
  /you.?re out of invitations/i,
];

function send(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch((err) => {
    // The worker may be asleep; sendMessage still wakes it. Log only.
    console.debug(LOG_PREFIX, "sendMessage error", err);
  });
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Best-effort recipient name from a connect modal or nearby profile heading. */
function extractRecipientName(): string | null {
  // The "Add a note" / send modal often reads "…to your invitation to NAME".
  const modal = document.querySelector<HTMLElement>(
    '[role="dialog"], .artdeco-modal',
  );
  const modalText = normalize(modal?.textContent);
  const m = modalText.match(/invitation to ([^.?!]+?)(?:[.?!]|$)/i);
  if (m) return normalize(m[1]) || null;

  // Fall back to the profile page's main heading.
  const heading = document.querySelector<HTMLElement>("h1");
  const name = normalize(heading?.textContent);
  return name || null;
}

/** Recipient profile URL if we're on a profile page. */
function extractProfileUrl(): string | null {
  const { href } = window.location;
  return /linkedin\.com\/in\//.test(href) ? href.split("?")[0] : null;
}

/**
 * Watch the DOM briefly for a success toast or limit message after a candidate
 * send-click. Resolves the first matching signal, or null on timeout.
 */
function awaitOutcome(
  timeoutMs = 4000,
): Promise<"sent" | "limit" | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: "sent" | "limit" | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(result);
    };

    const scan = (root: ParentNode) => {
      const text = normalize((root as HTMLElement).textContent);
      if (!text) return;
      if (LIMIT_PATTERNS.some((re) => re.test(text))) return finish("limit");
      if (SUCCESS_PATTERNS.some((re) => re.test(text))) return finish("sent");
    };

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node as ParentNode);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also scan what's already on screen (toast may appear before we observe).
    scan(document.body);

    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function looksLikeSendButton(el: Element): boolean {
  const button = el.closest("button");
  if (!button) return false;
  const label = normalize(
    button.getAttribute("aria-label") || button.textContent,
  ).toLowerCase();
  return SEND_LABELS.some((l) => label === l || label.includes(l));
}

// Capture-phase click listener so we read the recipient before the modal
// closes. We do not block or alter the click.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as Element | null;
    if (!target || !looksLikeSendButton(target)) return;

    // Grab context now — the modal disappears once the send completes.
    const name = extractRecipientName();
    const profileUrl = extractProfileUrl();

    void awaitOutcome().then((outcome) => {
      if (outcome === "sent") {
        console.debug(LOG_PREFIX, "invitation sent →", name);
        send({ type: "INVITATION_SENT", payload: { name, profileUrl } });
      } else if (outcome === "limit") {
        console.debug(LOG_PREFIX, "limit reached");
        send({ type: "LIMIT_REACHED" });
      }
    });
  },
  true,
);

// A limit message can also appear without a send-click (e.g. on opening the
// connect flow). Watch the page for it independently, at a light cadence.
let lastLimitReport = 0;
const limitObserver = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastLimitReport < 60_000) return; // debounce
  const text = normalize(document.body.textContent);
  if (LIMIT_PATTERNS.some((re) => re.test(text))) {
    lastLimitReport = now;
    send({ type: "LIMIT_REACHED" });
  }
});
limitObserver.observe(document.body, { childList: true, subtree: true });

console.debug(LOG_PREFIX, "content script loaded");
