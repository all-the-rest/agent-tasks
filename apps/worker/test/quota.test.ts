import { describe, expect, it } from 'vitest';
import { exceededExecutionLimit } from '../src/quota.js';

const limits = { maxTaskExecutionsPerDay: 5, maxConcurrentExecutionsPerUser: 2 };

describe('execution limit boundary', () => {
  it('allows the execution that still fits the daily quota', () => {
    expect(exceededExecutionLimit({ priorExecutionsToday: 4, otherRunningForOwner: 0 }, limits)).toBeNull();
  });

  it('refuses the execution that would exceed the daily quota', () => {
    expect(exceededExecutionLimit({ priorExecutionsToday: 5, otherRunningForOwner: 0 }, limits)).toBe('quota');
    expect(exceededExecutionLimit({ priorExecutionsToday: 6, otherRunningForOwner: 0 }, limits)).toBe('quota');
  });

  it('allows a running execution alongside the per-user concurrency limit', () => {
    expect(exceededExecutionLimit({ priorExecutionsToday: 0, otherRunningForOwner: 1 }, limits)).toBeNull();
  });

  it('refuses the execution that would exceed the per-user concurrency limit', () => {
    expect(exceededExecutionLimit({ priorExecutionsToday: 0, otherRunningForOwner: 2 }, limits)).toBe('concurrency');
  });

  it('reports the quota before the concurrency limit', () => {
    expect(exceededExecutionLimit({ priorExecutionsToday: 5, otherRunningForOwner: 5 }, limits)).toBe('quota');
  });
});
