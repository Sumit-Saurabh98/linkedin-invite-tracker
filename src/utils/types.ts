// Shared types for the LinkedIn Invite Tracker.

/** A single successfully-sent connection request. */
export interface Invitation {
  /** Unique id (timestamp + random). */
  id: string;
  /** Epoch milliseconds when the invite was sent. */
  sentAt: number;
  /** Recipient's display name, if we could read it from the page. */
  name: string | null;
  /** Recipient's profile URL, if available. */
  profileUrl: string | null;
}

/** User-configurable settings. */
export interface Settings {
  /**
   * The weekly limit the user believes applies to their account.
   * LinkedIn does not expose this, so the user picks it (e.g. 100/150/200/250).
   */
  weeklyLimit: number;
  /**
   * Invitations to hold in reserve. The "usable" remaining count subtracts
   * this so the user always keeps some slots for important connections.
   */
  reserved: number;
  /**
   * A limit LinkedIn effectively enforced, learned from an
   * "invitation limit reached" event. `null` until we observe one.
   */
  detectedLimit: number | null;
  /** Epoch ms of the most recent "limit reached" event, if any. */
  lastLimitReachedAt: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  weeklyLimit: 100,
  reserved: 0,
  detectedLimit: null,
  lastLimitReachedAt: null,
};

/** Messages sent from the content script to the background service worker. */
export type RuntimeMessage =
  | {
      type: "INVITATION_SENT";
      payload: { name: string | null; profileUrl: string | null };
    }
  | {
      type: "LIMIT_REACHED";
    };

/** Chrome storage keys. */
export const STORAGE_KEYS = {
  invitations: "invitations",
  settings: "settings",
} as const;

/** Length of the rolling window LinkedIn is believed to use: 7 days. */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
