import { doc, getDoc, updateDoc, collection, addDoc, setDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString, clampSessionMinutes, MIN_LOGGED_SESSION_MINUTES, formatMinutesToTimeString } from './timeUtils';
import { logError } from './errorLog';
import { isManagerRole } from './formatters';
import { DEFAULT_PRIORITY } from './priority';
import { buildCallTitle } from './callContacts';
import { notify } from './notify';

// Placeholder title given to a quick-work session that ends without the worker naming it
// (it was stopped remotely, so the "what did you do?" prompt never appeared on this device).
// Shared by the auto-log path and the retroactive-description fallback so the two never drift.
export const AUTO_STOPPED_QUICK_WORK_TITLE = 'Greita veikla (Automatiškai išsaugota)';

/**
 * Starts a new session for the user.
 * Automatically ends any existing session.
 * 
 * @param {string} userId 
 * @param {string} type - 'break', 'call', 'quickWork', 'task'
 * @param {Object} metadata - Additional data (e.g. taskId, taskTitle)
 */
export const startSession = async (userId, type, metadata = {}) => {
    try {
        const userRef = doc(db, 'users', userId);

        // 1. Fetch current user state
        const userSnap = await getDoc(userRef);
        const userData = userSnap.data();

        // 2. Identify tasks that need to be resumed later
        let resumableTaskIds = [];

        // Check activeSession for task
        if (userData?.activeSession?.type === 'task' && userData?.activeSession?.taskId) {
            resumableTaskIds.push(userData.activeSession.taskId);
        }
        // Check legacy workStatus
        else if (userData?.workStatus?.status === 'running' && userData?.workStatus?.activeTaskId) {
            resumableTaskIds.push(userData.workStatus.activeTaskId);
        }

        // Check if there is already a pausedSession holding a task
        let inheritedPausedSession = null;
        if (userData?.activeSession?.type !== 'task' && userData?.activeSession?.pausedSession) {
            inheritedPausedSession = userData.activeSession.pausedSession;
            if (inheritedPausedSession.type === 'task' && inheritedPausedSession.taskId) {
                resumableTaskIds.push(inheritedPausedSession.taskId);
            }
        }

        // 3. Pause current session if exists (collect promises, don't await yet)
        let newPausedSession = null;
        let pausePromise = Promise.resolve();
        if (userData?.activeSession?.type) {
            if (userData.activeSession.type === 'task' && userData.activeSession.taskId) {
                // Fire pause in background — optimistic UI already shows it paused
                pausePromise = getDoc(doc(db, 'tasks', userData.activeSession.taskId)).then(taskDoc => {
                    if (taskDoc.exists()) {
                        return pauseTask({ id: taskDoc.id, ...taskDoc.data() }, { skipUserStatusUpdate: true });
                    }
                // Route the failure to the durable crash log, not just console: if this
                // pause fails the task stays timerStatus:'running' with a stale start and
                // would later credit ghost time, so the failure must be diagnosable. The
                // on-load orphan recovery + the clamp bound the damage; this makes it visible.
                }).catch(e => logError(e, { source: 'pauseFail:startSession.taskPause', taskId: userData.activeSession.taskId }));
                newPausedSession = userData.activeSession;
            } else {
                newPausedSession = userData.activeSession;

                // Log partial work_session for quick_work/call being interrupted
                // so the pre-interruption time appears in reports
                if ((userData.activeSession.type === 'quickWork' || userData.activeSession.type === 'call') && userData.activeSession.startTime) {
                    const interruptNow = getLithuanianNow();
                    const interruptStart = new Date(userData.activeSession.startTime);
                    const partialDuration = clampSessionMinutes((interruptNow - interruptStart) / (1000 * 60));
                    if (partialDuration > MIN_LOGGED_SESSION_MINUTES) {
                        // Log the partial segment and capture doc ID for later renaming
                        const partialType = userData.activeSession.type;
                        const partialTitle = partialType === 'call' ? 'Skambutis' : (userData.activeSession.customTitle || 'Greita veikla');
                        try {
                            const partialDocRef = await addDoc(collection(db, 'work_sessions'), {
                                taskId: `${partialType}_partial_${interruptNow.getTime()}`,
                                taskTitle: partialTitle,
                                userId: userId,
                                userName: userData.displayName || 'Nežinomas',
                                startTime: userData.activeSession.startTime,
                                endTime: interruptNow.toISOString(),
                                durationMinutes: partialDuration,
                                date: getLithuanianDateString(interruptNow),
                                createdAt: new Date().toISOString(),
                                isQuickWork: partialType === 'quickWork',
                                isSystemTask: partialType === 'call',
                                isPartial: true
                            });
                            // Store partial doc ID on the paused session so we can rename it later
                            newPausedSession = { ...newPausedSession, partialDocId: partialDocRef.id };
                        } catch (e) {
                            logError(e, { source: 'writeFail:startSession.partialLog', userId });
                        }
                    }
                }
            }
        } else {
            // Fire legacy cleanup in background
            const legacyCleanup = async () => {
                try {
                    if (userData?.breakState?.isTakingBreak) await endLegacySession(userId, 'break', userData);
                    else if (userData?.callState?.isCalling) await endLegacySession(userId, 'call', userData);
                    else if (userData?.quickWorkState?.isQuickWorking) await endLegacySession(userId, 'quickWork', userData);
                    else if (userData?.workStatus?.status === 'running') {
                        const activeTaskId = userData.workStatus.activeTaskId;
                        if (activeTaskId) {
                            const taskDoc = await getDoc(doc(db, 'tasks', activeTaskId));
                            if (taskDoc.exists()) {
                                await pauseTask({ id: taskDoc.id, ...taskDoc.data() }, { skipUserStatusUpdate: true });
                            }
                        }
                    }
                } catch (e) { logError(e, { source: 'writeFail:startSession.legacyCleanup', userId }); }
            };
            legacyCleanup(); // Fire and forget
        }

        // 4. Prepare new session data
        const nowMoment = getLithuanianNow();
        const startTime = nowMoment.toISOString();
        const activeSession = {
            type,
            startTime,
            pausedSession: newPausedSession || inheritedPausedSession,
            ...metadata
        };

        // 5. Update User Doc
        const updates = {
            activeSession,
            // Clear all legacy active flags so timer components rely on activeSession!
            'breakState.isTakingBreak': false,
            'callState.isCalling': false,
            'quickWorkState.isQuickWorking': false,
            'workStatus.isWorking': false
        };

        // If we are starting a secondary session (not a task), ensure legacy workStatus shows paused
        if (type !== 'task' && userData?.workStatus?.status === 'running') {
            updates['workStatus.status'] = 'paused';
        }

        // Legacy: Update specific states based on type ONLY for the new active one
        if (type === 'break') {
            updates.breakState = {
                isTakingBreak: true,
                lastStartedAt: startTime,
                dailyAccumulatedMinutes: userData?.breakState?.dailyAccumulatedMinutes || 0,
                lastDate: getLithuanianDateString(),
                resumableTaskIds: resumableTaskIds
            };
        } else if (type === 'call') {
            updates.callState = {
                isCalling: true,
                lastStartedAt: startTime,
                resumableTaskIds: resumableTaskIds
            };
        } else if (type === 'quickWork') {
            updates.quickWorkState = {
                isQuickWorking: true,
                lastStartedAt: startTime,
                resumableTaskIds: resumableTaskIds
            };
        } else if (type === 'task') {
            updates.workStatus = {
                isWorking: true,
                status: 'running',
                activeTaskId: metadata.taskId || null,
                lastUpdated: startTime
            };
        }

        // Run critical user doc update in parallel with task pause
        await Promise.all([
            updateDoc(userRef, updates),
            pausePromise
        ]);

    } catch (err) {
        // Record durably before rethrowing — every caller only console.errors the
        // rethrow, so without this a Firestore/permission/network failure that aborts a
        // session start would never reach the ring buffer or remote error_logs.
        logError(err, { source: 'startSession', userId, sessionType: type });
        throw err;
    }
};

