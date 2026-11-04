import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface TablistControls<T extends string> {
  tabProps: (value: T) => {
    id: string;
    role: 'tab';
    'aria-selected': boolean;
    'aria-controls': string;
    tabIndex: number;
    ref: (node: HTMLButtonElement | null) => void;
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
  panelProps: (value: T) => {
    id: string;
    role: 'tabpanel';
    'aria-labelledby': string;
    tabIndex: number;
    hidden: boolean;
  };
}

/**
 * WAI-ARIA tabs with roving tabindex and automatic activation.
 *
 * Every tab keeps a stable `aria-controls` target: the matching panel must stay
 * mounted and be hidden with the `hidden` attribute while it is not selected.
 * Arrow keys wrap around, Home/End jump to the first/last tab, and focus moves
 * with the selection so keyboard users do not lose their place.
 */
export function useTablist<T extends string>(
  values: readonly T[],
  active: T,
  onChange: (value: T) => void,
  idPrefix: string,
): TablistControls<T> {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const select = (value: T) => {
    onChange(value);
    refs.current.get(value)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: T) => {
    const index = values.indexOf(value);
    if (index < 0) return;

    let next: T | undefined;
    switch (event.key) {
      case 'ArrowRight':
        next = values[(index + 1) % values.length];
        break;
      case 'ArrowLeft':
        next = values[(index - 1 + values.length) % values.length];
        break;
      case 'Home':
        next = values[0];
        break;
      case 'End':
        next = values[values.length - 1];
        break;
      default:
        return;
    }
    if (next === undefined) return;

    event.preventDefault();
    select(next);
  };

  return {
    tabProps: (value) => ({
      id: `${idPrefix}-tab-${value}`,
      role: 'tab',
      'aria-selected': value === active,
      'aria-controls': `${idPrefix}-panel-${value}`,
      tabIndex: value === active ? 0 : -1,
      ref: (node) => {
        if (node) refs.current.set(value, node);
        else refs.current.delete(value);
      },
      onKeyDown: (event) => handleKeyDown(event, value),
      onClick: () => select(value),
    }),
    panelProps: (value) => ({
      id: `${idPrefix}-panel-${value}`,
      role: 'tabpanel',
      'aria-labelledby': `${idPrefix}-tab-${value}`,
      tabIndex: 0,
      hidden: value !== active,
    }),
  };
}
