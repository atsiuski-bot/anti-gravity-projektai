import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);

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
        if (deferredPrompt) {
            // Show the install prompt
            deferredPrompt.prompt();

            // Wait for the user to respond to the prompt
            await deferredPrompt.userChoice;

            // We've used the prompt, whether accepted or dismissed, clear it
            setDeferredPrompt(null);
        } else {
            // No prompt available (iOS or Android dismissed/unavailable)
            // Show manual instructions
            setShowInstructions(true);
        }
    };

    if (isStandalone) return null;

    return (
        <>
            <button
                onClick={handleInstallClick}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                title="Install App"
            >
                <Download className="w-3 h-3" />
                <span className="text-[10px] leading-none uppercase tracking-wide">Install</span>
            </button>

            {showInstructions && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 transition-opacity" onClick={() => setShowInstructions(false)}>
                    <div
                        className="bg-white w-full max-w-sm rounded-xl p-6 shadow-2xl transform transition-all animate-in slide-in-from-bottom-5"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex justify-between items-start mb-4">
                            <h3 className="text-lg font-semibold text-gray-900">
                                {isIOS ? 'Įdiegti programėlę' : 'Įdiegti programėlę'}
                            </h3>
                            <button onClick={() => setShowInstructions(false)} className="text-gray-400 hover:text-gray-600">
                                <span className="sr-only">Close</span>
                                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="space-y-4">
                            <p className="text-sm text-gray-600">
                                Kad naudotumėtės programėle patogiau, pridėkite ją prie pagrindinio ekrano.
                            </p>

                            {isIOS ? (
                                <ol className="space-y-3 text-sm font-medium text-gray-800">
                                    <li className="flex items-center gap-3">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">1</span>
                                        <span>Spauskite <strong>Dalintis</strong> <span className="inline-block align-middle"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg></span> ikoną</span>
                                    </li>
                                    <li className="flex items-center gap-3">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">2</span>
                                        <span>Pasirinkite <strong>Add to Home Screen</strong></span>
                                    </li>
                                    <li className="flex items-center gap-3">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">3</span>
                                        <span>Spauskite <strong>Add</strong> viršutiniame kampe</span>
                                    </li>
                                </ol>
                            ) : (
                                <ol className="space-y-3 text-sm font-medium text-gray-800">
                                    <li className="flex items-center gap-3">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">1</span>
                                        <span>Spauskite naršyklės meniu ikoną (trys taškai)</span>
                                    </li>
                                    <li className="flex items-center gap-3">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">2</span>
                                        <span>Pasirinkite <strong>Install App</strong> arba <strong>Add to Home Screen</strong></span>
                                    </li>
                                </ol>
                            )}
                        </div>

                        <div className="mt-6">
                            <button
                                onClick={() => setShowInstructions(false)}
                                className="w-full bg-blue-600 text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-700 transition-colors"
                            >
                                Supratau
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
