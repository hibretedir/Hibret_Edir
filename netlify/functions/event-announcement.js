/**
 * Funeral announcement intake + public payload (events.notes JSON v2).
 */

const { getDb } = require('./db');
const { loadLocalEnv, paypalApiBase } = require('./paypal-env');
const { getPayPalAccessToken } = require('./paypal-client');

loadLocalEnv();

const FUND_THRESHOLD = Number(process.env.ANNOUNCEMENT_FUND_THRESHOLD || 50000);
const DECEASED_TITLES = new Set(['Ato', 'Wzro', 'Lij']);
const SPOUSE_CONTINUE_STATUSES = new Set(['yes', 'no', 'no_spouse']);

function normalizeSpouseContinueStatus(meta) {
  const raw = String(meta?.spouse_continue_status || '').trim().toLowerCase();
  if (SPOUSE_CONTINUE_STATUSES.has(raw)) return raw;
  if (meta?.spouse_no_spouse === true) return 'no_spouse';
  if (meta?.spouse_will_continue === true) return 'yes';
  if (meta?.spouse_will_continue === false) return 'no';
  return null;
}

function normalizeDeceasedTitle(raw) {
  const t = String(raw || '').trim().replace(/:$/, '');
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === 'ato') return 'Ato';
  if (lower === 'wzro' || lower === 'w/ro' || lower === 'weizero') return 'Wzro';
  if (lower === 'lij') return 'Lij';
  return null;
}

function formatDeceasedDisplayName(title, name) {
  const n = String(name || '').trim();
  if (!n) return '';
  const t = normalizeDeceasedTitle(title);
  return t ? `${t} ${n}` : n;
}

function splitDeceasedTitleFromName(raw) {
  const s = String(raw || '').trim();
  const withColon = s.match(/^(Ato|Wzro|Lij)\s*:\s*(.+)$/i);
  if (withColon) return { title: normalizeDeceasedTitle(withColon[1]), name: withColon[2].trim() };
  const bare = s.match(/^(Ato|Wzro|Lij)\s+(.+)$/i);
  if (bare) return { title: normalizeDeceasedTitle(bare[1]), name: bare[2].trim() };
  return { title: null, name: s };
}

