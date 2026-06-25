import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import Modal from './ui/Modal';
import Button from './ui/Button';
import SessionTypeIcon from './SessionTypeIcon';
import { SESSION_TYPES, SESSION_COLORS } from '../utils/sessionColors';
import { cn } from '../utils/cn';

/**
 * OnboardingWelcome — a one-time first-run welcome shown to a newly approved Vykdytojas.
 *
 * Gating (all must hold): the user is a worker, their account was created recently
 * (so existing veterans are never disrupted — legacy docs without `createdAt` are treated
 * as "old" and skipped), and they have not yet dismissed the welcome. The "seen" flag lives
 * in `user_settings/{uid}` (owner read/write under the existing rules — no rules change), so
 * dismissing it persists across devices.
 *
 * The colour legend is built from the single SESSION_COLORS map (DESIGN_SYSTEM §4-B), so it
 * can never drift from the real shell colours, and each row pairs the colour with an icon and
 * a text label (§5 — colour is never the sole signal).
 */

// Only greet accounts created within this window — a genuinely new Vykdytojas, not a veteran
// logging in for the first time after the feature ships.
const WELCOME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const STEPS = [
    {
        title: 'Jūsų užduotys',
        body: 'Skiltyje „Veiklos" matysite jums priskirtas užduotis. Veiklą pradėkite paspaudę „Pradėti".',
    },
    {
        title: 'Pertraukos ir skambučiai',
        body: 'Pertrauką, skambutį ar greitą veiklą pažymėkite mygtukais apačioje — laikas skaičiuojamas automatiškai.',
    },
    {
        title: 'Profilis ir veiklos laikas',
        body: 'Profilyje nustatykite nuotrauką, o kalendoriuje suplanuokite savo veiklos laiką.',
    },
];

export default function OnboardingWelcome() {
    const { currentUser, userData, userRole } = useAuth();
    const [open, setOpen] = useState(false);
    // Latches once the gate has been evaluated, so the settings read runs at most once per mount.
    const [checked, setChecked] = useState(false);

    useEffect(() => {
        if (checked || !currentUser || !userData) return;
        if (userRole !== 'worker') { setChecked(true); return; }

        const createdAtMs = userData.createdAt ? new Date(userData.createdAt).getTime() : NaN;
        if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs > WELCOME_MAX_AGE_MS) {
            setChecked(true);
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const snap = await getDoc(doc(db, 'user_settings', currentUser.uid));
                const seen = snap.exists() && snap.data().onboardingWelcomeSeen === true;
                if (!cancelled && !seen) setOpen(true);
            } catch {
                /* A settings read failure must never block the app — just skip the welcome. */
            } finally {
                if (!cancelled) setChecked(true);
            }
        })();

        return () => { cancelled = true; };
    }, [checked, currentUser, userData, userRole]);

    const dismiss = async () => {
        setOpen(false);
        if (!currentUser) return;
        try {
            await setDoc(
                doc(db, 'user_settings', currentUser.uid),
                { onboardingWelcomeSeen: true },
                { merge: true }
            );
        } catch {
            /* If persisting fails the welcome simply reappears next time — acceptable. */
        }
    };

    if (!open) return null;

    return (
        <Modal
            open={open}
            onClose={dismiss}
            title="Sveiki atvykę į Gildiją"
            size="md"
            footer={
                <Button variant="primary" fullWidth onClick={dismiss}>
                    Pradėti
                </Button>
            }
        >
            <div className="space-y-6">
                <p className="text-body text-ink-muted">
                    Čia matysite savo užduotis, žymėsite veiklos laiką ir planuosite veiklas.
                    Keli dalykai, kad būtų lengviau pradėti.
                </p>

                <ol className="space-y-4">
                    {STEPS.map((step, i) => (
                        <li key={step.title} className="flex gap-3">
                            <span
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-body font-semibold text-brand"
                                aria-hidden="true"
                            >
                                {i + 1}
                            </span>
                            <div className="min-w-0">
                                <p className="text-body font-semibold text-ink-strong">{step.title}</p>
                                <p className="mt-0.5 text-body text-ink-muted">{step.body}</p>
                            </div>
                        </li>
                    ))}
                </ol>

                <div>
                    <p className="mb-3 text-body font-semibold text-ink-strong">Ką reiškia ekrano spalva</p>
                    <ul className="grid grid-cols-2 gap-3">
                        {SESSION_TYPES.map((type) => {
                            const session = SESSION_COLORS[type];
                            return (
                                <li key={type} className="flex items-center gap-2.5">
                                    <span
                                        className={cn(
                                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                                            session.surface
                                        )}
                                    >
                                        <SessionTypeIcon type={type} className="h-4 w-4" />
                                    </span>
                                    <span className="text-body text-ink">{session.label}</span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </Modal>
    );
}