/**
 * Ends the current active session.
 * Logs to 'sessions' collection and legacy collections.
 * 
 * @param {string} userId 
 * @param {Object} [userInfo] - Optional, if we already fetched user doc
 * @param {Object} [sessionOverrides] - Optional, metadata to merge/override (e.g. customTitle)
 */
export const endSession = async (userId, userInfo = null, sessionOverrides = {}, skipResume = false) => {
    try {
        const userRef = doc(db, 'users', userId);
        let userData = userInfo;
        if (!userData) {
            const snap = await getDoc(userRef);
            userData = snap.data();
        }

        const session = { ...userData?.activeSession, ...sessionOverrides };

        // Fallback for legacy states if no activeSession and no force override.
        // An orphan held ONLY in the per-type flags (break/call/quick-work, no activeSession) is
        // closed here. endLegacySession now returns the SAME {type,creditedMinutes,rawMinutes,
        // wasCapped} shape as the main path, so useOrphanedSessionRecovery can surface the
        // recovered/clamped minutes for these legacy-flag-only sessions too — previously this
        // branch returned undefined and the banner never showed for them.
        if (!userData?.activeSession && !sessionOverrides.force) {
            if (userData?.breakState?.isTakingBreak) return await endLegacySession(userId, 'break', userData);
            else if (userData?.callState?.isCalling) return await endLegacySession(userId, 'call', userData);
            else if (userData?.quickWorkState?.isQuickWorking) return await endLegacySession(userId, 'quickWork', userData);
            return;
        }

        if (!session.type && !userData?.activeSession) return; // Should not happen if logic is correct

        const now = getLithuanianNow();
        const start = new Date(session.startTime);
        // Raw (unclamped) delta, kept ONLY so the caller can tell whether the clamp below
        // actually reduced the credited time — that drives the "16h cap fired" wording in the
        // crash-recovery notice. Never logged or accumulated.
        const rawMinutes = (now - start) / (1000 * 60);
        // Sanitize through the shared clamp before this value is logged AND accumulated
        // into breakState.dailyAccumulatedMinutes: a backward device clock would otherwise
        // write a NEGATIVE duration into the permanent work_sessions/sessions log and
        // SUBTRACT from the running break total. pauseTask already guards this way; endSession
        // did not. (Also caps an implausibly large value, matching the timer paths.)
        const durationMinutes = clampSessionMinutes((now - start) / (1000 * 60));
        const sessionDate = getLithuanianDateString(now);

        // 1. Prepare User State Update (CRITICAL PATH - must be fast)
        const updates = {};
        let restoredSession = null;

        if (session.pausedSession && !skipResume) {
            restoredSession = { ...session.pausedSession };

            // Set start time to NOW (end of interruption) because the pre-interruption
            // portion was already logged as a partial work_session in startSession.
            restoredSession.startTime = now.toISOString();

            updates.activeSession = restoredSession;

            // Restore legacy flags so UI timers continue running
            if (restoredSession.type === 'quickWork') {
                updates['quickWorkState.isQuickWorking'] = true;
                if (userData?.quickWorkState?.resumableTaskIds) {
                    updates['quickWorkState.resumableTaskIds'] = userData.quickWorkState.resumableTaskIds;
                }
            } else if (restoredSession.type === 'call') {
                updates['callState.isCalling'] = true;
                if (userData?.callState?.resumableTaskIds) {
                    updates['callState.resumableTaskIds'] = userData.callState.resumableTaskIds;
                }
            } else if (restoredSession.type === 'break') {
                updates['breakState.isTakingBreak'] = true;
                if (userData?.breakState?.resumableTaskIds) {
                    updates['breakState.resumableTaskIds'] = userData.breakState.resumableTaskIds;
                }
            } else if (restoredSession.type === 'task') {
                updates['workStatus.isWorking'] = true;
                updates['workStatus.status'] = 'running';
                updates['workStatus.activeTaskId'] = restoredSession.taskId || null;
            }
        } else {
            updates.activeSession = null;
        }

        // Apply legacy clears for the session that just ended
        if (session.type === 'break') {
            updates['breakState.isTakingBreak'] = false;
            updates['breakState.dailyAccumulatedMinutes'] = (userData.breakState?.dailyAccumulatedMinutes || 0) + durationMinutes;
        } else if (session.type === 'call') {
            updates['callState.isCalling'] = false;
        } else if (session.type === 'quickWork') {
            updates['quickWorkState.isQuickWorking'] = false;
        } else if (session.type === 'task') {
            updates['workStatus.isWorking'] = false;
            if (!restoredSession || restoredSession.type !== 'task') {
                updates['workStatus.status'] = 'idle';
                updates['workStatus.activeTaskId'] = null;
            }
        }

        // 2. CRITICAL: Update user doc immediately (this is what the UI waits for)
        await updateDoc(userRef, updates);

        // 3. Non-critical logging — fire and forget, don't block the caller
        const doLogging = async () => {
            try {
                const logPromises = [];
                // A call always reaches end-of-session through the deliberate classify/defer modal,
                // so it is logged regardless of duration (a real but brief call must not vanish);
                // break/quickWork/task still discard sub-minute mis-taps that have no such gate.
                if (durationMinutes > MIN_LOGGED_SESSION_MINUTES || session.type === 'call') {
                    logPromises.push(
                        addDoc(collection(db, 'sessions'), {
                            userId,
                            userName: userData.displayName || 'Nežinomas',
                            type: session.type,
                            startTime: session.startTime,
                            endTime: now.toISOString(),
                            durationMinutes,
                            date: sessionDate,
                            metadata: session
                        }).catch(err => logError(err, { source: 'writeFail:endSession.sessionLog' }))
                    );
                }
                logPromises.push(
                    handleLegacyLogging(userId, userData, session, now, durationMinutes)
                        .catch(e => logError(e, { source: 'writeFail:endSession.legacyLog' }))
                );
                await Promise.all(logPromises);
            } catch (e) { logError(e, { source: 'writeFail:endSession.doLogging', userId }); }
        };
        doLogging(); // Fire and forget — no await

        // 4. Task Resumption Logic
        if (!skipResume) {
            let resumableTaskIds = [];

            if (restoredSession) {
                // If we restored a task session directly, we must resume that specific task
                if (restoredSession.type === 'task' && restoredSession.taskId) {
                    resumableTaskIds.push(restoredSession.taskId);
                }
                // If we restored a secondary session (quick_work, call), do NOT resume tasks yet!
            } else {
                // We did not restore any session, so we fully resume queued tasks
                if (session.type === 'break') resumableTaskIds = userData.breakState?.resumableTaskIds || [];
                else if (session.type === 'call') resumableTaskIds = userData.callState?.resumableTaskIds || [];
                else if (session.type === 'quickWork') resumableTaskIds = userData.quickWorkState?.resumableTaskIds || [];
            }

            if (resumableTaskIds && resumableTaskIds.length > 0) {
                // Fire and forget — task resumption should not block endSession
                const doResume = async () => {
                    try {
                        const resumePromises = resumableTaskIds.map(async (taskId) => {
                            const tDoc = await getDoc(doc(db, 'tasks', taskId));
                            if (tDoc.exists()) {
                                const tData = { id: tDoc.id, ...tDoc.data() };
                                
                                // SAFEGUARD: Fetch latest local user state to prevent race conditions.
                                // If the user rapidly started a new task while we were fetching from the server,
                                // we should abort resurrecting the old task.
                                let userStartedAnotherTask = false;
                                try {
                                    // Fetch the real-time user document from server to prevent race conditions
                                    // and avoid unreliable cache behavior that aborts resumes.
                                    const latestUserDoc = await getDoc(doc(db, 'users', userId));
                                    if (latestUserDoc.exists()) {
                                        const uData = latestUserDoc.data();
                                        if (uData?.activeSession && uData.activeSession.type !== 'task') {
                                            // A NEW secondary session (quick-work/call/break) was started after
                                            // this break/call ended. It carries no taskId, so the task-id checks
                                            // below miss it — resuming the queued task here would silently wipe
                                            // the live secondary session (resumeTask overwrites activeSession).
                                            // Treat any live non-task session as a supersede.
                                            userStartedAnotherTask = true;
                                        } else if (uData?.activeSession?.taskId && uData.activeSession.taskId !== taskId) {
                                            userStartedAnotherTask = true;
                                        } else if (uData?.workStatus?.activeTaskId && uData.workStatus.activeTaskId !== taskId) {
                                            userStartedAnotherTask = true;
                                        }
                                    }
                                } catch (fetchErr) {
                                    // Fail CLOSED: we couldn't prove the resume is safe, so skip it
                                    // rather than risk resurrecting the old task over a live new
                                    // session the user just started (resumeTask overwrites
                                    // activeSession — silent data loss). A non-resumed paused task is
                                    // recoverable (manual resume / orphan recovery); a wiped live
                                    // session is not. Record the fetch failure durably.
                                    userStartedAnotherTask = true;
                                    logError(fetchErr, { source: 'doResume:userStateCheck', userId, taskId });
                                }

                                if (!userStartedAnotherTask &&
                                    tData.timerStatus === 'paused' &&
                                    !tData.completed &&
                                    tData.status !== 'completed' &&
                                    tData.status !== 'confirmed' &&
                                    tData.status !== 'deleted') {
                                    await resumeTask(tData, userId);
                                } else {
                                    console.log(`Skipping background resume for ${taskId} (completed or superseded)`);
                                }
                            }
                        });
                        await Promise.allSettled(resumePromises);
                    } catch (e) {
                        logError(e, { source: 'writeFail:endSession.taskResume', userId });
                    }
                };
                doResume(); // Fire and forget — no await
            }
        }

        // Surface the credited duration + whether the clamp reduced it, so the crash-recovery
        // hook can show an accurate "timer recovered" notice. `wasCapped` ignores sub-minute
        // float noise so only a genuine overflow (the 16h ceiling) reads as capped. The session
        // type rides along so the notice can name what was recovered.
        return {
            type: session.type || null,
            creditedMinutes: durationMinutes,
            rawMinutes,
            wasCapped: rawMinutes - durationMinutes > 1,
        };
    } catch (err) {
        // endSession swallowed its failure (no rethrow) and never logged it, so a failed
        // critical user-doc update left the session in limbo with no durable trace. Record it.
        logError(err, { source: 'endSession', userId });
    }
};

