// How soon the transcript scan may run again. Transcript reads are already
// incremental (usage.js resumes each file at its offset); what is left is how
// often to ask. With nothing on screen no one is reading the numbers, so the
// scan drops to a minute — budget and runaway alerts still land, just later.
const HIDDEN_GAP_MS = 60000;

function spendMinGap({ minGap, anyVisible }) {
  return anyVisible ? minGap : Math.max(minGap, HIDDEN_GAP_MS);
}

module.exports = { spendMinGap, HIDDEN_GAP_MS };
