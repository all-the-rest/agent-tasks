import { describe, expect, it } from 'vitest';
import { classifyAddress } from '../src/index.js';

describe('smoke', () => {
  it('classifies loopback', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
  });
});