// Helper: End legacy session types if we drift out of sync.
//
// Returns the SAME {type, creditedMinutes, rawMinutes, wasCapped} shape as the main endSession
// path so the orphan-recovery hook can surface the recovered/clamped minutes for a session held
// ONLY in the per-type flags (no activeSession). `rawMinutes` is the unclamped wall-clock delta,
// kept solely so the caller can tell whether the 16h clamp actually cut the credited time down —
// it is never logged or accumulated. A missing/invalid startTime credits nothing (a clean,
// uncapped zero), matching how the main path treats a sub-minute or backward-clock orphan.
const endLegacySession = async (userId, type, userData) => {
    try {
        // Construct a fake session object to pass to legacy logger
        let startTime;
        if (type === 'break') startTime = userData.breakState?.lastStartedAt;
        else if (type === 'call') startTime = userData.callState?.lastStartedAt;
        else if (type === 'quickWork') startTime = userData.quickWorkState?.lastStartedAt;

        let duration = 0;
        let rawMinutes = 0;
        const nowMoment = getLithuanianNow();
        let now = nowMoment;

        if (startTime) {
            const fakeSession = { type, startTime };
            now = getLithuanianNow(); // Update now
            // Raw (unclamped) delta first, so we can report whether the clamp below reduced it.
            rawMinutes = (now - new Date(startTime)) / (1000 * 60);
            duration = clampSessionMinutes((now - new Date(startTime)) / (1000 * 60));

            // Log session (safely)
            try {
                await handleLegacyLogging(userId, userData, fakeSession, now, duration);
            } catch (loggingErr) {
                console.warn(`Failed to log legacy session (${type}):`, loggingErr);
            }
        }

        // CRITICAL FIX: Clear the legacy state flags so the user doesn't get stuck
        const userRef = doc(db, 'users', userId);
        const updates = {};

        if (type === 'break') {
            updates['breakState.isTakingBreak'] = false;
            // Accumulate minutes so daily counter is correct
            updates['breakState.dailyAccumulatedMinutes'] = (userData.breakState?.dailyAccumulatedMinutes || 0) + duration;
        } else if (type === 'call') {
            updates['callState.isCalling'] = false;
        } else if (type === 'quickWork') {
            updates['quickWorkState.isQuickWorking'] = false;
        }

        if (Object.keys(updates).length > 0) {
            await updateDoc(userRef, updates);
        }

        // Mirror the main endSession return contract so the recovery hook can stamp the notice
        // for a legacy-flag-only orphan. `wasCapped` ignores sub-minute float noise so only a
        // genuine 16h-ceiling overflow reads as capped.
        return {
            type,
            creditedMinutes: duration,
            rawMinutes,
            wasCapped: rawMinutes - duration > 1,
        };
    } catch (err) {
        // Mirror the endSession upgrade (see its catch above): the guarded updateDoc clears the
        // stuck legacy flag, so a swallowed failure leaves the user in a phantom session with no
        // durable trace. Record it in the ring buffer + error_logs. No rethrow — callers use
        // `return await endLegacySession(...)`, matching the sibling's deliberate non-fatal contract.
        logError(err, { source: 'endLegacySession', userId, type });
    }
};

