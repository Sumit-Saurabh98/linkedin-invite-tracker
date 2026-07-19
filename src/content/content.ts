// Content script: passively observes normal user actions on linkedin.com and
// reports two things to the background worker — a successful invitation send,
// and LinkedIn showing an "invitation limit reached" message.
//
// It uses NO LinkedIn API and no automation. It only listens to clicks the
// user makes and watches the DOM for LinkedIn's own UI.
//
// LinkedIn commits an invitation on exactly one of two clicks:
//   1. A "direct connect" button — aria-label "Invite <Name> to connect".
//      On most surfaces (feed, search, People You May Know) this sends
//      immediately; on some it first opens an "Add a note" dialog.
//   2. A dialog send button — "Send", "Send without a note", "Send now",
//      "Send invitation" — inside a connect/invitation dialog.
//
// After such a commit click LinkedIn either sends, or shows the weekly-limit
// message. So rather than depend on a fragile success-toast string, we treat a
// commit click as a send *unless* the limit message appears right after. When a
// direct-connect click merely opens a note dialog, we skip it and let the
// dialog's own send button be the commit (so we never double-count).

import type { RuntimeMessage } from "../utils/types";

const LOG_PREFIX = "[InviteTracker]";

/** Dialog send-button labels LinkedIn uses across its surfaces. */
const SEND_LABELS = [
  "send invitation",
  "send now",
  "send without a note",
  "send invite",
  "send",
];

/** aria-label of a direct-connect button, e.g. "Invite Jane Doe to connect". */
const DIRECT_CONNECT_RE = /^invite\s+(.+?)\s+to connect$/i;

/** Text signalling the weekly invitation limit was hit. */
const LIMIT_PATTERNS = [
  /reached the weekly invitation limit/i,
  /weekly invitation limit/i,
  /no free personalized invitations left/i,
  /you.?re out of invitations/i,
  /invitations? limit reached/i,
];

/** Text confirming a dialog is a connect/invitation dialog (not messaging). */
const INVITE_DIALOG_RE =
  /invitation|add a note|grow your network|connect with|invite|personalize/i;

function send(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch((err) => {
    // The worker may be asleep; sendMessage still wakes it. Log only.
    console.debug(LOG_PREFIX, "sendMessage error", err);
  });
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function limitVisible(): boolean {
  const text = normalize(document.body.textContent);
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Recipient profile URL — from the page if on a profile, else a nearby link. */
function extractProfileUrl(fromButton?: Element | null): string | null {
  const { href } = window.location;
  if (/linkedin\.com\/in\//.test(href)) return href.split("?")[0];

  // Walk up from the button to the enclosing card and grab its profile link.
  let el: Element | null | undefined = fromButton;
  for (let i = 0; el && i < 8; i++) {
    const a = el.querySelector?.('a[href*="/in/"]') as HTMLAnchorElement | null;
    if (a?.href) return a.href.split("?")[0];
    el = el.parentElement;
  }
  return null;
}

/** Recipient name — from the direct-connect label, dialog text, or heading. */
function extractRecipientName(
  directLabelName?: string | null,
): string | null {
  if (directLabelName) return normalize(directLabelName) || null;

  const dialog = openDialog();
  const dialogText = normalize(dialog?.textContent);
  const m = dialogText.match(/invitation to ([^.?!]+?)(?:[.?!]|$)/i);
  if (m) return normalize(m[1]) || null;

  const heading = document.querySelector<HTMLElement>("h1");
  return normalize(heading?.textContent) || null;
}

function classifyButton(el: Element): {
  kind: "direct" | "dialog-send";
  name: string | null;
  button: HTMLButtonElement;
} | null {
  const button = el.closest("button");
  if (!button) return null;
  const label = normalize(button.getAttribute("aria-label"));
  const text = normalize(button.textContent).toLowerCase();

  const direct = label.match(DIRECT_CONNECT_RE);
  if (direct) {
    return { kind: "direct", name: direct[1], button };
  }

  const combined = `${label.toLowerCase()} ${text}`.trim();
  const isSend = SEND_LABELS.some(
    (l) => label.toLowerCase() === l || text === l || combined.includes(l),
  );
  if (isSend) {
    // Only count a "Send" that lives inside a connect/invitation dialog,
    // otherwise messaging's own Send button would be mistaken for an invite.
    const dialog = button.closest('[role="dialog"]') ?? openDialog();
    if (dialog && INVITE_DIALOG_RE.test(normalize(dialog.textContent))) {
      return { kind: "dialog-send", name: null, button };
    }
  }
  return null;
}

// De-dupe rapid double-fires of the same logical send.
let lastCommitAt = 0;

// Capture phase so we read context before LinkedIn mutates/closes the dialog.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const info = classifyButton(target);
    if (!info) return;

    const name = extractRecipientName(info.name);
    const profileUrl = extractProfileUrl(info.button);

    // Give LinkedIn a moment to either open a note dialog, send, or show
    // the limit message.
    window.setTimeout(() => {
      if (limitVisible()) {
        console.debug(LOG_PREFIX, "limit reached");
        send({ type: "LIMIT_REACHED" });
        return;
      }

      if (info.kind === "direct") {
        // If a note dialog opened, this click didn't commit — the dialog's
        // Send button will. Skip so we don't double-count.
        const dialog = openDialog();
        if (dialog && INVITE_DIALOG_RE.test(normalize(dialog.textContent))) {
          console.debug(LOG_PREFIX, "connect opened note dialog; awaiting send");
          return;
        }
      }

      const now = Date.now();
      if (now - lastCommitAt < 1500) return; // de-dupe
      lastCommitAt = now;

      console.debug(LOG_PREFIX, "invitation sent →", name || "(unknown)");
      send({ type: "INVITATION_SENT", payload: { name, profileUrl } });
    }, 900);
  },
  true,
);

// A limit message can also appear without a send-click. Watch for it
// independently, debounced.
let lastLimitReport = 0;
const limitObserver = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastLimitReport < 60_000) return;
  if (limitVisible()) {
    lastLimitReport = now;
    send({ type: "LIMIT_REACHED" });
  }
});
limitObserver.observe(document.body, { childList: true, subtree: true });

console.debug(LOG_PREFIX, "content script loaded");
