const BOARD_NOTE_STAMP_RE = /^\[[\w\s,:\d/APMapm]+ — [^\]]+\]\s/;

function formatBoardNoteStamp(actorLabel, date = new Date()) {
  const label = String(actorLabel || 'Board').trim() || 'Board';
  const dt = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
  return `[${dt} — ${label}]`;
}

function stampBoardNote(text, actorLabel) {
  const body = String(text || '').trim();
  if (!body) return '';
  if (BOARD_NOTE_STAMP_RE.test(body)) return body;
  return `${formatBoardNoteStamp(actorLabel)} ${body}`;
}

function mergeBoardNotes(baseline, current, actorLabel) {
  const base = String(baseline ?? '');
  const cur = String(current ?? '');
  if (!cur.trim()) return cur;
  if (cur === base) return cur;
  if (cur.startsWith(base)) {
    const added = cur.slice(base.length).replace(/^\s+/, '');
    if (!added) return cur;
    const stamped = stampBoardNote(added, actorLabel);
    const sep = base && !base.endsWith('\n') ? '\n' : '';
    return base + sep + stamped;
  }
  return stampBoardNote(cur, actorLabel);
}

module.exports = {
  stampBoardNote,
  mergeBoardNotes,
  formatBoardNoteStamp,
};