const handleLegacyLogging = async (userId, userData, session, now, durationMinutes) => {
    // Ignore accidental sub-minute taps — EXCEPT calls, which always pass through the deliberate
    // end-of-call modal (classify or "Vėliau aprašysiu") and so must be logged at any length.
    if (durationMinutes <= MIN_LOGGED_SESSION_MINUTES && session.type !== 'call') return;
    const sessionDate = getLithuanianDateString(now);

    // DETERMINISTIC record id, keyed on (kind + owner + this session's start instant). Two
    // INDEPENDENT closers can finalize the SAME abandoned session: this client path (on the
    // worker's next open, via orphan-recovery) AND the daily server net (autoCloseForgottenSessions,
    // for a worker who never reopens). With random addDoc ids they would each write a separate row
    // for one physical session → the time credited TWICE. Pinning the doc id to the session start
    // makes the second writer land on the same id (setDoc here / create() server-side), so exactly
    // one row survives. The id prefixes are a VERBATIM MIRROR of functions/index.js
    // writeSecondaryCloseRecords — locked by firebaseConsistency.test.js so they cannot drift.
    const startMs = new Date(session.startTime).getTime();

    if (session.type === 'break') {
        await setDoc(doc(db, 'break_sessions', `sess_break_${userId}_${startMs}`), {
            userId: userId,
            userName: userData.displayName || 'Nežinomas',
            startTime: session.startTime,
            endTime: now.toISOString(),
            durationMinutes: durationMinutes,
            date: sessionDate,
            createdAt: new Date().toISOString(),
            completedAt: now.toISOString(),
            isBreak: true
        });
    } else if (session.type === 'call') {
        const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
        // The title is derived from who was on the call ("Skambutis – Klientas"); the optional
        // free-text notes go into the description alongside the recorded time. contactType is
        // also stored as a structured field so reports can group calls by audience.
        const contactType = session.contactType || null;
        const callTitle = buildCallTitle(contactType);
        const callNotes = (session.callNotes || '').trim();
        const callDescription = callNotes ? `${callNotes}\n${timeString}` : timeString;
        // Log task + work session in PARALLEL (deterministic ids — see the dedup note above).
        const callPromises = [
            setDoc(doc(db, 'tasks', `sess_call_task_${userId}_${startMs}`), {
                title: callTitle,
                description: callDescription,
                contactType,
                status: "confirmed",
                priority: DEFAULT_PRIORITY,
                assignedUserId: userId,
                assignedUserName: userData.displayName || 'Nežinomas',
                createdBy: userId,
                creatorName: userData.displayName || 'Nežinomas',
                createdAt: new Date().toISOString(),
                completedAt: now.toISOString(),
                completed: true,
                confirmedBy: userId,
                confirmedAt: now.toISOString(),
                manualMinutes: durationMinutes,
                isSystemTask: true
            }),
            setDoc(doc(db, 'work_sessions', `sess_call_ws_${userId}_${startMs}`), {
                taskId: "call_" + now.getTime(),
                taskTitle: callTitle,
                contactType,
                userId: userId,
                userName: userData.displayName || 'Nežinomas',
                startTime: session.startTime,
                endTime: now.toISOString(),
                durationMinutes: durationMinutes,
                date: sessionDate,
                createdAt: new Date().toISOString(),
                isSystemTask: true
            })
        ];

        // Retroactively rename the partial work_session that was logged when this call was
        // interrupted, so it reflects the final counterpart-typed title.
        if (session.partialDocId && contactType) {
            callPromises.push(
                updateDoc(doc(db, 'work_sessions', session.partialDocId), {
                    taskTitle: callTitle,
                    contactType
                }).catch(e => console.warn('Failed to rename partial call session:', e))
            );
        }

        await Promise.all(callPromises);
    } else if (session.type === 'quickWork') {
        const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
        const autoStopped = !session.customTitle;
        const title = session.customTitle || AUTO_STOPPED_QUICK_WORK_TITLE;
        const isManager = isManagerRole(userData.role);

        // Route the finished quick work to one accountable manager for confirmation. The live,
        // described path carries the worker's explicit pick (session.auditorManagerId); an
        // auto-stopped session (ended on another device, worker absent) falls back to the
        // worker's primary manager. Managers/admins self-confirm, so they need no auditor.
        // `managerId` also grants that manager an immediate read of the row (firestore.rules
        // canReadOwnedTask) before the teamManagerIds stamp lands.
        const routedManagerId = isManager
            ? null
            : (session.auditorManagerId || userData.defaultManager || null);

        // Pre-generate the task and work_session refs so they can cross-reference by ID. The
        // session keeps its synthetic `quick_` taskId (other views infer quick-work from that
        // prefix), but the durable link lives in `workSessionId` on the task: an auto-stopped
        // session the worker never got to name can later be described retroactively, and that
        // rename must reach BOTH records — the task (shown in history once archived) and the
        // session (shown in today's timeline). See addQuickWorkDescription. (Without a stored
        // link the two are unjoined: their IDs differ and the session's taskId is synthetic.)
        // Deterministic ids (see the dedup note above): pinned to this session's start so the
        // server net cannot write a duplicate pair for the same abandoned quick-work. The task↔
        // session cross-link below still works — sessionRef.id is now that deterministic id.
        const taskRef = doc(db, 'tasks', `sess_qw_task_${userId}_${startMs}`);
        const sessionRef = doc(db, 'work_sessions', `sess_qw_ws_${userId}_${startMs}`);

        // Log task + work session in PARALLEL
        const logPromises = [
            setDoc(taskRef, {
                title: title,
                description: session.customTitle ? timeString : `${timeString} (Automatiškai sukurtas)`,
                status: isManager ? "confirmed" : "completed",
                priority: DEFAULT_PRIORITY,
                assignedUserId: userId,
                assignedUserName: userData.displayName || 'Nežinomas',
                createdBy: userId,
                creatorName: userData.displayName || 'Nežinomas',
                createdAt: new Date().toISOString(),
                completedAt: now.toISOString(),
                completed: true,
                confirmedBy: isManager ? userId : null,
                confirmedAt: isManager ? now.toISOString() : null,
                taskAuditor: routedManagerId,
                managerId: routedManagerId,
                manualMinutes: durationMinutes,
                isQuickWork: true,
                autoStopped: autoStopped,
                workSessionId: sessionRef.id
            }),
            setDoc(sessionRef, {
                taskId: "quick_" + now.getTime(),
                taskTitle: title,
                userId: userId,
                userName: userData.displayName || 'Nežinomas',
                startTime: session.startTime,
                endTime: now.toISOString(),
                durationMinutes: durationMinutes,
                date: sessionDate,
                createdAt: new Date().toISOString(),
                isQuickWork: true
            })
        ];

        // Notify the routed manager that quick work was completed and awaits their confirmation,
        // mirroring the regular task-finish notification (TaskTimerControls). Only on the live,
        // described path — an auto-stopped, still-unnamed entry would be noise; it can be notified
        // later if the worker describes it. Provenance is the worker's own uid (userId), which
        // firestore.rules requires for a request_notifications create.
        if (routedManagerId && routedManagerId !== userId && !autoStopped) {
            // Worker-authored (userId = caller); notify() stamps provenance + the registry category and
            // swallows its own write errors, so the completion log is never blocked by a notify failure.
            logPromises.push(
                notify({
                    recipientId: routedManagerId,
                    type: 'task_completion',
                    taskId: taskRef.id,
                    taskTitle: title,
                    actualTime: formatMinutesToTimeString(durationMinutes),
                    actualMinutes: durationMinutes,
                    userName: userData.displayName || 'Vykdytojas',
                    userId,
                    completedAt: now.toISOString(),
                })
            );
        }

        // Retroactively rename the partial work_session that was logged when this session was interrupted
        if (session.partialDocId && session.customTitle) {
            logPromises.push(
                updateDoc(doc(db, 'work_sessions', session.partialDocId), {
                    taskTitle: session.customTitle
                }).catch(e => console.warn('Failed to rename partial session:', e))
            );
        }

        await Promise.all(logPromises);
    }
    // Note: 'task' type logging is usually handled by pauseTask inside taskActions.
    // If we use startSession('task'), we must ensure taskActions.startTask was called or logic matches.
    // Integrating task logging here might duplicate valid logic in pauseTask.
    // For now, we assume taskActions handles the specific Task Doc updates and Work Session logging.
};

