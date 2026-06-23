/**
 * Shared task status labels and colors used across TaskCard, TaskTable, and DailyStatistics.
 * Single source of truth to eliminate duplication.
 */

// Single source of truth for status copy. The task lifecycle has TWO distinct manager gates that
// must NEVER share vocabulary (that overlap was the confusion the founder flagged):
//   - CREATION gate (a worker-made task a manager must clear before work):
//       unapproved -> "Nepatvirtintas", approved -> "Patvirtintas"  (the "patvirtinimas" family)
//   - COMPLETION gate (finished work a manager must accept):
//       completed -> "Laukia priėmimo", confirmed -> "Priimtas"     (the "priėmimas" family)
// Every surface — worker card, manager table, daily statistics, reports — renders the same word for
// the same state through this map, and the on-screen label always matches the export label.
export const STATUS_LABELS = {
    'pending': 'Nepradėtas',
    'in-progress': 'Pradėtas',
    'completed': 'Laukia priėmimo',
    'confirmed': 'Priimtas',
    'unapproved': 'Nepatvirtintas',
    'approved': 'Patvirtintas'
};

export const STATUS_STYLES = {
    'pending': 'bg-surface-card border-line',
    'in-progress': 'bg-surface-card border-line',
    'completed': 'bg-surface-sunken border-line',
    'confirmed': 'bg-surface-sunken border-line',
    'unapproved': 'bg-feedback-warning-soft border-feedback-warning-border'
};