function parseEventNotes(notes) {
  if (!notes || typeof notes !== 'string') return {};
  const trimmed = notes.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function emptyServiceBlock() {
  return { enabled: false, venue: '', address: '', datetime: '' };
}

function normalizeServiceBlock(raw) {
  if (!raw || typeof raw !== 'object') return emptyServiceBlock();
  const venue = String(raw.venue || '').trim();
  const address = String(raw.address || '').trim();
  const datetime = String(raw.datetime || '').trim();
  const enabled = raw.enabled === true || (raw.enabled !== false && !!(venue || address || datetime));
  return { enabled, venue, address, datetime };
}

function normalizeAnnouncementMeta(raw = {}, eventRow = {}) {
  const meta = typeof raw === 'object' && raw ? { ...raw } : {};

  let guest = normalizeServiceBlock(meta.guest_reception);
  let church = normalizeServiceBlock(meta.church_service);
  let funeral = normalizeServiceBlock(meta.funeral_service);

  if (!church.enabled && (meta.prayer_venue || meta.prayer_address || meta.prayer_datetime)) {
    church = normalizeServiceBlock({
      enabled: true,
      venue: meta.prayer_venue || '',
      address: meta.prayer_address || '',
      datetime: meta.prayer_datetime || meta.prayer_date || meta.prayer_time || '',
    });
  }
  if (!funeral.enabled && (meta.burial_venue || meta.burial_address)) {
    funeral = normalizeServiceBlock({
      enabled: true,
      venue: meta.burial_venue || '',
      address: meta.burial_address || '',
      datetime: meta.burial_datetime || '',
    });
  }

  const collectDues = meta.collect_dues !== false && meta.waive_dues !== true;
  const notMember = meta.not_member === true;
  const rawName = String(meta.deceased_name || eventRow.deceased_name || '').trim();
  const splitFromRaw = splitDeceasedTitleFromName(rawName);
  const deceasedTitle = normalizeDeceasedTitle(meta.deceased_title) || splitFromRaw.title;
  const bareName = splitFromRaw.name || rawName;

  return {
    version: 2,
    not_member: notMember,
    member_id: notMember ? null : (meta.member_id != null ? Number(meta.member_id) : (eventRow.member_id != null ? Number(eventRow.member_id) : null)),
    deceased_title: deceasedTitle,
    deceased_name: bareName,
    deceased_note: String(meta.deceased_note || '').trim() || null,
    deceased_relationship: String(meta.deceased_relationship || eventRow.deceased_relationship || '').trim() || null,
    spouse_continue_status: normalizeSpouseContinueStatus(meta),
    spouse_will_continue: (() => {
      const status = normalizeSpouseContinueStatus(meta);
      if (status === 'yes') return true;
      if (status === 'no') return false;
      return null;
    })(),
    guest_reception: guest,
    church_service: church,
    funeral_service: funeral,
    collect_dues: collectDues,
    fund_balance_at_save: meta.fund_balance_at_save != null ? Number(meta.fund_balance_at_save) : null,
    prayer_venue: church.enabled ? church.venue : null,
    prayer_address: church.enabled ? church.address : null,
    prayer_datetime: church.enabled ? church.datetime : null,
    burial_venue: funeral.enabled ? funeral.venue : null,
    burial_address: funeral.enabled ? funeral.address : null,
    announcement_text: String(meta.announcement_text || meta.full_message || '').trim() || null,
  };
}

function metaToNotesJson(meta) {
  return JSON.stringify(normalizeAnnouncementMeta(meta));
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^(ato|weizero|dr\.?)\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractHouseholdNames(member) {
  const people = [];
  const primary = String(member.paypal_name || `${member.first_name || ''} ${member.last_name || ''}`).trim();
  if (primary) {
    people.push({ name: primary, relationship: 'Member' });
  }

  const full = String(member.full_name || '').trim();
  if (full && full !== primary) {
    const slashParts = full.split('/').map((s) => s.trim()).filter(Boolean);
    if (slashParts.length >= 2) {
      if (slashParts[0] && slashParts[0] !== primary) {
        people.push({ name: slashParts[0], relationship: 'Member' });
      }
      people.push({ name: slashParts[1], relationship: 'Spouse' });
      for (let i = 2; i < slashParts.length; i += 1) {
        people.push({ name: slashParts[i], relationship: 'Child' });
      }
    }
    const paren = full.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const outer = paren[1].trim();
      const inner = paren[2].trim();
      if (outer && outer !== primary) people.push({ name: outer, relationship: 'Member' });
      if (inner) people.push({ name: inner, relationship: 'Spouse' });
    }
  }

  return people;
}

function parseChildrenField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function searchDeceasedInCrm(db, query, limit = 20) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const [memberRes, childRes] = await Promise.all([
    db.query(
      `SELECT id, member_number, full_name, paypal_name, first_name, last_name, status
       FROM members
       WHERE LOWER(COALESCE(status, '')) = 'active'
       ORDER BY member_number ASC NULLS LAST, id ASC
       LIMIT 500`
    ),
    db.query(
      `SELECT DISTINCT ON (member_id) member_id, children
       FROM membership_applications
       WHERE status = 'Approved' AND member_id IS NOT NULL
       ORDER BY member_id, reviewed_at DESC NULLS LAST, id DESC`
    ),
  ]);

  const childrenByMember = new Map();
  for (const row of childRes.rows) {
    childrenByMember.set(row.member_id, parseChildrenField(row.children));
  }

  const needle = normalizePersonName(q);
  const matches = [];

  for (const member of memberRes.rows) {
    const household = extractHouseholdNames(member);
    const children = (childrenByMember.get(member.id) || [])
      .map((c) => {
        const name = String(c?.name || c?.full_name || '').trim();
        return name ? { name, relationship: 'Child' } : null;
      })
      .filter(Boolean);
    const allPeople = [...household, ...children];
    for (const person of allPeople) {
      const norm = normalizePersonName(person.name);
      if (!norm) continue;
      if (norm.includes(needle) || needle.includes(norm)) {
        matches.push({
          deceased_name: person.name,
          relationship: person.relationship === 'Family' ? 'Child' : person.relationship,
          member_id: member.id,
          member_number: member.member_number,
          member_name: member.paypal_name || member.full_name,
          household_name: member.full_name,
        });
      }
    }
  }

  const seen = new Set();
  return matches.filter((m) => {
    const key = `${m.member_id}|${normalizePersonName(m.deceased_name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

async function fetchPayPalBalanceSafe() {
  try {
    const accessToken = await getPayPalAccessToken();
    const base = paypalApiBase();
    const url = `${base}/v1/reporting/balances?currency_code=USD`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res.ok) return { available_balance: null, error: data.message || 'PayPal balance unavailable' };
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const primary = balances.find((b) => b.primary) || balances[0];
    const available = primary?.available_balance || primary?.total_balance;
    const value = available?.value != null ? Number(available.value) : null;
    return {
      available_balance: Number.isFinite(value) ? value : null,
      currency: available?.currency_code || 'USD',
      as_of: data.as_of_time || new Date().toISOString(),
    };
  } catch (err) {
    return { available_balance: null, error: err.message || 'PayPal balance unavailable' };
  }
}

async function getFundCollectionHint() {
  const balanceInfo = await fetchPayPalBalanceSafe();
  const balance = balanceInfo.available_balance;
  const suggestNoCollection = balance != null && balance >= FUND_THRESHOLD;
  return {
    fund_threshold: FUND_THRESHOLD,
    available_balance: balance,
    balance_as_of: balanceInfo.as_of || null,
    balance_error: balanceInfo.error || null,
    suggest_collect_dues: balance == null ? true : !suggestNoCollection,
    suggest_no_payment: suggestNoCollection,
  };
}

function buildPublicAnnouncementPayload(row, meta) {
  const eventDate = row.event_date
    ? new Date(row.event_date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Los_Angeles',
      })
    : null;

  const normalized = normalizeAnnouncementMeta(meta, row);
  const collectDues = normalized.collect_dues;

  return {
    event_number: row.event_number,
    deceased_title: normalized.deceased_title,
    deceased_name: normalized.deceased_name || String(row.deceased_name || '').trim(),
    deceased_name_display: formatDeceasedDisplayName(normalized.deceased_title, normalized.deceased_name || String(row.deceased_name || '').trim()),
    deceased_note: normalized.deceased_note,
    deceased_relationship: normalized.deceased_relationship,
    spouse_continue_status: normalized.spouse_continue_status,
    spouse_will_continue: normalized.spouse_will_continue,
    not_member: normalized.not_member,
    member_id: normalized.member_id,
    event_date: row.event_date,
    event_date_text: eventDate,
    amount_per_member: Number(row.amount_per_member || process.env.AMOUNT_PER_MEMBER || 110),
    payout_amount: Number(row.payout_amount || process.env.PAYOUT_AMOUNT || 15000),
    collect_dues: collectDues,
    no_payment_needed: !collectDues,
    guest_reception: normalized.guest_reception,
    church_service: normalized.church_service,
    funeral_service: normalized.funeral_service,
    prayer_venue: normalized.church_service.enabled ? normalized.church_service.venue : null,
    prayer_address: normalized.church_service.enabled ? normalized.church_service.address : null,
    prayer_datetime: normalized.church_service.enabled ? normalized.church_service.datetime : null,
    burial_venue: normalized.funeral_service.enabled ? normalized.funeral_service.venue : null,
    burial_address: normalized.funeral_service.enabled ? normalized.funeral_service.address : null,
    announcement_text: normalized.announcement_text,
    updated_at: new Date().toISOString(),
  };
}

function memorialRowAsEventShape(row) {
  return {
    event_number: null,
    deceased_name: row.deceased_name,
    deceased_relationship: row.deceased_relationship,
    member_id: row.member_id,
    event_date: null,
    amount_per_member: 0,
    payout_amount: 0,
    notes: row.notes,
    status: row.status,
    updated_at: row.updated_at,
  };
}

async function getCurrentAnnouncementFromDb() {
  const db = getDb();
  const [eventRes, memorialRes] = await Promise.all([
    db.query(`
      SELECT event_number, deceased_name, deceased_relationship, member_id,
             event_date, amount_per_member, payout_amount, notes, status, updated_at
      FROM events
      WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
        AND status = 'Active'
      ORDER BY event_number DESC NULLS LAST
      LIMIT 1
    `),
    db.query(`
      SELECT id, member_id, deceased_name, deceased_relationship, notes, status, updated_at
      FROM memorial_announcements
      WHERE status = 'Active'
        AND deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `).catch(() => ({ rows: [] })),
  ]);

  const eventRow = eventRes.rows[0] || null;
  const memorialRow = memorialRes.rows[0] || null;
  if (!eventRow && !memorialRow) return null;

  // Memorial-only (no collection) wins when the board published one.
  if (memorialRow) {
    const shaped = memorialRowAsEventShape(memorialRow);
    const meta = normalizeAnnouncementMeta(parseEventNotes(memorialRow.notes), shaped);
    if (!meta.collect_dues) {
      return buildPublicAnnouncementPayload(shaped, meta);
    }
  }

  if (eventRow) {
    const meta = parseEventNotes(eventRow.notes);
    return buildPublicAnnouncementPayload(eventRow, meta);
  }

  const shaped = memorialRowAsEventShape(memorialRow);
  const meta = parseEventNotes(memorialRow.notes);
  return buildPublicAnnouncementPayload(shaped, meta);
}

async function getNextEventNumber(db) {
  const res = await db.query(`SELECT COALESCE(MAX(event_number), 0) + 1 AS next_event_number FROM events`);
  return Number(res.rows[0]?.next_event_number) || 1;
}

async function createEventForAnnouncement(db, eventNumber, meta) {
  const displayName = formatDeceasedDisplayName(meta.deceased_title, meta.deceased_name);
  const amountPerMember = Number(process.env.AMOUNT_PER_MEMBER || 110);
  const payoutAmount = Number(process.env.PAYOUT_AMOUNT || 15000);
  const result = await db.query(
    `INSERT INTO events (
       event_number, deceased_name, deceased_relationship, member_id,
       status, amount_per_member, payout_amount
     ) VALUES ($1, $2, $3, $4, 'Active', $5, $6)
     RETURNING id, event_number, deceased_name, member_id`,
    [
      eventNumber,
      displayName,
      meta.deceased_relationship || null,
      meta.member_id || null,
      amountPerMember,
      payoutAmount,
    ]
  );
  return result.rows[0];
}

async function listEventsForAnnouncement(db) {
  const [res, nextEventNumber] = await Promise.all([
    db.query(`
    SELECT id, event_number, deceased_name, deceased_relationship, member_id,
           event_date, status, notes, announcement_sent_at
    FROM events
    ORDER BY event_number DESC NULLS LAST
    LIMIT 100
  `),
    getNextEventNumber(db),
  ]);
  const events = res.rows.map((row) => {
    const parsed = parseEventNotes(row.notes);
    const meta = normalizeAnnouncementMeta(parsed, row);
    const hasSavedIntake = !!(parsed.version || parsed.guest_reception || parsed.church_service
      || parsed.funeral_service || parsed.deceased_name);
    return {
      id: row.id,
      event_number: row.event_number,
      status: row.status,
      event_date: row.event_date,
      has_announcement_details: meta.guest_reception.enabled
        || meta.church_service.enabled
        || meta.funeral_service.enabled,
      has_saved_intake: hasSavedIntake,
      collect_dues: meta.collect_dues,
    };
  });
  return { next_event_number: nextEventNumber, events };
}

async function getEventAnnouncementAdmin(db, eventNumber) {
  const res = await db.query(
    `SELECT id, event_number, deceased_name, deceased_relationship, member_id,
            event_date, amount_per_member, payout_amount, notes, status
     FROM events WHERE event_number = $1 LIMIT 1`,
    [eventNumber]
  );
  const row = res.rows[0];
  if (!row) return null;
  const meta = normalizeAnnouncementMeta(parseEventNotes(row.notes), row);
  const fund = await getFundCollectionHint();
  return {
    event: {
      id: row.id,
      event_number: row.event_number,
      deceased_name: row.deceased_name,
      status: row.status,
      event_date: row.event_date,
    },
    announcement: meta,
    preview: buildPublicAnnouncementPayload(row, meta),
    fund_hint: fund,
  };
}

async function validateAnnouncementBody(db, meta) {
  if (!meta.deceased_name) {
    const err = new Error('Deceased name is required.');
    err.status = 400;
    throw err;
  }

  if (!normalizeDeceasedTitle(meta.deceased_title)) {
    const err = new Error('Select a title (Ato, Wzro, or Lij).');
    err.status = 400;
    throw err;
  }

  if (!meta.not_member && !meta.member_id) {
    const err = new Error('Select the member on file, or choose Not member for family of a member.');
    err.status = 400;
    throw err;
  }

  if (meta.not_member) return;

  const memberCheck = await db.query(
    `SELECT id FROM members WHERE id = $1 AND LOWER(COALESCE(status, '')) = 'active' LIMIT 1`,
    [meta.member_id]
  );
  if (!memberCheck.rows.length) {
    const err = new Error('Primary member must be an active member in the CRM.');
    err.status = 400;
    throw err;
  }
}

async function archiveActiveMemorialAnnouncements(db) {
  await db.query(`
    UPDATE memorial_announcements
    SET status = 'Archived', updated_at = NOW()
    WHERE status = 'Active'
  `).catch(() => {});
}

async function getMemorialAnnouncementAdmin(db) {
  const res = await db.query(`
    SELECT id, member_id, deceased_name, deceased_relationship, notes, status, updated_at
    FROM memorial_announcements
    WHERE status = 'Active'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `).catch(() => ({ rows: [] }));
  const row = res.rows[0];
  if (!row) return null;
  const meta = normalizeAnnouncementMeta(parseEventNotes(row.notes), row);
  const fund = await getFundCollectionHint();
  const shaped = memorialRowAsEventShape(row);
  return {
    source: 'memorial',
    announcement: meta,
    preview: buildPublicAnnouncementPayload(shaped, meta),
    fund_hint: fund,
    updated_at: row.updated_at,
  };
}

async function saveMemorialAnnouncementOnly(db, body, actor) {
  const fund = await getFundCollectionHint();
  const collectDues = body.collect_dues != null
    ? body.collect_dues === true
    : fund.suggest_collect_dues;

  if (collectDues) {
    const err = new Error('Select an event number when collecting member dues.');
    err.status = 400;
    throw err;
  }

  const meta = normalizeAnnouncementMeta({
    version: 2,
    not_member: body.not_member === true,
    member_id: body.not_member ? null : (body.member_id != null ? Number(body.member_id) : null),
    deceased_title: normalizeDeceasedTitle(body.deceased_title),
    deceased_name: String(body.deceased_name || '').trim(),
    deceased_note: body.deceased_note || null,
    deceased_relationship: body.deceased_relationship || null,
    spouse_continue_status: body.spouse_continue_status,
    spouse_will_continue: body.spouse_will_continue,
    guest_reception: body.guest_reception || emptyServiceBlock(),
    church_service: body.church_service || emptyServiceBlock(),
    funeral_service: body.funeral_service || emptyServiceBlock(),
    collect_dues: false,
    fund_balance_at_save: fund.available_balance,
    announcement_text: body.announcement_text != null ? String(body.announcement_text) : null,
  });

  await validateAnnouncementBody(db, meta);

  const notesJson = metaToNotesJson(meta);
  await archiveActiveMemorialAnnouncements(db);

  const insert = await db.query(`
    INSERT INTO memorial_announcements
      (member_id, deceased_name, deceased_relationship, notes, status)
    VALUES ($1, $2, $3, $4, 'Active')
    RETURNING id, member_id, deceased_name, deceased_relationship, notes, status, updated_at
  `, [
    meta.member_id,
    meta.deceased_name,
    meta.deceased_relationship,
    notesJson,
  ]);

  const row = insert.rows[0];
  const shaped = memorialRowAsEventShape(row);
  await recordServiceVenuesFromMeta(db, meta);

  return {
    source: 'memorial',
    announcement: meta,
    preview: buildPublicAnnouncementPayload(shaped, meta),
    saved_by: actor?.actor_label || null,
  };
}

async function saveEventAnnouncement(db, eventNumber, body, actor) {
  const res = await db.query(
    `SELECT id, event_number, deceased_name, member_id FROM events WHERE event_number = $1 LIMIT 1`,
    [eventNumber]
  );
  let row = res.rows[0];

  const fund = await getFundCollectionHint();
  const collectDues = body.collect_dues != null
    ? body.collect_dues === true
    : fund.suggest_collect_dues;

  const meta = normalizeAnnouncementMeta({
    version: 2,
    not_member: body.not_member === true,
    member_id: body.not_member ? null : (body.member_id != null ? Number(body.member_id) : row?.member_id),
    deceased_title: normalizeDeceasedTitle(body.deceased_title),
    deceased_name: String(body.deceased_name || row?.deceased_name || '').trim(),
    deceased_note: body.deceased_note || null,
    deceased_relationship: body.deceased_relationship || null,
    spouse_continue_status: body.spouse_continue_status,
    spouse_will_continue: body.spouse_will_continue,
    guest_reception: body.guest_reception || emptyServiceBlock(),
    church_service: body.church_service || emptyServiceBlock(),
    funeral_service: body.funeral_service || emptyServiceBlock(),
    collect_dues: collectDues,
    fund_balance_at_save: fund.available_balance,
    announcement_text: body.announcement_text != null ? String(body.announcement_text) : null,
  }, row || {});

  if (!collectDues) {
    const err = new Error('No event is needed when members are not paying. Save as a memorial-only announcement instead.');
    err.status = 400;
    throw err;
  }

  if (meta.not_member) {
    const err = new Error('Not member announcements cannot collect dues.');
    err.status = 400;
    throw err;
  }

  await validateAnnouncementBody(db, meta);

  const displayName = formatDeceasedDisplayName(meta.deceased_title, meta.deceased_name);
  let createdEvent = false;
  if (!row) {
    const taken = await db.query(`SELECT event_number FROM events WHERE event_number = $1 LIMIT 1`, [eventNumber]);
    if (taken.rows.length) {
      const err = new Error(`Event #${eventNumber} is already in use. Refresh the page for the next event number.`);
      err.status = 409;
      throw err;
    }
    row = await createEventForAnnouncement(db, eventNumber, meta);
    createdEvent = true;
  }

  await archiveActiveMemorialAnnouncements(db);

  const notesJson = metaToNotesJson(meta);
  await db.query(
    `UPDATE events
     SET deceased_name = $2,
         deceased_relationship = $3,
         member_id = $4,
         notes = $5,
         updated_at = NOW()
     WHERE event_number = $1
     RETURNING event_number, deceased_name, status, notes`,
    [
      eventNumber,
      displayName,
      meta.deceased_relationship,
      meta.member_id,
      notesJson,
    ]
  );

  const updated = await db.query(
    `SELECT event_number, deceased_name, deceased_relationship, member_id,
            event_date, amount_per_member, payout_amount, notes, status
     FROM events WHERE event_number = $1`,
    [eventNumber]
  );
  const fullRow = updated.rows[0];
  await recordServiceVenuesFromMeta(db, meta);

  return {
    event: {
      id: row.id,
      event_number: fullRow.event_number,
      deceased_name: fullRow.deceased_name,
      status: fullRow.status,
      event_date: fullRow.event_date,
      created: createdEvent,
    },
    announcement: meta,
    preview: buildPublicAnnouncementPayload(fullRow, meta),
    saved_by: actor?.actor_label || null,
  };
}

