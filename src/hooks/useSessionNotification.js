import { useEffect, useRef } from 'react';

/**
 * Custom hook to manage system notifications for active work sessions
 * Creates persistent notifications that appear in the device's status bar
 */
export function useSessionNotification({ isQuickWorking, isCalling, isTakingBreak, isRunning }) {
    const notificationRef = useRef(null);
    const previousStateRef = useRef(null);

    useEffect(() => {
        // Check if notifications are supported and permitted
        if (!('Notification' in window)) {
            console.warn('This browser does not support notifications');
            return;
        }

        if (Notification.permission !== 'granted') {
            return; // Don't try to show notifications if not granted
        }

        // Determine current session state
        let currentState = null;
        let title = '';
        let body = '';
        let icon = '⚡'; // Default icon

        if (isQuickWorking) {
            currentState = 'quickWork';
            title = 'Skubus Darbas Aktyvus';
            body = 'Greitasis darbas vykdomas';
            icon = '⚡';
        } else if (isCalling) {
            currentState = 'call';
            title = 'Skambutis Aktyvus';
            body = 'Skambinimo sesija vykdoma';
            icon = '📞';
        } else if (isTakingBreak) {
            currentState = 'break';
            title = 'Pertrauka';
            body = 'Dabar pertraukos metu';
            icon = '☕';
        } else if (isRunning) {
            currentState = 'working';
            title = 'Darbas Vykdomas';
            body = 'Darbo sesija aktyvi';
            icon = '💼';
        }

        // If state changed
        if (currentState !== previousStateRef.current) {
            // Close existing notification
            if (notificationRef.current) {
                notificationRef.current.close();
                notificationRef.current = null;
            }

            // Create new notification if session is active
            if (currentState) {
                try {
                    const notification = new Notification(title, {
                        body: body,
                        icon: icon,
                        tag: 'work-session', // Using tag ensures only one notification at a time
                        requireInteraction: true, // Keep notification visible until dismissed
                        silent: true, // Don't play sound on update
                        badge: icon,
                    });

                    notificationRef.current = notification;

                    // Handle notification click - focus the app
                    notification.onclick = () => {
                        window.focus();
                        notification.close();
                    };
                } catch (error) {
                    console.error('Failed to create notification:', error);
                }
            }

            previousStateRef.current = currentState;
        }

        // Cleanup: close notification when component unmounts or all sessions end
        return () => {
            if (!currentState && notificationRef.current) {
                notificationRef.current.close();
                notificationRef.current = null;
            }
        };
    }, [isQuickWorking, isCalling, isTakingBreak, isRunning]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (notificationRef.current) {
                notificationRef.current.close();
            }
        };
    }, []);
}
