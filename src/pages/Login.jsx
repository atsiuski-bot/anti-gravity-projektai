import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';

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
            return 'Jūsų paskyra sukurta ir laukia administratoriaus patvirtinimo. Susisiekite su savo vadovu.';
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

    return (
        <div className="min-h-screen flex items-center justify-center bg-surface-base px-4">
            <Card className="w-full max-w-md p-8 text-center">
                <div className="mb-1">
                    <span className="text-5xl font-extrabold tracking-tight text-ink-strong">WORK</span>
                    <span className="text-5xl font-extrabold tracking-tight text-brand">Z</span>
                </div>
                <p className="mb-8 text-body text-ink-muted">Darbo laiko apskaita</p>

                <h1 className="mb-1 text-h2 text-ink-strong">Sveiki sugrįžę</h1>
                <p className="mb-6 text-body text-ink-muted">Prisijunkite, kad matytumėte savo užduotis</p>

                {error && (
                    <div role="alert" className="mb-4 rounded-control bg-red-50 p-3 text-body text-red-700">
                        {error}
                    </div>
                )}

                <Button size="lg" fullWidth loading={loading} onClick={handleLogin} icon={GoogleIcon}>
                    {loading ? 'Jungiamasi…' : 'Prisijungti su Google'}
                </Button>
            </Card>
        </div>
    );
}
