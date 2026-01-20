import React, { useEffect, useState } from 'react';
import { Download, Smartphone } from 'lucide-react';

export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);

    useEffect(() => {
        const handleBeforeInstallPrompt = (e) => {
            console.log('PWA: beforeinstallprompt fired', e);
            // Prevent the mini-infobar from appearing on mobile
            e.preventDefault();
            // Stash the event so it can be triggered later.
            setDeferredPrompt(e);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        // Check if device is iOS
        const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        setIsIOS(isIOSDevice);

        // Check if already in standalone mode
        const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone ||
            document.referrer.includes('android-app://');
        setIsStandalone(isInStandaloneMode);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        deferredPrompt.prompt();

        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;

        // We've used the prompt, and can't use it again, throw it away
        setDeferredPrompt(null);
    };

    if (isStandalone) return null;

    // For Android/Desktop (Standard PWA flow)
    if (deferredPrompt || import.meta.env.DEV) {
        return (
            <button
                onClick={deferredPrompt ? handleInstallClick : () => alert('This is a debug button. In production, this triggers the install prompt.')}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                title={deferredPrompt ? "Install App" : "Debug Install Button"}
            >
                <Download className="w-3 h-3" />
                <span className="text-[10px] leading-none uppercase tracking-wide">Install</span>
            </button>
        );
    }

    // For iOS (Manual instruction hint, only if not standalone)
    // We'll keep it very subtle or hidden based on user request "small button".
    // Since iOS doesn't support a programmatic trigger, we might just show a help icon or nothing if they didn't ask for a tutorial.
    // The user said "make the button small", implying functional button. 
    // I will return null for now for iOS to keep it simple unless requested, 
    // OR show a small icon that opens a simple alert/modal. 
    // Let's stick to the prompt-based button first.

    return null;
}
