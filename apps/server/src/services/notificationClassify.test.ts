import { describe, expect, it } from 'vitest';
import type { NotificationLive } from '@relay/shared';
import { categoryOf, classify } from './notificationActions';

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const live = (
  status: NotificationLive['status'],
  note: string | null = null,
): NotificationLive => ({
  status,
  note,
  actions: [],
});

describe('classify', () => {
  it('fresh actionable row needs action', () => {
    expect(classify({ event: 'comment', at: NOW - H }, live('actionable'), NOW)).toEqual({
      priority: 'high',
      category: 'mr',
      lifecycle: 'needs_action',
    });
  });

  it('resolved row was handled elsewhere and is low priority', () => {
    expect(
      classify({ event: 'pipelineFailed', at: NOW }, live('resolved', 'Newer pipeline ran'), NOW),
    ).toEqual({
      priority: 'low',
      category: 'pipeline',
      lifecycle: 'handled_elsewhere',
    });
  });

  it('actionable row past its threshold is stale', () => {
    expect(
      classify({ event: 'comment', at: NOW - 25 * H }, live('actionable'), NOW).lifecycle,
    ).toBe('stale');
    expect(
      classify({ event: 'readyForMr', at: NOW - 25 * H }, live('actionable'), NOW).lifecycle,
    ).toBe('needs_action');
  });

  it('threshold differs per event', () => {
    expect(
      classify({ event: 'agentDone', at: NOW - 2 * H }, live('info', 'Agent is working'), NOW)
        .lifecycle,
    ).toBe('stale');
  });

  it('unverifiable source reads as stale even when fresh', () => {
    expect(
      classify({ event: 'approved', at: NOW }, live('info', 'MR no longer tracked'), NOW).lifecycle,
    ).toBe('stale');
    expect(
      classify({ event: 'agentDone', at: NOW }, live('info', 'Agent host not reachable'), NOW)
        .lifecycle,
    ).toBe('stale');
  });

  it('priority mapping', () => {
    expect(classify({ event: 'slaBreach', at: NOW }, live('actionable'), NOW).priority).toBe(
      'urgent',
    );
    expect(classify({ event: 'pipelineFailed', at: NOW }, live('actionable'), NOW).priority).toBe(
      'urgent',
    );
    expect(
      classify({ event: 'approved', at: NOW }, live('actionable', 'Has conflicts'), NOW).priority,
    ).toBe('urgent');
    expect(classify({ event: 'slaWarn', at: NOW }, live('actionable'), NOW).priority).toBe('high');
    expect(classify({ event: 'buildDone', at: NOW }, live('actionable'), NOW).priority).toBe(
      'normal',
    );
    expect(
      classify({ event: 'approved', at: NOW }, live('info', 'Back to draft'), NOW).priority,
    ).toBe('low');
  });

  it('test notification is info and never stale', () => {
    expect(classify({ event: 'test', at: NOW - 100 * 24 * H }, live('info'), NOW)).toEqual({
      priority: 'low',
      category: 'system',
      lifecycle: 'info',
    });
  });

  it('maps every event to a category', () => {
    expect(categoryOf('buildDone')).toBe('build');
    expect(categoryOf('agentDone')).toBe('agent');
    expect(categoryOf('mismatch')).toBe('system');
    expect(categoryOf('slaWarn')).toBe('sla');
  });
});
