import { describe, expect, it } from 'vitest';
import { renderActionEmail } from '../src/lib/email-templates.js';

describe('transactional e-mail templates', () => {
  it('renders a plain-text alternative and a complete HTML document with the action link', () => {
    const content = renderActionEmail({
      heading: 'Reset your password',
      paragraphs: ['Use this single-use link.'],
      actionLabel: 'Choose a new password',
      actionUrl: 'https://tasks.example.com/reset-password/abc?callbackURL=%2F',
      footer: 'Ignore this mail if you did not ask.',
    });

    expect(content.text).toContain('Reset your password');
    expect(content.text).toContain('https://tasks.example.com/reset-password/abc');
    expect(content.text).toContain('Ignore this mail');

    expect(content.html).toContain('<!doctype html>');
    expect(content.html).toContain('<a href="https://tasks.example.com/reset-password/abc?callbackURL=%2F"');
    expect(content.html).toContain('Choose a new password');
    expect(content.html).toContain('Ignore this mail if you did not ask.');
    expect(content.html).toContain('<table role="presentation"');
  });

  it('escapes every interpolated value but keeps the trusted action URL', () => {
    const content = renderActionEmail({
      heading: '<script>alert(1)</script>',
      paragraphs: ['A "quoted" <b>paragraph</b> & more'],
      actionLabel: "Accept <invite> & 'go'",
      actionUrl: 'https://tasks.example.com/invite/token?x=1&y=2',
    });

    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(content.html).toContain('A &quot;quoted&quot; &lt;b&gt;paragraph&lt;/b&gt; &amp; more');
    expect(content.html).toContain("Accept &lt;invite&gt; &amp; &#39;go&#39;");
    expect(content.html).toContain('href="https://tasks.example.com/invite/token?x=1&amp;y=2"');
  });
});
