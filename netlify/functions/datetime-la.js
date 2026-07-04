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

function fmtDateTimeLA(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleString('en-US', LA_DATETIME_OPTS);
}

function toDateOnlyString(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleDateString('en-CA', { timeZone: LA_TIME_ZONE });
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString('en-CA', { timeZone: LA_TIME_ZONE });
  }
  return '';
}

module.exports = {
  LA_TIME_ZONE,
  fmtDateTimeLA,
  toDateOnlyString,
};
