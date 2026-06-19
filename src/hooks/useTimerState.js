import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { getLithuanianNow, getLithuanianDateString } from '../utils/timeUtils';

/**
 * Custom hook to manage timer state for Break, Call, and QuickWork.
 * 
 * @param {Object} currentUser - The current authenticated user object
 * @param {string} stateKey - The key in user document to watch (e.g., 'breakState', 'callState', 'quickWorkState')
 * @param {string} activeFlagKey - The boolean flag in the state object (e.g., 'isTakingBreak', 'isCalling', 'isQuickWorking')
 * @param {Function} [onStateChange] - Optional callback when state changes
 * @param {Function} [selectStartTime] - Optional selector to get start time from data (defaults to data.lastStartedAt)
 * @param {string} [sessionType] - Optional, the new session type (e.g. 'break', 'call', 'quickWork') to check in activeSession
 */
export const useTimerState = (currentUser, stateKey, activeFlagKey, onStateChange = null, selectStartTime = null, sessionType = null) => {
    const { userData } = useAuth();
    const [isActive, setIsActive] = useState(false);
    const [accumulatedMinutes, setAccumulatedMinutes] = useState(0);
    const [currentSessionMinutes, setCurrentSessionMinutes] = useState(0);
    const [startTime, setStartTime] = useState(null);
    const [stateData, setStateData] = useState({});

    // Use refs to track previous values and avoid unnecessary updates
    const prevIsActiveRef = useRef(false);
    const prevStartTimeRef = useRef(null);

    // 1. React to userData changes globally instead of creating independent listeners
    useEffect(() => {
        if (!currentUser || !userData) return;

        const data = userData[stateKey] || {};
        const activeSession = userData.activeSession;

        // Logic Selection: New Active Session vs Legacy Flag
        let isCurrentlyActive = false;
        let fetchedStartTime = null;

        if (sessionType) {
            if (activeSession) {
                // If we have an activeSession, it is the sole source of truth.
                isCurrentlyActive = activeSession.type === sessionType;
                if (isCurrentlyActive && activeSession.startTime) {
                    fetchedStartTime = new Date(activeSession.startTime);
                }
            } else {
                // Legacy fallback only if no activeSession exists
                isCurrentlyActive = data[activeFlagKey] || false;
                if (isCurrentlyActive) {
                    if (selectStartTime) {
                        fetchedStartTime = selectStartTime(data);
                    } else if (data.lastStartedAt) {
                        fetchedStartTime = new Date(data.lastStartedAt);
                    }
                }
            }
        } else {
            // Fallback check if sessionType not provided
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

        // Capture previous value BEFORE updating the ref
        const wasActive = prevIsActiveRef.current;
        const didChange = isCurrentlyActive !== wasActive;

        // Handle daily reset logic if applicable (mostly for BreakTimer)
        if (lastDate && lastDate !== today) {
            setAccumulatedMinutes(0);
            if (didChange) {
                setIsActive(isCurrentlyActive);
                prevIsActiveRef.current = isCurrentlyActive;
            }
        } else {
            const newAccumulated = data.dailyAccumulatedMinutes || 0;
            setAccumulatedMinutes(newAccumulated);

            if (didChange) {
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
        if (onStateChange && didChange) {
            onStateChange(data, isCurrentlyActive);
        }
    }, [currentUser, userData, stateKey, activeFlagKey, sessionType, selectStartTime, onStateChange]);

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
            // Only play this reminder beep for breaks.
            if (activeFlagKey === 'isTakingBreak' || sessionType === 'break') {
                SoundManager.startPeriodicBeep(420000, false);
            }

        } else {
            setCurrentSessionMinutes(0);
            if (activeFlagKey === 'isTakingBreak' || sessionType === 'break') {
                SoundManager.stopPeriodicBeep();
            }
        }

        return () => {
            clearInterval(interval);
            if (activeFlagKey === 'isTakingBreak' || sessionType === 'break') {
                SoundManager.stopPeriodicBeep();
            }
        };
    }, [isActive, startTime, activeFlagKey, sessionType]);

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
