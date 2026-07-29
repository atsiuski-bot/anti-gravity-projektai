/**
 * Pure derivation for the integrity report card (AuditDashboard).
 *
 * Split out of the JSX so the decision "what does this report actually SAY" can be asserted against
 * real production report documents without a DOM. That matters more here than for a typical card:
 * this is the only human-facing surface for the nightly credit-integrity net, so a field silently
 * dropped from the view is a control silently switched off, and the JSX itself gives no signal when
 * that happens. The companion test pins two real reports (one clean, one with findings) plus the
 * incomplete-run case.
 *
 * Two rules encoded here and nowhere else:
 *  1. COMPLETENESS OUTRANKS COUNTS. A run that could not read everything must not be presented as a
 *     clean one — its zeros mean "did not look", not "nothing there".
 *  2. A CLEAN CHECK STILL HAS TO SHOW ITSELF. Findings render individually; a clean run collapses to
 *     one line carrying the number of things checked. Four permanent zeros would be noise an admin
 *     learns to skip past, and "silence" would be indistinguishable from "never ran".
 */

/**
 * @param {Object} report - an `integrity_reports/{YYYY-MM-DD}` document.
 * @returns {{
 *   incomplete: boolean, scanErrors: Array<{scan: string, message: string}>,
 *   anomalies: number, stopped: number, deferred: number, autoClosed: number, stale: number,
 *   creditFindings: Array<{key: string, count: number, samples: Array<Object>}>,
 *   creditChecked: number, hasCreditSection: boolean,
 *   sessionFindings: Array<{key: string, count: number, samples: Array<Object>}>,
 *   sessionChecked: number, hasSessionSection: boolean,
 * }}
 */
export function deriveIntegrityView(report) {
    const r = report && typeof report === 'object' ? report : {};
    const credit = r.creditIntegrity || {};
    const orphan = credit.orphan || {};
    const suspicious = credit.suspicious || {};
    const serverSpan = credit.serverSpan || {};
    const overdraft = r.dailyOverdraft || {};

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const list = (v) => (Array.isArray(v) ? v : []);

    // Order is severity of INTERPRETATION, not count: a fabricated-credit row outranks a long day.
    const creditFindings = [
        { key: 'orphan', count: num(orphan.orphans), samples: list(orphan.samples) },
        { key: 'suspicious', count: num(suspicious.count), samples: list(suspicious.samples) },
        { key: 'serverSpan', count: num(serverSpan.count), samples: list(serverSpan.samples) },
        { key: 'overdraft', count: num(overdraft.offenders), samples: list(overdraft.samples) },
    ].filter((f) => f.count > 0);

    const creditChecked = num(orphan.checked) + num(suspicious.checked) +
        num(serverSpan.checked) + num(overdraft.checked);

    // Cross-store reconciliation: users/, tasks/ and active_sessions/ disagreeing about who is
    // working. Rendered beside the credit findings because it answers the same question from the
    // other side — credit checks ask "is this recorded time real", this asks "is this running time
    // real". Split per kind so the three read differently: a leftover claim is a nuisance, two
    // timers on one worker is credit quietly inflating.
    const disagreements = r.sessionDisagreements || {};
    const byKind = disagreements.byKind || {};
    const sessionFindings = ['staleUserRun', 'multipleRunningTasks', 'canonicalOrphanRun']
        .map((key) => ({
            key,
            count: num(byKind[key]),
            samples: list(disagreements.samples).filter((s) => s && s.kind === key),
        }))
        .filter((f) => f.count > 0);
    const sessionChecked = num(disagreements.checked);

    // `complete` is absent on reports written before the flag existed. Absent is UNKNOWN, not broken —
    // claiming an old report was incomplete would be its own false alarm. Only an explicit false, or a
    // recorded error, raises the banner.
    const scanErrors = list(r.scanErrors);
    const incomplete = r.complete === false || scanErrors.length > 0;

    return {
        incomplete,
        scanErrors,
        anomalies: num(r.totalAnomalies),
        stopped: num(r.autoStoppedTimers?.stopped),
        deferred: num(r.autoStoppedTimers?.deferred),
        autoClosed: num(r.autoClosedSessions?.closed),
        stale: num(r.staleBacklog?.count),
        creditFindings,
        creditChecked,
        hasCreditSection: creditFindings.length > 0 || creditChecked > 0,
        sessionFindings,
        sessionChecked,
        hasSessionSection: sessionFindings.length > 0 || sessionChecked > 0,
    };
}
