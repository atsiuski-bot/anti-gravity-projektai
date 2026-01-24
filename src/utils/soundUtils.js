export const SoundManager = {
    audioContext: null,
    intervalId: null,

    init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    },

    async requestPermission() {
        if (!("Notification" in window)) return;

        if (Notification.permission === "default") {
            try {
                await Notification.requestPermission();
            } catch (error) {
                console.error("Error requesting notification permission:", error);
            }
        }
    },

    playBeep(type = 'default') {
        try {
            this.init();

            // Resume context if suspended
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            const now = this.audioContext.currentTime;

            // Louder volume
            // 0.5 is significantly louder than 0.1
            const volume = 0.5;

            // Distinctive "Attention" Pattern (Triple Beep ascending)
            oscillator.type = 'square'; // 'square' is more piercing/audible than 'sine'

            // Beep 1
            oscillator.frequency.setValueAtTime(880, now); // A5
            gainNode.gain.setValueAtTime(volume, now);
            gainNode.gain.setValueAtTime(0.01, now + 0.2);

            // Beep 2
            oscillator.frequency.setValueAtTime(1108, now + 0.25); // C#6
            gainNode.gain.setValueAtTime(volume, now + 0.25);
            gainNode.gain.setValueAtTime(0.01, now + 0.45);

            // Beep 3 (Longer tail)
            oscillator.frequency.setValueAtTime(1318, now + 0.5); // E6
            gainNode.gain.setValueAtTime(volume, now + 0.5);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

            oscillator.start(now);
            oscillator.stop(now + 1.3);

            // Trigger System Notification
            this.triggerNotification();

        } catch (error) {
            console.error("Error playing sound:", error);
        }
    },

    triggerNotification() {
        if (!("Notification" in window)) return;

        if (Notification.permission === "granted") {
            try {
                // Check if we are on mobile (simple check)
                const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

                // Vibrate if available
                if (navigator.vibrate) {
                    navigator.vibrate([200, 100, 200, 100, 400]);
                }

                const notification = new Notification("Laikas!", {
                    body: "Praėjo 7 min. laiko blokas.",
                    icon: '/favicon.ico', // Assuming there's a favicon
                    tag: 'timer-notification', // Replace existing notification
                    renotify: true,
                    requireInteraction: true // Keep visible until user interacts
                });

                notification.onclick = function () {
                    window.focus();
                    notification.close();
                };

            } catch (e) {
                console.error("Notification error:", e);
            }
        }
    },

    // Simple sound for Quick Task - sharp "ding"
    playQuickTaskSound() {
        try {
            this.init();
            if (this.audioContext.state === 'suspended') this.audioContext.resume();

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            const now = this.audioContext.currentTime;

            // "Ding" sound (Sine wave, high pitch, short decay)
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(1200, now); // C6 approx
            oscillator.frequency.exponentialRampToValueAtTime(600, now + 0.15);

            gainNode.gain.setValueAtTime(0.3, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

            oscillator.start(now);
            oscillator.stop(now + 0.2);

        } catch (error) {
            console.error("Error playing Quick Task sound:", error);
        }
    },

    // Simple sound for Call - phone-like dual tone
    playCallSound() {
        try {
            this.init();
            if (this.audioContext.state === 'suspended') this.audioContext.resume();

            const now = this.audioContext.currentTime;

            // Create two oscillators for a dual-tone effect
            const osc1 = this.audioContext.createOscillator();
            const osc2 = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            osc1.connect(gainNode);
            osc2.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            osc1.type = 'triangle';
            osc2.type = 'triangle';

            osc1.frequency.setValueAtTime(440, now); // A4
            osc2.frequency.setValueAtTime(554, now); // C#5

            gainNode.gain.setValueAtTime(0.2, now);
            gainNode.gain.linearRampToValueAtTime(0.2, now + 0.2);
            gainNode.gain.linearRampToValueAtTime(0.01, now + 0.25);

            osc1.start(now);
            osc2.start(now);
            osc1.stop(now + 0.3);
            osc2.stop(now + 0.3);

        } catch (error) {
            console.error("Error playing Call sound:", error);
        }
    },

    // Simple sound for Break - relaxed lower chime
    playBreakSound() {
        try {
            this.init();
            if (this.audioContext.state === 'suspended') this.audioContext.resume();

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            const now = this.audioContext.currentTime;

            // "Relax" sound (Sine wave, lower pitch, slower attack and decay)
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(329.63, now); // E4

            // Soft attack
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.3, now + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

            oscillator.start(now);
            oscillator.stop(now + 0.9);

        } catch (error) {
            console.error("Error playing Break sound:", error);
        }
    },

    startPeriodicBeep(intervalMs = 420000, playImmediately = true) { // Default 7 minutes
        this.stopPeriodicBeep(); // Ensure no duplicates

        // IMPORTANT: Play sound immediately to UNLOCK the AudioContext while we have a user gesture.
        // Without this, the browser may block future sounds when the tab is in background.
        if (playImmediately) {
            this.playBeep();
        }

        this.intervalId = setInterval(() => {
            this.playBeep();
        }, intervalMs);
    },

    stopPeriodicBeep() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
};
