import {
  createContext,
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
  const text = label ?? t('common.loading');
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-live="polite">
      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
      {text ? <span className="text-sm opacity-70">{text}</span> : null}
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
  return (
    <div className={`flex w-full flex-col gap-1.5 ${className}`}>
      <label className="flex items-center gap-1 text-sm font-medium" htmlFor={htmlFor}>
        <span>{label}</span>
        {required ? <span className="text-error" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="text-xs leading-relaxed opacity-65" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs font-medium text-error" role="alert" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
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
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal modal-open" role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
        <div className="py-4">{children}</div>
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
    >
      <p className="text-sm opacity-80">{body}</p>
    </Modal>
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
