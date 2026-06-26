import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import BrandMark from '../components/ui/BrandMark';
import { auth } from '../firebase';

/** The Google "G" mark. Monochrome (currentColor) so it sits cleanly on the brand button. */
function GoogleIcon({ className }) {
    return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
    );
}

/** Map Firebase auth errors to friendly Lithuanian copy — never show raw err.message (§10). */
function loginErrorMessage(err) {
    switch (err?.code) {
        case 'app/pending-approval':
            return 'Jūsų paskyra sukurta ir laukia patvirtinimo. Kai administratorius ją patvirtins, galėsite prisijungti. Norėdami paspartinti — kreipkitės į savo koordinatorių.';
        case 'app/account-disabled':
            return 'Jūsų paskyra užblokuota. Susisiekite su administratoriumi.';
        case 'auth/popup-blocked':
            return 'Naršyklė užblokavo prisijungimo langą. Leiskite iškylančius langus šiai svetainei ir bandykite dar kartą.';
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
            return 'Prisijungimas nutrauktas. Bandykite dar kartą.';
        case 'auth/network-request-failed':
            return 'Nepavyko prisijungti dėl tinklo ryšio. Patikrinkite ryšį ir bandykite dar kartą.';
        default:
            return 'Nepavyko prisijungti. Bandykite dar kartą.';
    }
}

export default function Login() {
    const { login, currentUser } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    // ── DEV-only test login ──────────────────────────────────────────────────
    // A popup-free email/password sign-in for local visual QA (the Google popup
    // cannot be driven by an automated browser, so nothing ever got app-verified).
    // The ENTIRE surface — these initialisers, the handler body, and the panel in
    // the markup — is gated by import.meta.env.DEV, which Vite hard-codes to `false`
    // in `vite build`; Rollup then dead-code-eliminates all of it from the production
    // bundle (same pattern as the "Skip Loading" debug button in AuthContext).
    // Credentials come from .env.local (gitignored) — never hard-coded, never shipped.
    // Full procedure + teardown: docs/runbooks/visual-qa-test-account.md.
    const [devEmail, setDevEmail] = useState(
        import.meta.env.DEV ? (import.meta.env.VITE_DEV_LOGIN_EMAIL || '') : ''
    );
    const [devPassword, setDevPassword] = useState(
        import.meta.env.DEV ? (import.meta.env.VITE_DEV_LOGIN_PASSWORD || '') : ''
    );
    const [devError, setDevError] = useState('');
    const [devLoading, setDevLoading] = useState(false);

    useEffect(() => {
        if (currentUser) {
            navigate('/');
        }
    }, [currentUser, navigate]);

    async function handleLogin() {
        try {
            setError('');
            setLoading(true);
            await login();
            // Navigation handled by the useEffect above when currentUser changes.
        } catch (err) {
            setError(loginErrorMessage(err));
            console.error('Login component error:', err);
            setLoading(false);
        }
    }

    async function handleDevLogin(e) {
        e.preventDefault();
        // Hard runtime guard on top of the DEV-gated UI: in a production build this
        // is `if (true) return`, so the dynamic firebase/auth import below is dead
        // code and gets tree-shaken out entirely.
        if (!import.meta.env.DEV) return;
        setDevError('');
        setDevLoading(true);
        try {
            const { signInWithEmailAndPassword } = await import('firebase/auth');
            await signInWithEmailAndPassword(auth, devEmail.trim(), devPassword);
            // The currentUser effect above redirects to '/' once auth state resolves.
        } catch (err) {
            // DEV-only surface — show the raw Firebase code so setup errors are
            // debuggable (e.g. auth/operation-not-allowed = provider not enabled).
            setDevError(err?.code || err?.message || 'Dev login failed');
            setDevLoading(false);
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-surface-base px-4">
            <Card className="w-full max-w-md p-8 text-center">
                {/* Brand lockup: logo + wordmark. The hero pieces fade-and-rise in a short stagger
                    on mount (login screen); the logo keeps a barely-there idle float and switches
                    to a soft breathing pulse while signing in (login metu). All reduced-motion-safe. */}
                <div className="animate-in fade-in zoom-in-95 duration-500 mb-4 flex justify-center">
                    <BrandMark size="lg" animated loading={loading} />
                </div>
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 wz-delay-1 mb-1">
                    <span className="text-5xl font-extrabold tracking-tight text-ink-strong">Gildija</span>
                </div>
                <p className="animate-in fade-in slide-in-from-bottom-2 duration-500 wz-delay-2 mb-8 text-body text-ink-muted">Veiklos laiko apskaita</p>

                <h1 className="animate-in fade-in slide-in-from-bottom-2 duration-500 wz-delay-2 mb-1 text-h2 text-ink-strong">Sveiki sugrįžę</h1>
                <p className="animate-in fade-in slide-in-from-bottom-2 duration-500 wz-delay-3 mb-6 text-body text-ink-muted">Prisijunkite, kad matytumėte savo užduotis</p>

                {error && (
                    <div role="alert" className="mb-4 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
                        {error}
                    </div>
                )}

                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 wz-delay-4">
                    <Button size="lg" fullWidth loading={loading} onClick={handleLogin} icon={GoogleIcon}>
                        {loading ? 'Jungiamasi…' : 'Prisijungti su Google'}
                    </Button>
                </div>

                {/* DEV-only test login — stripped from production builds (see handler comment). */}
                {import.meta.env.DEV && (
                    <form onSubmit={handleDevLogin} className="mt-6 rounded-control border border-dashed border-line p-4 text-left">
                        <p className="mb-3 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                            DEV testavimas · nematoma produkcijoje
                        </p>
                        <label htmlFor="dev-email" className="mb-1 block text-caption text-ink-muted">El. paštas</label>
                        <input
                            id="dev-email"
                            type="email"
                            autoComplete="username"
                            value={devEmail}
                            onChange={(e) => setDevEmail(e.target.value)}
                            className="mb-3 min-h-touch w-full rounded-control border border-line bg-surface-card px-3 py-2 text-body text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand"
                        />
                        <label htmlFor="dev-password" className="mb-1 block text-caption text-ink-muted">Slaptažodis</label>
                        <input
                            id="dev-password"
                            type="password"
                            autoComplete="current-password"
                            value={devPassword}
                            onChange={(e) => setDevPassword(e.target.value)}
                            className="mb-3 min-h-touch w-full rounded-control border border-line bg-surface-card px-3 py-2 text-body text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand"
                        />
                        {devError && (
                            <p role="alert" className="mb-3 text-caption text-feedback-danger">{devError}</p>
                        )}
                        <Button type="submit" variant="secondary" size="md" fullWidth loading={devLoading}>
                            {devLoading ? 'Jungiamasi…' : 'Prisijungti (DEV)'}
                        </Button>
                    </form>
                )}
            </Card>
        </div>
    );
}
