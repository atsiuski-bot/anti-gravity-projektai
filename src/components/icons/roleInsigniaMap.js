/**
 * ROLE_GLYPHS — canonical map of a role key to its rank insignia (ADR 0007 §"Role insignia").
 * `worker` is intentionally absent: a Vykdytojas shows no insignia (absence is the signal), so a
 * lookup miss correctly renders nothing. Kept in its own constants module so the glyph file stays
 * components-only (React Fast Refresh).
 */
import { RoleManagerGlyph, RoleSeniorGlyph, RoleAdminGlyph } from './roleInsignia';

export const ROLE_GLYPHS = {
    manager: RoleManagerGlyph,
    seniorManager: RoleSeniorGlyph,
    admin: RoleAdminGlyph,
};
