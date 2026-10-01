// What the tray, Settings and the widget say about Team when the person may
// not be signed in. `summary` is the Plexiform window's optional read-only
// accountSummary() ({signedIn, name, hubHost, teamName}); without it main
// knows nothing about auth, so every line here stays neutral. Pure.
'use strict';

const NEUTRAL_HINT = Object.freeze({ text: 'Working with others? Plexiform has a shared team board.', label: 'Open Team', page: 'team' });
const CREATE_HINT = Object.freeze({ text: 'Not on a team yet: create one', label: 'Create a team', page: 'create-team' });

// The one-time widget hint, or null once seen or when the person already has a team.
// Signed out (or unknown) goes to the Team page, which offers sign-in and invite links.
function hintFor(summary, seen) {
  if (seen) return null;
  if (summary?.signedIn !== true) return NEUTRAL_HINT;
  return summary.teamName ? null : CREATE_HINT;
}

// Settings → Account & team: the line and which buttons apply.
function settingsView(summary, hubHost) {
  if (!summary) return { line: `Teams, the shared board and integrations live on Plexiform's team hub (${hubHost}).`, signIn: true };
  if (summary.signedIn !== true) return { line: 'Not signed in', signIn: true };
  return { line: `Signed in as ${summary.name || 'you'} · ${summary.teamName || 'no team yet'} · ${summary.hubHost || hubHost}`, signIn: false };
}

module.exports = { hintFor, settingsView };