const ANN_VENUE_TYPES = ['church', 'funeral'];

const DEFAULT_SERVICE_VENUES = [
  {
    service_type: 'church',
    venue: "St. Mary's Ethiopian Orthodox Tewahedo Church",
    address: '5505 W Slauson Ave, Los Angeles, CA 90056',
  },
  {
    service_type: 'church',
    venue: "Virgin Mary's Ethiopian Orthodox Tewahedo Church",
    address: '4907 S Main St, Los Angeles, CA 90037',
  },
  {
    service_type: 'church',
    venue: 'Beza Bezuhan Kidanemihret Ethiopian Orthodox Church',
    address: '906 E 23rd St, Los Angeles, CA 90011',
  },
  {
    service_type: 'funeral',
    venue: 'Holy Cross Cemetery',
    address: '5835 W Slauson Ave, Culver City, CA 90230',
  },
  {
    service_type: 'funeral',
    venue: 'Inglewood Park Cemetery',
    address: '720 E Florence Ave, Inglewood, CA 90301',
  },
  {
    service_type: 'funeral',
    venue: 'Hollywood Forever Cemetery',
    address: '6000 Santa Monica Blvd, Los Angeles, CA 90038',
  },
];

function normalizeVenueKey(venue, address) {
  return `${String(venue || '').trim().toLowerCase()}|${String(address || '').trim().toLowerCase()}`;
}

