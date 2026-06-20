import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';
import Button from './ui/Button';

/**
 * PwaUpdatePrompt — the accessible in-app replacement for the banned `window.confirm`
 * PWA update prompt (DESIGN_SYSTEM §8; `window.confirm`/`alert` are banned in UI flows).
 *
 * Driven by vite-plugin-pwa's `prompt` registerType: when a new service worker is waiting,
 * `needRefresh` flips true and we surface a labelled, aria-live banner offering a *controlled*
 * reload. This deliberately replaces the old `autoUpdate` strategy so a field worker is never
 * silently reloaded mid-task — they choose when to apply the update.
 */
export default function PwaUpdatePrompt() {
    const {
        needRefresh: [needRefresh, setNeedRefresh],
        updateServiceWorker,
    } = useRegisterSW();

    if (!needRefresh) return null;

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-toast flex justify-center px-4 pt-4"
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        >
            <div
                role="region"
                aria-label="Programos atnaujinimas"
                className="flex w-full max-w-md items-start gap-3 rounded-modal border border-line bg-surface-card p-4 shadow-xl"
            >
                <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink-strong" aria-live="polite">
                        Yra naujas turinys
                    </p>
                    <p className="text-caption text-ink-muted">
                        Įkelkite iš naujo, kad atnaujintumėte programą.
                    </p>
                    <div className="mt-3 flex gap-2">
                        <Button size="md" onClick={() => updateServiceWorker(true)}>
                            Įkelti iš naujo
                        </Button>
                        <Button variant="secondary" size="md" onClick={() => setNeedRefresh(false)}>
                            Vėliau
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