/**
 * Retroactively name an auto-stopped quick-work record.
 *
 * When a quick-work session ends remotely — e.g. a stale `isQuickWorking` flag is cleaned up
 * on another device with no live `activeSession` — it is logged with a generic placeholder
 * title and `autoStopped: true`, because the worker never saw the "what did you do?" prompt
 * (QuickWorkTimer deliberately skips it cross-device). This lets the worker fill that in
 * afterwards: the entered text becomes the title (mirroring the live flow, where the textarea
 * IS the title), renaming BOTH the task (shown in history once archived) and its linked
 * work_session (shown in today's timeline). Clearing `autoStopped` drops the entry out of the
 * "needs description" surface.
 *
 * Permission-safe under firestore.rules: the worker owns the task (assignedUserId) and the
 * session (userId), and the update leaves status/confirmedBy untouched, so it never trips the
 * manager-only approval guard (changesApprovalFields).
 *
 * @param {Object} task - the auto-stopped task doc (needs id, assignedUserId; workSessionId if linked)
 * @param {string} text - worker-entered description; trimmed, becomes the new title
 */
export const addQuickWorkDescription = async (task, text) => {
    const title = (text || '').trim();
    if (!task?.id || !title) return;
    try {
        // Keep the originally recorded time in the description, only strip the "(auto)" suffix.
        const cleanedDescription = (task.description || '')
            .replace(/\s*\(Automatiškai sukurtas\)\s*$/, '')
            .trim();

        // Rename the durable task record and clear the flag (the value the report reads).
        await updateDoc(doc(db, 'tasks', task.id), {
            title,
            description: cleanedDescription,
            autoStopped: false,
            updatedAt: new Date().toISOString()
        });

        // Rename the linked work_session so today's timeline reflects the description too.
        if (task.workSessionId) {
            await updateDoc(doc(db, 'work_sessions', task.workSessionId), {
                taskTitle: title
            }).catch(e => logError(e, { source: 'writeFail:addQuickWorkDescription.session', taskId: task.id }));
        } else {
            // Legacy records logged before the workSessionId link existed carry no pointer —
            // fall back to a bounded best-effort lookup. A miss only leaves the timeline label
            // generic; the durable task record (which is what archives) is already corrected.
            await renameLegacyQuickWorkSession(task, title);
        }
    } catch (err) {
        logError(err, { source: 'addQuickWorkDescription', taskId: task?.id });
        throw err;
    }
};

// Best-effort rename of a pre-link auto-stopped quick-work session (the task has no
// workSessionId). Scoped to the owner's own sessions and the generic placeholder title, then
// narrowed by duration so two same-day auto-stops cannot cross-rename. Never throws — this is
// a cosmetic backfill for legacy data; the task record was already corrected by the caller.
const renameLegacyQuickWorkSession = async (task, title) => {
    try {
        const ownerId = task.assignedUserId;
        if (!ownerId) return;
        const q = query(
            collection(db, 'work_sessions'),
            where('userId', '==', ownerId),
            where('taskTitle', '==', AUTO_STOPPED_QUICK_WORK_TITLE)
        );
        const snap = await getDocs(q);
        if (snap.empty) return;
        const target = snap.docs.find(d => {
            const dur = d.data().durationMinutes;
            return typeof dur === 'number' && Math.abs(dur - (task.manualMinutes || 0)) < 0.5;
        }) || snap.docs[0];
        await updateDoc(doc(db, 'work_sessions', target.id), { taskTitle: title });
    } catch (e) {
        logError(e, { source: 'writeFail:renameLegacyQuickWorkSession', taskId: task?.id });
    }
};
