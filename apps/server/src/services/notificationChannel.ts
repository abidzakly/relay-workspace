import type { ChannelResult, PushPayload } from '@relay/shared';

/**
 * A way to get a notification to the user (Web Push, with an optional free fallback such as
 * ntfy.sh "for guaranteed delivery"). The notifier only knows this interface, so a channel can be added
 * without touching the rules. `deliver` never throws: failures are counted in the result.
 */
export interface NotificationChannel {
  readonly name: string;
  /** False = skipped by the notifier (e.g. no VAPID keys, no ntfy topic). */
  isConfigured(): boolean;
  deliver(payload: PushPayload): Promise<ChannelResult>;
}

export const EMPTY_RESULT: ChannelResult = { attempted: 0, sent: 0, removed: 0, failed: 0 };
