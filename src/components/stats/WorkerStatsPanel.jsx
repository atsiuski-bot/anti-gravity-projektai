import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import StatPeriodPicker from './StatPeriodPicker';
import { rangeForPreset } from '../../utils/statsPeriods';
import StatGroup from './StatGroup';
import StatRow from './StatRow';
import { STAT_GROUPS } from '../../utils/workerStats';
import { useWorkerStats } from '../../hooks/useWorkerStats';
import { Spinner } from '../ui/Loading';
import EmptyState from '../ui/EmptyState';

/**
 * WorkerStatsPanel — the manager-only aggregated-statistics surface (the "Suvestinė" tab of
 * UserProfileModal). A period picker on top, then the five collapsed accordion groups; every
 * metric shows its value plus a semantic period-over-period delta. Heavy work (the Firestore
 * fetch + compute) is owned by `useWorkerStats`; accordions only gate visual density.
 *
 * Gating is the caller's job — this mounts only when a manager who oversees the worker opens the
 * tab, so the same `canViewStats` guard that protects the day-report tab also protects this.
 */
export default function WorkerStatsPanel({ userId, targetUser, viewerData, viewerUid, viewerRole }) {
    const [period, setPeriod] = useState(() => ({ key: 'month', ...rangeForPreset('month') }));
    const [openGroups, setOpenGroups] = useState({}); // all collapsed initially

    const expectedWeeklyHours = Number(targetUser?.weeklyExpectedHours) || 0;
    const { loading, error, current, previous } = useWorkerStats({
        userId, viewerData, viewerUid, viewerRole, expectedWeeklyHours, period, enabled: true,
    });

    const toggle = (key) => setOpenGroups((o) => ({ ...o, [key]: !o[key] }));

    return (
        <div className="space-y-4">
            <StatPeriodPicker value={period} onChange={setPeriod} />

            {error ? (
                <EmptyState
                    icon={BarChart3}
                    title="Nepavyko įkelti statistikos"
                    description="Bandykite vėliau arba pasirinkite kitą laikotarpį."
                />
            ) : loading ? (
                <Spinner label="Skaičiuojama…" />
            ) : (
                <div className="space-y-2">
                    {STAT_GROUPS.map((g) => (
                        <StatGroup key={g.key} title={g.title} open={!!openGroups[g.key]} onToggle={() => toggle(g.key)}>
                            {g.metrics.map((m) => (
                                <StatRow key={m.key} metric={m} current={current?.[m.key]} previous={previous?.[m.key]} />
                            ))}
                        </StatGroup>
                    ))}
                </div>
            )}
        </div>
    );
}
