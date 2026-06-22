import { ListTodo, UserCheck, Calendar, Users, History, UserCog } from 'lucide-react';
import { isManagerRole } from '../utils/formatters';

/**
 * Single source of truth for the app's primary navigation destinations, grouped by area.
 *
 * Both the mobile bottom bar (`BottomNavigation`) and the desktop side rail (`SideRail`)
 * derive their tabs from this, so the two navs can never drift (DESIGN_SYSTEM §3 — one
 * canonical way to do a thing). A section whose `label` is null renders without a heading
 * (the bottom bar shows a thin separator between sections instead).
 *
 * @param {string} userRole - 'worker' | 'manager' | 'admin'
 * @returns {Array<{ id: string, label: string|null, items: Array<{id,label,icon}> }>}
 */
export function getNavSections(userRole) {
    if (isManagerRole(userRole)) {
        return [
            {
                id: 'mine',
                label: 'Mano',
                items: [
                    { id: 'my-tasks', label: 'Darbai', icon: ListTodo },
                    { id: 'my-calendar', label: 'Kalendorius', icon: Calendar },
                    { id: 'my-reports', label: 'Ataskaitos', icon: History },
                ],
            },
            {
                id: 'team',
                label: 'Komanda',
                items: [
                    { id: 'tasks', label: 'Kom. darbai', icon: UserCheck },
                    { id: 'team-calendar', label: 'Kom. kalendorius', icon: Users },
                    { id: 'reports', label: 'Kom. ataskaitos', icon: History },
                ],
            },
            ...(userRole === 'admin'
                ? [{
                    id: 'admin',
                    label: 'Administravimas',
                    items: [{ id: 'users', label: 'Vartotojai', icon: UserCog }],
                }]
                : []),
        ];
    }

    return [
        {
            id: 'main',
            label: null,
            items: [
                { id: 'tasks', label: 'Darbai', icon: ListTodo },
                { id: 'calendar', label: 'Kalendorius', icon: Calendar },
                { id: 'reports', label: 'Ataskaitos', icon: History },
                { id: 'team-calendar', label: 'Kom. kalendorius', icon: Users },
            ],
        },
    ];
}

/** Flattened destinations (sections collapsed) — used by the bottom bar's mobile slot logic. */
export function getFlatTabs(userRole) {
    return getNavSections(userRole).flatMap((section) => section.items);
}
