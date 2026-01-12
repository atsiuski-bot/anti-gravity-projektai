/**
 * Formats a full name to the format "Name S."
 * Example: "Jonas Kazlauskas" -> "Jonas K."
 * Example: "Petras" -> "Petras"
 * Example: "First Middle Last" -> "First L."
 * 
 * @param {string} fullName The full name to format
 * @returns {string} The formatted name
 */
export const formatDisplayName = (fullName) => {
    if (!fullName) return '';
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 1) return fullName;
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    return `${firstName} ${lastName.charAt(0).toUpperCase()}.`;
};