async function upsertServiceVenue(db, serviceType, block) {
  if (!ANN_VENUE_TYPES.includes(serviceType)) return;
  const venue = String(block?.venue || '').trim();
  if (!venue) return;
  const address = String(block?.address || '').trim();
  await db.query(`
    INSERT INTO announcement_service_venues (service_type, venue, address, use_count, last_used_at)
    VALUES ($1, $2, $3, 1, NOW())
    ON CONFLICT (service_type, venue, address)
    DO UPDATE SET
      use_count = announcement_service_venues.use_count + 1,
      last_used_at = NOW()
  `, [serviceType, venue.slice(0, 200), address]).catch(() => {});
}

async function ensureDefaultServiceVenues(db) {
  for (const entry of DEFAULT_SERVICE_VENUES) {
    await upsertServiceVenue(db, entry.service_type, {
      enabled: true,
      venue: entry.venue,
      address: entry.address,
    });
  }
}

function orderVenuesWithDefaults(type, venues) {
  const defaults = DEFAULT_SERVICE_VENUES.filter((v) => v.service_type === type);
  const merged = [];
  const rest = [...venues];
  for (const d of defaults) {
    const key = normalizeVenueKey(d.venue, d.address);
    const idx = rest.findIndex((r) => normalizeVenueKey(r.venue, r.address) === key);
    if (idx >= 0) {
      merged.push(rest.splice(idx, 1)[0]);
    } else {
      merged.push({ venue: d.venue, address: d.address, use_count: 0 });
    }
  }
  merged.push(...rest.sort((a, b) => String(a.venue).localeCompare(String(b.venue))));
  return merged;
}

