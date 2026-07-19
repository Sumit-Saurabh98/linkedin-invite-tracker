// Background service worker: the single writer of invitation records.
// The content script only observes and reports; all storage mutation and
// limit-learning happens here.

import {
  addInvitation,
  getInvitations,
  getSettings,
  pruneExpired,
  saveSettings,
} from "../utils/storage";
import { WINDOW_MS, type RuntimeMessage } from "../utils/types";

const PRUNE_ALARM = "prune-expired";

// Prune expired invitations roughly hourly so counts stay honest even when
// the popup is never opened.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  void pruneExpired();
});

chrome.runtime.onStartup.addListener(() => {
  void pruneExpired();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) {
    void pruneExpired();
  }
});

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        console.error("[InviteTracker] message handler failed", err);
        sendResponse({ ok: false, error: String(err) });
      });
    // Return true to keep the message channel open for the async response.
    return true;
  },
);

async function handleMessage(message: RuntimeMessage): Promise<object> {
  switch (message.type) {
    case "INVITATION_SENT": {
      const invitation = await addInvitation(message.payload);
      return { invitation };
    }
    case "LIMIT_REACHED": {
      await learnLimit();
      return {};
    }
    default:
      return {};
  }
}

/**
 * When LinkedIn says the weekly limit is reached, the number of invitations
 * we currently count in the window is a lower bound on the real limit.
 * Record it as the detected limit so estimates tighten over time.
 */
async function learnLimit(): Promise<void> {
  const now = Date.now();
  const invitations = await getInvitations();
  const sentInWindow = invitations.filter(
    (inv) => inv.sentAt > now - WINDOW_MS,
  ).length;

  const settings = await getSettings();
  // Only lower our estimate (or set it the first time) — the real ceiling is
  // at most what we've counted when LinkedIn blocked us.
  const detectedLimit =
    settings.detectedLimit == null
      ? sentInWindow
      : Math.min(settings.detectedLimit, sentInWindow);

  await saveSettings({ detectedLimit, lastLimitReachedAt: now });
}
