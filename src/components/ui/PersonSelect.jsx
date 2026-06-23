import { User } from 'lucide-react';
import Select from './Select';
import Avatar from './Avatar';
import { formatDisplayName } from '../../utils/formatters';
import { useUsers } from '../../context/UsersContext';

/**
 * PersonSelect — the canonical "pick a person" control (DESIGN_SYSTEM §8 "Task people").
 *
 * The single way an assignee (Vykdytojas) or manager (Vadovas) is CHOSEN anywhere in the app. It
 * wraps the canonical `Select` so the trigger AND every option row show the member's **avatar +
 * formatted name**, mirroring the read-only display chips (`AssigneeChip` / `UserChip`): a person
 * reads the same whether you are looking at them or picking them. Names always run through
 * `formatDisplayName` ("Jonas Kazlauskas" → "Jonas K.") so the picker and the cards agree.
 *
 * The avatar/name are resolved from the live users map first (same source as the chips), falling
 * back to the passed user record — so a freshly-changed photo or display name shows immediately.
 *
 * @param {string} value - selected user id.
 * @param {(value: string) => void} onChange - called with the chosen user id.
 * @param {{id: string, displayName?: string, email?: string, photoURL?: string}[]} users - the
 *   selectable people (already scoped/filtered by the caller).
 * @param {string} [label] - field/category name; the panel heading + fallback accessible name.
 * @param {string} [placeholder] - trigger text when nothing is selected.
 * @param {string} [ariaLabel] - explicit accessible name (overrides `label`).
 * @param {boolean} [disabled=false]
 * @param {boolean} [alwaysSheet=true] - default to the centred sheet: a person picker almost always
 *   lives inside a scrollable modal/row where an anchored panel would clip.
 * @param {string} [className] - wrapper class (width / grid span).
 * @param {string} [buttonClassName] - trigger overrides.
 */
export default function PersonSelect({
    value,
    onChange,
    users = [],
    label,
    placeholder,
    ariaLabel,
    disabled = false,
    alwaysSheet = true,
    className,
    buttonClassName,
}) {
    const { usersMap } = useUsers();

    const options = users.map((u) => {
        // Prefer the live record (fresh photo/name) and fall back to the passed user.
        const rec = usersMap?.[u.id] || u;
        const fullName = rec.displayName || u.displayName || u.email || '';
        return {
            value: u.id,
            label: formatDisplayName(fullName),
            leading: (
                <Avatar
                    src={rec.photoURL || null}
                    name={fullName}
                    email={rec.email || u.email}
                    size="xs"
                    className="shrink-0"
                />
            ),
        };
    });

    return (
        <Select
            value={value}
            onChange={onChange}
            options={options}
            label={label}
            placeholder={placeholder}
            ariaLabel={ariaLabel}
            disabled={disabled}
            alwaysSheet={alwaysSheet}
            icon={User}
            className={className}
            buttonClassName={buttonClassName}
        />
    );
}
