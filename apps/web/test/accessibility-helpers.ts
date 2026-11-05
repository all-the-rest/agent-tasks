import { screen } from '@testing-library/react';
import { expect } from 'vitest';

const INTERACTIVE_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
] as const;

/** Assert that visible interactive controls expose a non-empty accessible name. */
export function expectInteractiveControlsNamed(): void {
  for (const role of INTERACTIVE_ROLES) {
    expect(screen.queryAllByRole(role, { name: '' }), `unnamed ${role} controls`).toHaveLength(0);
  }
}
