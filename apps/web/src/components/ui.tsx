import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import type { ExecutionStatus } from '../lib/types';

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  const defaultText = t('common.loading');
  const text = label ?? defaultText;
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-live="polite">
      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
      {text ? (
        <span className="text-sm opacity-70">{text}</span>
      ) : (
        <span className="sr-only">{defaultText}</span>
      )}
    </span>
  );
}

export function ErrorAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="alert alert-error" role="alert" aria-live="assertive">
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function SuccessAlert({ message }: { message: string }) {
  return (
    <div className="alert alert-success" role="status" aria-live="polite">
      <span>{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-box border border-dashed border-base-300 bg-base-100 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-base-200 text-xl text-base-content/60" aria-hidden="true">
        ✦
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {description ? <p className="max-w-md text-sm opacity-70">{description}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm opacity-70">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

const statusClass: Record<ExecutionStatus, string> = {
  queued: 'badge-neutral',
  running: 'badge-info',
  completed: 'badge-success',
  failed: 'badge-error',
  cancelled: 'badge-warning',
  timed_out: 'badge-warning',
};

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  const { t } = useTranslation();
  return <span className={`badge badge-sm whitespace-nowrap ${statusClass[status]}`}>{t(`status.${status}`)}</span>;
}

interface FieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'false' | 'true';
  'aria-required'?: boolean | 'false' | 'true';
}

/**
 * Adds the ids of the rendered hint/error paragraphs to the control. A caller's
 * own `aria-describedby` stays intact and is merged instead of overwritten, so
 * controls that already point at custom help text keep it.
 */
function mergeIds(...values: Array<string | undefined>): string | undefined {
  const ids = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  return ids.length > 0 ? Array.from(new Set(ids)).join(' ') : undefined;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className = '',
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = mergeIds(hintId, errorId);
  // Only DOM controls are cloned: a fragment or a custom component does not
  // necessarily pass ARIA attributes through to the element that has the id.
  const control =
    isValidElement<FieldControlProps>(children) && typeof children.type === 'string'
      ? cloneElement(children, {
          'aria-describedby': mergeIds(children.props['aria-describedby'], describedBy),
          'aria-invalid': error ? true : children.props['aria-invalid'],
          'aria-required': required ? true : children.props['aria-required'],
        })
      : children;

  return (
    <div className={`flex w-full flex-col gap-1.5 ${className}`}>
      <label className="flex items-center gap-1 text-sm font-medium" htmlFor={htmlFor}>
        <span>{label}</span>
        {required ? <span className="text-error" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {hint ? (
        <p className="text-xs leading-relaxed opacity-65" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs font-medium text-error" role="alert" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ModalStackEntry {
  root: { current: HTMLDivElement | null };
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Stack of open dialogs. Only the last entry reacts to Escape and Tab, so a
 * confirmation rendered above another dialog cannot be closed together with
 * the dialog underneath it.
 */
const modalStack: ModalStackEntry[] = [];
/**
 * Element focused before the outermost dialog opened. It is kept until the
 * stack is empty so that stacked dialogs closing in an arbitrary order (or in
 * one commit) still hand focus back to the control that started the flow.
 */
let externalFocus: HTMLElement | null = null;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true',
  );
}

function isUsableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && !element.closest('[role="dialog"]');
}

function restoreFocus(previousFocus: HTMLElement | null): void {
  const topmost = modalStack[modalStack.length - 1];
  if (topmost) {
    const root = topmost.root.current;
    // The closed dialog was stacked above this one: the remembered element is
    // still visible inside the remaining dialog and is the natural target.
    if (root && previousFocus && root.contains(previousFocus)) {
      previousFocus.focus();
      return;
    }
    const target = root ? (focusableElements(root)[0] ?? root) : null;
    target?.focus();
    return;
  }
  const target = isUsableFocusTarget(externalFocus) ? externalFocus : previousFocus;
  externalFocus = null;
  // The remembered element may belong to a dialog that unmounted in the same
  // commit. Never restore focus behind a modal; dead markup is skipped too.
  if (isUsableFocusTarget(target)) target.focus();
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Keep the latest callback without making the focus effect re-run on every
  // parent render: a re-run would steal focus back to the close button after
  // each keystroke in a field inside the dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const entry: ModalStackEntry = { root: rootRef, onClose: () => onCloseRef.current() };
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modalStack.length === 0) externalFocus = previousFocus;
    modalStack.push(entry);
    closeRef.current?.focus();

    const isTopmost = () => modalStack[modalStack.length - 1] === entry;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const focusable = focusableElements(root);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && root.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopmost()) return;
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || root.contains(target)) return;
      (focusableElements(root)[0] ?? root).focus();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      restoreFocus(previousFocus);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="modal modal-open"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1}
    >
      <div className={`modal-box ${wide ? 'max-w-3xl' : ''}`}>
        <h2 id={titleId} className="pr-10 text-lg font-bold">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          className="btn btn-circle btn-ghost btn-sm absolute right-3 top-3"
          onClick={onClose}
          aria-label={t('common.closeDialog')}
        >
          ✕
        </button>
        <div className="py-4">
          {description ? (
            <p id={descriptionId} className="text-sm opacity-80">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {footer ? <div className="modal-action flex-wrap">{footer}</div> : null}
      </div>
      <div className="modal-backdrop cursor-default" aria-hidden="true" onClick={onClose} />
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  loading = false,
  danger = true,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      title={title}
      description={body}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-error' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}
const ToastContext = createContext<ToastContextValue | null>(null);

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 4_500);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  const toneClass = item.tone === 'error' ? 'alert-error' : item.tone === 'info' ? 'alert-info' : 'alert-success';
  return (
    <div className={`alert ${toneClass} shadow-lg`} role={item.tone === 'error' ? 'alert' : 'status'}>
      <span>{item.message}</span>
      <button type="button" className="btn btn-circle btn-ghost btn-xs" onClick={onDismiss} aria-label={t('common.close')}>
        ✕
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone = 'success') => {
    counter.current += 1;
    setToasts((current) => [...current, { id: counter.current, message, tone }]);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast toast-top toast-end z-50 mt-14" aria-live="polite">
        {toasts.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton h-12 w-full" />
      ))}
    </div>
  );
}
