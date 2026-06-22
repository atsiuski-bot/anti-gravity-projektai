import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Bell, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import IconButton from '../components/ui/IconButton';

/**
 * Minimal, accessible toast system. There was none before (the only "z-toast" use was the
 * offline banner). Used for the foreground "new notification" alert and available app-wide via
 * useToast().showToast(message, { title, tone, duration, onClick }).
 */
const ToastContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with its provider; dev-HMR-only lint.
export function useToast() {
    return useContext(ToastContext) || { showToast: () => {}, dismiss: () => {} };
}

const TONES = {
    info: { icon: Info, accent: 'text-brand', ring: 'border-line' },
    success: { icon: CheckCircle2, accent: 'text-feedback-success', ring: 'border-feedback-success/40' },
    warning: { icon: AlertCircle, accent: 'text-amber-600', ring: 'border-amber-200' },
    notification: { icon: Bell, accent: 'text-brand', ring: 'border-line' }
};

let counter = 0;

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
        setToasts((prev) => [...prev, {
            id,
            message,
            title: opts.title,
            tone: opts.tone || 'info',
            onClick: opts.onClick
        }]);
        const duration = opts.duration ?? 5000;
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
                    {toasts.map((t) => {
                        const tone = TONES[t.tone] || TONES.info;
                        const Icon = tone.icon;
                        return (
                            <div
                                key={t.id}
                                role="status"
                                aria-live="polite"
                                className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border ${tone.ring} bg-surface-card p-3 shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2`}
                            >
                                <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${tone.accent}`} aria-hidden="true" />
                                <button
                                    type="button"
                                    onClick={() => { t.onClick?.(); dismiss(t.id); }}
                                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                                >
                                    {t.title && <p className="text-body font-semibold text-ink-strong">{t.title}</p>}
                                    <p className="text-body text-ink break-words">{t.message}</p>
                                </button>
                                <IconButton icon={X} label="Uždaryti" onClick={() => dismiss(t.id)} className="-mr-1 -mt-1" />
                            </div>
                        );
                    })}
                </div>,
                document.body
            )}
        </ToastContext.Provider>
    );
}
