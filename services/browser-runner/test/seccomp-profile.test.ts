import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface SeccompRule {
  names: string[];
  action: string;
  args?: Array<{ index: number; value: number; valueTwo?: number; op: string }>;
  includes?: { caps?: string[] };
  excludes?: { caps?: string[] };
}

interface SeccompProfile {
  defaultAction: string;
  syscalls: SeccompRule[];
}

const profile = JSON.parse(
  readFileSync(new URL('../../../docker/seccomp-browser.json', import.meta.url), 'utf8'),
) as SeccompProfile;
const CLONE_NEWUSER = 0x10000000;

describe('browser runner seccomp profile', () => {
  it('denies everything that is not explicitly allowed', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it('allows unshare(CLONE_NEWUSER) without CAP_SYS_ADMIN for the Chromium userns sandbox', () => {
    const rule = profile.syscalls.find(
      (candidate) =>
        candidate.names.includes('unshare') &&
        candidate.action === 'SCMP_ACT_ALLOW' &&
        candidate.excludes?.caps?.includes('CAP_SYS_ADMIN'),
    );
    expect(rule, 'missing the unprivileged unshare(CLONE_NEWUSER) rule').toBeDefined();
    expect(rule?.args).toEqual([
      { index: 0, value: CLONE_NEWUSER, valueTwo: CLONE_NEWUSER, op: 'SCMP_CMP_MASKED_EQ' },
    ]);
  });

  it('allows clone(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET) for the namespace sandbox', () => {
    const rule = profile.syscalls.find(
      (candidate) =>
        candidate.names.includes('clone') &&
        candidate.action === 'SCMP_ACT_ALLOW' &&
        candidate.excludes?.caps?.includes('CAP_SYS_ADMIN') &&
        candidate.args?.some(
          (arg) =>
            arg.index === 0 &&
            arg.op === 'SCMP_CMP_MASKED_EQ' &&
            arg.value === CLONE_NEWUSER &&
            arg.valueTwo === CLONE_NEWUSER,
        ),
    );
    expect(rule, 'missing the clone(CLONE_NEWUSER) rule').toBeDefined();
  });

  it('allows the zygote renderer fork in new PID and NET namespaces', () => {
    for (const flag of [0x20000000, 0x40000000]) {
      const rule = profile.syscalls.find(
        (candidate) =>
          candidate.names.includes('clone') &&
          candidate.action === 'SCMP_ACT_ALLOW' &&
          candidate.excludes?.caps?.includes('CAP_SYS_ADMIN') &&
          candidate.args?.some(
            (arg) =>
              arg.index === 0 &&
              arg.op === 'SCMP_CMP_MASKED_EQ' &&
              arg.value === flag &&
              arg.valueTwo === flag,
          ),
      );
      expect(rule, `missing clone rule for flag 0x${flag.toString(16)}`).toBeDefined();
    }
  });

  it('keeps every other namespace operation behind CAP_SYS_ADMIN', () => {
    const unprivileged = profile.syscalls.filter(
      (candidate) =>
        candidate.names.includes('unshare') &&
        candidate.action === 'SCMP_ACT_ALLOW' &&
        !candidate.includes?.caps?.includes('CAP_SYS_ADMIN'),
    );
    expect(unprivileged).toHaveLength(1);
    expect(
      profile.syscalls.some(
        (candidate) =>
          candidate.names.includes('unshare') &&
          candidate.action === 'SCMP_ACT_ALLOW' &&
          candidate.includes?.caps?.includes('CAP_SYS_ADMIN'),
      ),
    ).toBe(true);
  });
});
