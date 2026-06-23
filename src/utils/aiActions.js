import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

/**
 * Parse a manager's free-text into a structured task DRAFT via the server callable (which forwards
 * to OpenRouter / google/gemini-2.5-flash with a server-side key — same pattern as GODSGLOOM).
 * The draft is filled into the create form for the manager to confirm; AI never writes a task.
 *
 * @param {string} text - the manager's natural-language line (e.g. "rytoj Giedriui 2h mašinų patikra").
 * @param {{id:string,name:string}[]} roster - the legal assignees, so the server can resolve a
 *   spoken name to a real user id (the model returns a name, never an id).
 * @returns {Promise<{title:string, assignedUserId:string, priority:string, estimatedTime:string, estimatedTimeMinutes:number, estimatedGuess:string, deadline:string}>}
 *   estimatedTime is the time STATED in the text; estimatedGuess is the model's best guess used only
 *   when no time was stated and the caller has no history for the title (history > guess).
 */
export const parseTaskText = async (text, roster) => {
    const fn = httpsCallable(functions, 'parseTaskDraft');
    const res = await fn({ text, roster });
    return res.data;
};