async function recordServiceVenuesFromMeta(db, meta) {
  if (!meta || typeof meta !== 'object') return;
  const church = meta.church_service || {};
  const funeral = meta.funeral_service || {};
  if (church.enabled && church.venue) await upsertServiceVenue(db, 'church', church);
  if (funeral.enabled && funeral.venue) await upsertServiceVenue(db, 'funeral', funeral);
}

async function backfillServiceVenuesFromAnnouncements(db) {
  const countRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM announcement_service_venues`
  ).catch(() => ({ rows: [{ n: 1 }] }));
  if ((countRes.rows[0]?.n || 0) > 0) return;

  const [eventRes, memorialRes] = await Promise.all([
    db.query(`
      SELECT notes FROM events
      WHERE notes IS NOT NULL AND TRIM(notes) LIKE '{%'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 200
    `),
    db.query(`
      SELECT notes FROM memorial_announcements
      WHERE notes IS NOT NULL AND TRIM(notes) LIKE '{%'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 200
    `).catch(() => ({ rows: [] })),
  ]);

  for (const row of [...eventRes.rows, ...memorialRes.rows]) {
    const meta = normalizeAnnouncementMeta(parseEventNotes(row.notes));
    await recordServiceVenuesFromMeta(db, meta);
  }
}

async function listServiceVenues(db, serviceType) {
  await ensureDefaultServiceVenues(db);
  await backfillServiceVenuesFromAnnouncements(db);
  const types = serviceType && ANN_VENUE_TYPES.includes(serviceType)
    ? [serviceType]
    : ANN_VENUE_TYPES;

  const res = await db.query(`
    SELECT service_type, venue, address, use_count, last_used_at
    FROM announcement_service_venues
    WHERE service_type = ANY($1::text[])
    ORDER BY last_used_at DESC NULLS LAST, use_count DESC, venue ASC
    LIMIT 80
  `, [types]).catch(() => ({ rows: [] }));

  const byType = { church: [], funeral: [] };
  const seen = { church: new Set(), funeral: new Set() };
  for (const row of res.rows) {
    const type = row.service_type;
    if (!byType[type]) continue;
    const key = normalizeVenueKey(row.venue, row.address);
    if (seen[type].has(key)) continue;
    seen[type].add(key);
    byType[type].push({
      venue: row.venue,
      address: row.address || '',
      use_count: row.use_count,
    });
  }
  byType.church = orderVenuesWithDefaults('church', byType.church);
  byType.funeral = orderVenuesWithDefaults('funeral', byType.funeral);
  return byType;
}

module.exports = {
  FUND_THRESHOLD,
  parseEventNotes,
  normalizeAnnouncementMeta,
  buildPublicAnnouncementPayload,
  getCurrentAnnouncementFromDb,
  searchDeceasedInCrm,
  getFundCollectionHint,
  listEventsForAnnouncement,
  getEventAnnouncementAdmin,
  getMemorialAnnouncementAdmin,
  saveEventAnnouncement,
  saveMemorialAnnouncementOnly,
  listServiceVenues,
  recordServiceVenuesFromMeta,
  DEFAULT_SERVICE_VENUES,
};
