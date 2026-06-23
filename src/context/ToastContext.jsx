import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Bell, CheckCircle2, AlertCircle, Info, RotateCcw } from 'lucide-react';
import IconButton from '../components/ui/IconButton';

/**
 * Minimal, accessible toast system. There was none before (the only "z-toast" use was the
 * offline banner). Used for the foreground "new notification" alert and the transient UNDO
 * snackbar, and available app-wide via
 * useToast().showToast(message, { title, tone, duration, onClick, action }).
 *
 * `action: { label, onClick }` renders a discrete, ≥44px, brand-tinted action button (the canonical
 * "Atšaukti" undo affordance — DESIGN_SYSTEM §8). When a finite `duration` is set the card also
 * shows a thin draining countdown bar so the closing window is visible (the "appears for a few
 * seconds" deadline). The bar animates `transform: scaleX` only (GPU-safe, §12) and is neutralised
 * by the reduced-motion guard — purely decorative, the JS timer still owns dismissal.
 */
const ToastContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with its provider; dev-HMR-only lint.
export function useToast() {
    return useContext(ToastContext) || { showToast: () => {}, dismiss: () => {} };
}

const TONES = {
    info: { icon: Info, accent: 'text-brand', ring: 'border-line', bar: 'bg-brand' },
    success: { icon: CheckCircle2, accent: 'text-feedback-success', ring: 'border-feedback-success/40', bar: 'bg-feedback-success' },
    warning: { icon: AlertCircle, accent: 'text-feedback-warning', ring: 'border-feedback-warning-border', bar: 'bg-feedback-warning' },
    notification: { icon: Bell, accent: 'text-brand', ring: 'border-line', bar: 'bg-brand' }
};

let counter = 0;

/**
 * One toast row. Owns its own countdown-bar animation: the bar starts full and eases to empty over
 * the toast's lifetime on a linear transform transition, so the user can see the undo window close.
 */
function ToastCard({ toast, onAction, onDismiss }) {
    const tone = TONES[toast.tone] || TONES.info;
    const Icon = tone.icon;
    const showBar = toast.action && toast.duration > 0;
    const [draining, setDraining] = useState(false);

    useEffect(() => {
        if (!showBar) return undefined;
        // Kick the transition on the next frame so the browser registers the full→empty change.
        const raf = requestAnimationFrame(() => setDraining(true));
        return () => cancelAnimationFrame(raf);
    }, [showBar]);

    return (
        <div
            role="status"
            aria-live="polite"
            className={`pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-card border ${tone.ring} bg-surface-card p-3 shadow-lg animate-in fade-in slide-in-from-top-2`}
        >
            <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${tone.accent}`} aria-hidden="true" />
            {toast.onClick ? (
                <button
                    type="button"
                    onClick={() => { toast.onClick?.(); onDismiss(); }}
                    className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    {toast.title && <p className="text-body font-semibold text-ink-strong">{toast.title}</p>}
                    <p className="text-body text-ink break-words">{toast.message}</p>
                </button>
            ) : (
                <div className="min-w-0 flex-1">
                    {toast.title && <p className="text-body font-semibold text-ink-strong">{toast.title}</p>}
                    <p className="text-body text-ink break-words">{toast.message}</p>
                </div>
            )}
            {toast.action && (
                <button
                    type="button"
                    onClick={onAction}
                    className="inline-flex min-h-touch flex-shrink-0 items-center gap-1.5 self-center rounded-full bg-brand-soft px-3 font-semibold text-brand transition duration-base hover:bg-brand-soft/70 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    <span className="text-body">{toast.action.label}</span>
                </button>
            )}
            <IconButton icon={X} label="Uždaryti" onClick={onDismiss} className="-mr-1 -mt-1 flex-shrink-0" />
            {showBar && (
                <span
                    aria-hidden="true"
                    className={`absolute inset-x-0 bottom-0 h-0.5 origin-left ${tone.bar} opacity-60`}
                    style={{
                        transform: draining ? 'scaleX(0)' : 'scaleX(1)',
                        transition: `transform ${toast.duration}ms linear`
                    }}
                />
            )}
        </div>
    );
}

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const timers = useRef({});

    const dismiss = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        if (timers.current[id]) {
            clearTimeout(timers.current[id]);
            delete timers.current[id];
        }
    }, []);

    const showToast = useCallback((message, opts = {}) => {
        counter += 1;
        const id = counter;
        const duration = opts.duration ?? 5000;
        setToasts((prev) => [...prev, {
            id,
            message,
            title: opts.title,
            tone: opts.tone || 'info',
            onClick: opts.onClick,
            action: opts.action,
            duration
        }]);
        if (duration > 0) {
            timers.current[id] = setTimeout(() => dismiss(id), duration);
        }
        return id;
    }, [dismiss]);

    return (
        <ToastContext.Provider value={{ showToast, dismiss }}>
            {children}
            {createPortal(
                <div
                    className="pointer-events-none fixed inset-x-0 top-2 z-toast flex flex-col items-center gap-2 px-3"
                    role="region"
                    aria-label="Pranešimai"
                >
                    {toasts.map((t) => (
                        <ToastCard
                            key={t.id}
                            toast={t}
                            onAction={() => { t.action?.onClick?.(); dismiss(t.id); }}
                            onDismiss={() => dismiss(t.id)}
                        />
                    ))}
                </div>,
                document.body
            )}
        </ToastContext.Provider>
    );
}
