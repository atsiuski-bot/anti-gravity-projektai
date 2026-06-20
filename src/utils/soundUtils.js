export const SoundManager = {
    audioContext: null,
    intervalId: null,

    init() {
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn("AudioContext creation failed:", e);
            }
        }
    },

    canPlaySound() {
        // Prevent console spam if the browser hasn't registered a user interaction yet
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
            return false;
        }
        return true;
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

    playBeep() {
        try {
            if (!this.canPlaySound()) return;
            
            this.init();
            if (!this.audioContext) return;

            // Resume context if suspended
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
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
            // Release the graph nodes once the tone ends so they don't accumulate on the
            // long-lived shared AudioContext across a long session of repeated beeps.
            oscillator.onended = () => {
                try { oscillator.disconnect(); gainNode.disconnect(); } catch { /* already gone */ }
            };

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

                // Vibrate if available and allowed
                if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
                    try {
                        navigator.vibrate([200, 100, 200, 100, 400]);
                    } catch (e) { /* ignore */ }
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
            if (!this.canPlaySound()) return;

            this.init();
            if (!this.audioContext) return;

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }

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
            if (!this.canPlaySound()) return;

            this.init();
            if (!this.audioContext) return;

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }

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
            if (!this.canPlaySound()) return;

            this.init();
            if (!this.audioContext) return;

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }

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

    playOldBeepSound() {
        try {
            if (!this.canPlaySound()) return;

            this.init();
            if (!this.audioContext) return;

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            oscillator.type = 'sine';
            const now = this.audioContext.currentTime;
            oscillator.frequency.setValueAtTime(800, now); // 800Hz beep

            // Double beep pattern
            // First beep
            gainNode.gain.setValueAtTime(0.1, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

            // Second beep (slightly higher pitch)
            oscillator.frequency.setValueAtTime(1000, now + 0.15);
            gainNode.gain.setValueAtTime(0.1, now + 0.15);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } catch (error) {
            console.error("Error playing old beep sound:", error);
        }
    },

    // Warning sound for 80% time usage — gentle but noticeable two-tone chime
    playTimeWarningSound() {
        this.playOldBeepSound();

        // System notification
        if (Notification.permission === 'granted') {
            try {
                new Notification('⚠️ 80% laiko panaudota', {
                    body: 'Jūsų užduoties planuojamas laikas baigiasi!',
                    icon: '/favicon.ico',
                    tag: 'time-warning-80',
                    renotify: true
                });
            } catch (e) { /* ignore */ }
        }
    },

    // Urgent alarm for 100% time limit reached
    playTimeLimitAlarmSound() {
        this.playOldBeepSound();

        try {
            // Vibrate
            if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
                try {
                    navigator.vibrate([300, 100, 300, 100, 300, 100, 600]);
                } catch (e) { /* ignore */ }
            }

            // System notification
            if (Notification.permission === 'granted') {
                try {
                    new Notification('🛑 Laikas baigėsi!', {
                        body: 'Užduoties planuojamas laikas baigėsi. Darbas sustabdytas.',
                        icon: '/favicon.ico',
                        tag: 'time-limit-reached',
                        renotify: true,
                        requireInteraction: true
                    });
                } catch (e) { /* ignore */ }
            }
        } catch (error) {
            console.error('Error playing time limit alarm:', error);
        }
    },

    // Warning sound for 70% time usage
    playTimeWarning70Sound() {
        this.playOldBeepSound();
    },

    // Repeating alarm every 60 seconds until stopped
    timeLimitRepeatId: null,

    startTimeLimitRepeat() {
        this.stopTimeLimitRepeat(); // Clear any existing
        
        // Play immediately
        this.playTimeLimitAlarmSound(); 
        
        // Play exactly once more after 3 seconds (making it play twice total)
        this.timeLimitRepeatId = setTimeout(() => {
            this.playTimeLimitAlarmSound();
            this.timeLimitRepeatId = null;
        }, 3000); 
    },

    stopTimeLimitRepeat() {
        if (this.timeLimitRepeatId) {
            clearTimeout(this.timeLimitRepeatId);
            this.timeLimitRepeatId = null;
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
