import { useState, useEffect, useRef, useMemo } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { SoundManager } from '../utils/soundUtils';
import { calculateCurrentTotalMinutes, getLithuanianNow, getLithuanianDateString } from '../utils/timeUtils';

/**
 * Custom hook to manage timer state for Break, Call, and QuickWork.
 * 
 * @param {Object} currentUser - The current authenticated user object
 * @param {string} stateKey - The key in user document to watch (e.g., 'breakState', 'callState', 'quickWorkState')
 * @param {string} activeFlagKey - The boolean flag in the state object (e.g., 'isTakingBreak', 'isCalling', 'isQuickWorking')
 * @param {Function} [onStateChange] - Optional callback when state changes
 * @param {Function} [selectStartTime] - Optional selector to get start time from data (defaults to data.lastStartedAt)
 * @param {string} [sessionType] - Optional, the new session type (e.g. 'break', 'call', 'quick_work') to check in activeSession
 */
export const useTimerState = (currentUser, stateKey, activeFlagKey, onStateChange = null, selectStartTime = null, sessionType = null) => {
    const [isActive, setIsActive] = useState(false);
    const [accumulatedMinutes, setAccumulatedMinutes] = useState(0);
    const [currentSessionMinutes, setCurrentSessionMinutes] = useState(0);
    const [startTime, setStartTime] = useState(null);
    const [stateData, setStateData] = useState({});

    // Use refs to track previous values and avoid unnecessary updates
    const prevIsActiveRef = useRef(false);
    const prevStartTimeRef = useRef(null);

    // 1. Real-time state subscription
    useEffect(() => {
        if (!currentUser) return;

        const userRef = doc(db, 'users', currentUser.uid);

        const unsubscribe = onSnapshot(userRef, (userSnap) => {
            if (userSnap.exists()) {
                const userData = userSnap.data();
                const data = userData[stateKey] || {};
                const activeSession = userData.activeSession;

                // Logic Selection: New Active Session vs Legacy Flag
                let isCurrentlyActive = false;
                let fetchedStartTime = null;

                if (sessionType && activeSession?.type === sessionType) {
                    // New generic session match
                    isCurrentlyActive = true;
                    fetchedStartTime = new Date(activeSession.startTime);
                } else {
                    // Fallback to legacy check (or standard check if sessionType not provided)
                    isCurrentlyActive = data[activeFlagKey] || false;
                    if (isCurrentlyActive) {
                        if (selectStartTime) {
                            fetchedStartTime = selectStartTime(data);
                        } else if (data.lastStartedAt) {
                            fetchedStartTime = new Date(data.lastStartedAt);
                        }
                    }
                }

                const lastDate = data.lastDate;
                const today = getLithuanianDateString();

                // Update state data reference
                setStateData(data);

                // Handle daily reset logic if applicable (mostly for BreakTimer)
                if (lastDate && lastDate !== today) {
                    setAccumulatedMinutes(0);
                    if (isCurrentlyActive !== prevIsActiveRef.current) {
                        setIsActive(isCurrentlyActive);
                        prevIsActiveRef.current = isCurrentlyActive;
                    }
                } else {
                    const newAccumulated = data.dailyAccumulatedMinutes || 0;
                    setAccumulatedMinutes(newAccumulated);

                    if (isCurrentlyActive !== prevIsActiveRef.current) {
                        setIsActive(isCurrentlyActive);
                        prevIsActiveRef.current = isCurrentlyActive;
                    }
                }

                // Only update startTime if it changed
                const startTimeStr = fetchedStartTime?.getTime();
                const prevStartTimeStr = prevStartTimeRef.current?.getTime();
                if (startTimeStr !== prevStartTimeStr) {
                    setStartTime(fetchedStartTime);
                    prevStartTimeRef.current = fetchedStartTime;
                }

                // Clear session if not active
                if (!isCurrentlyActive) {
                    setCurrentSessionMinutes(0);
                }

                // Optional callback - only call if state actually changed
                if (onStateChange && isCurrentlyActive !== prevIsActiveRef.current) {
                    onStateChange(data, isCurrentlyActive);
                }
            }
        });

        return () => unsubscribe();
    }, [currentUser, stateKey, activeFlagKey, sessionType, selectStartTime, onStateChange]);

    // 2. Timer Interval & Sound Management
    useEffect(() => {
        let interval;

        if (isActive && startTime) {
            // Initial update
            const updateTimer = () => {
                const now = getLithuanianNow();
                const session = (now - startTime) / (1000 * 60);
                setCurrentSessionMinutes(session);
            };
            updateTimer();

            // Interval update
            interval = setInterval(updateTimer, 1000);

            // Start periodic sound (every 7 mins by default in components)
            // Note: The specific sound choice (Beep vs Break/Call sound) is handled by the component usually,
            // but here we can at least start the periodic ticker if that's common.
            // Looking at existing code, SoundManager.startPeriodicBeep is used.
            SoundManager.startPeriodicBeep(420000, false);

        } else {
            setCurrentSessionMinutes(0);
            SoundManager.stopPeriodicBeep();
        }

        return () => {
            clearInterval(interval);
            SoundManager.stopPeriodicBeep();
        };
    }, [isActive, startTime]);

    return {
        isActive,
        setIsActive,
        currentSessionMinutes,
        accumulatedMinutes,
        setAccumulatedMinutes,
        startTime,
        stateData
    };
};
