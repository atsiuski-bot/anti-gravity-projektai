export const SoundManager = {
    audioContext: null,
    intervalId: null,

    init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    },

    playBeep() {
        try {
            this.init();

            // Resume context if suspended (browser autoplay policy)
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime); // 800Hz beep

            // Double beep pattern
            // First beep
            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.1);

            // Second beep (slightly higher pitch)
            oscillator.frequency.setValueAtTime(1000, this.audioContext.currentTime + 0.15);
            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime + 0.15);
            gainNode.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.25);

            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + 0.3);

        } catch (error) {
            console.error("Error playing sound:", error);
        }
    },

    startPeriodicBeep(intervalMs = 420000) { // Default 7 minutes (7 * 60 * 1000)
        this.stopPeriodicBeep(); // Ensure no duplicates
        this.playBeep(); // Play immediately on start
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
