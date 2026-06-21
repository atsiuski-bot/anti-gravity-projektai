import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { getLithuanianNow, getLithuanianDateString, clampSessionMinutes } from '../utils/timeUtils';

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
    // Tracks whether THIS hook instance started the shared periodic reminder beep, so only the
    // hook that started it stops it. The beep is a SoundManager singleton and all three timer
    // hooks (break/call/quickWork) are mounted at once; without this, an inactive sibling hook
    // would stop the active session's reminder.
    const didStartBeepRef = useRef(false);

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

        // The periodic reminder applies to EVERY secondary session, not just breaks: a
        // forgotten quick-work or call timer would otherwise run silently and keep billing
        // time. This hook only ever manages secondary sessions (break/call/quickWork).
        const isReminderSession =
            sessionType === 'break' || sessionType === 'call' || sessionType === 'quickWork' ||
            activeFlagKey === 'isTakingBreak' || activeFlagKey === 'isCalling' || activeFlagKey === 'isQuickWorking';

        const stopBeepIfOurs = () => {
            if (didStartBeepRef.current) {
                SoundManager.stopPeriodicBeep();
                didStartBeepRef.current = false;
            }
        };

        if (isActive && startTime) {
            // Initial update
            const updateTimer = () => {
                const now = getLithuanianNow();
                // Sanitize the live delta through the shared clamp: a backward device clock
                // (now < startTime) would otherwise render a negative "-Xm" on the pill.
                const session = clampSessionMinutes((now - startTime) / (1000 * 60));
                setCurrentSessionMinutes(session);
            };
            updateTimer();

            // Interval update
            interval = setInterval(updateTimer, 1000);

            // Start the periodic reminder beep (~7 min) for this active secondary session.
            if (isReminderSession) {
                SoundManager.startPeriodicBeep(420000, false);
                didStartBeepRef.current = true;
            }

        } else {
            setCurrentSessionMinutes(0);
            stopBeepIfOurs();
        }

        return () => {
            clearInterval(interval);
            stopBeepIfOurs();
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
