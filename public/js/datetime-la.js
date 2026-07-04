(function (global) {
  const LA_TIME_ZONE = 'America/Los_Angeles';

  const LA_DATETIME_OPTS = {
    timeZone: LA_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };

  function isCalendarDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  /** Parse API/DB timestamps; naive UTC strings (no Z) are treated as UTC. */
  function parseTimestamp(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const s = String(value).trim();
    if (!s || isCalendarDate(s)) return null;
    if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const normalized = s.includes('T') ? s : s.replace(' ', 'T');
    const d = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const s = String(value).trim();
    if (isCalendarDate(s)) return s;
    const d = parseTimestamp(value);
    if (!d) return s.split(' ')[0].split('T')[0];
    return d.toLocaleDateString('en-US', {
      timeZone: LA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  function fmtDateLong(value) {
    if (!value) return '—';
    const s = String(value).trim();
    const d = parseTimestamp(isCalendarDate(s) ? `${s}T12:00:00Z` : value);
    if (!d) return fmtDate(value);
    return d.toLocaleDateString('en-US', {
      timeZone: LA_TIME_ZONE,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function fmtDateTimeLA(value) {
    if (!value) return '—';
    const s = String(value).trim();
    if (isCalendarDate(s)) return fmtDateLong(s);
    const d = parseTimestamp(value);
    if (!d) return s.replace('T', ' ').slice(0, 16);
    return d.toLocaleString('en-US', LA_DATETIME_OPTS);
  }

  function fmtDateShortLA(value) {
    if (!value) return null;
    const d = parseTimestamp(value);
    if (!d) return null;
    return d.toLocaleDateString('en-US', {
      timeZone: LA_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function fmtNowLA() {
    return new Date().toLocaleString('en-US', LA_DATETIME_OPTS);
  }

  global.LA_TIME_ZONE = LA_TIME_ZONE;
  global.parseTimestamp = parseTimestamp;
  global.fmtDate = fmtDate;
  global.fmtDateLong = fmtDateLong;
  global.fmtDateTimeLA = fmtDateTimeLA;
  global.fmtDateShortLA = fmtDateShortLA;
  global.fmtNowLA = fmtNowLA;
})(typeof window !== 'undefined' ? window : globalThis);
