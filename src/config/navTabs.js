import { UserCog, ScrollText } from 'lucide-react';
import {
    TasksGlyph, TasksTeamGlyph,
    CalendarGlyph, CalendarTeamGlyph,
    ReportsGlyph, ReportsTeamGlyph,
} from '../components/icons/navGlyphs';
import { isManagerRole } from '../utils/formatters';

/**
 * Single source of truth for the app's primary navigation destinations, grouped by area.
 *
 * Both the mobile bottom bar (`BottomNavigation`) and the desktop side rail (`SideRail`)
 * derive their tabs from this, so the two navs can never drift (DESIGN_SYSTEM §3 — one
 * canonical way to do a thing). A section whose `label` is null renders without a heading
 * (the bottom bar shows a thin separator between sections instead).
 *
 * @param {string} userRole - 'worker' | 'manager' | 'seniorManager' | 'admin'
 * @returns {Array<{ id: string, label: string|null, items: Array<{id,label,icon}> }>}
 */
export function getNavSections(userRole) {
    if (isManagerRole(userRole)) {
        return [
            {
                id: 'mine',
                label: 'Mano',
                items: [
                    { id: 'my-tasks', label: 'Veiklos', icon: TasksGlyph },
                    { id: 'my-calendar', label: 'Kalendorius', icon: CalendarGlyph },
                    { id: 'my-reports', label: 'Ataskaitos', icon: ReportsGlyph },
                ],
            },
            {
                id: 'team',
                label: 'Komanda',
                items: [
                    { id: 'tasks', label: 'Kom. veiklos', icon: TasksTeamGlyph },
                    { id: 'team-calendar', label: 'Kom. kalendorius', icon: CalendarTeamGlyph },
                    { id: 'reports', label: 'Kom. ataskaitos', icon: ReportsTeamGlyph },
                ],
            },
            ...(userRole === 'admin'
                ? [{
                    id: 'admin',
                    label: 'Administravimas',
                    items: [
                        { id: 'users', label: 'Vartotojai', icon: UserCog },
                        { id: 'audit', label: 'Auditas', icon: ScrollText },
                    ],
                }]
                : []),
        ];
    }

    return [
        {
            id: 'main',
            label: null,
            items: [
                { id: 'tasks', label: 'Veiklos', icon: TasksGlyph },
                { id: 'calendar', label: 'Kalendorius', icon: CalendarGlyph },
                { id: 'reports', label: 'Ataskaitos', icon: ReportsGlyph },
                { id: 'team-calendar', label: 'Kom. kalendorius', icon: CalendarTeamGlyph },
            ],
        },
    ];
}

/** Flattened destinations (sections collapsed) — used by the bottom bar's mobile slot logic. */
export function getFlatTabs(userRole) {
    return getNavSections(userRole).flatMap((section) => section.items);
}
