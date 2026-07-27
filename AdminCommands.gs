/**
 * AdminCommands.gs — Phase 3: /cases /urgent /case /reply /close /assign
 * /note /search /reopen /export /whoami /announce /add_admin /set_role
 * /generate_urgent_code /maintenance.
 *
 * Role model (ADMINS sheet, columns already created by SetupSheets.gs):
 * TELEGRAM_ID, IS_SYSTEM_ADMIN, TIER, QUEUE. Tier and Queue are independent
 * and combinable per PLAN.md — an admin can have a tier only, a queue only,
 * both, or neither. ADMIN_TIER/ADMIN_QUEUE are defined here rather than in
 * Config.gs because, per DEPENDENCY_TREE.md's own note, they were never
 * formalized as a JS enum until whoever plans Phase 3 added one — this is
 * that enum, analogous to CaseManager.gs's CASE_STATUS.
 *
 * can_()/adminCanActOnCategory_() are a SEPARATE gate from
 * UserSession.gs's isVerified_() — one gates admin actions against the
 * ADMINS sheet, the other gates case-creation against the ROSTER/USERS
 * sheets. They must never be merged (DEPENDENCY_TREE.md finding #7): a
 * roster-verified teacher has no admin permissions, and an admin's
 * Tier/Queue says nothing about whether they're a verified teacher.
 *
 * Queue scoping is LIVE, and this paragraph used to say the opposite. Contact
 * Support now asks the teacher which topic their question is about
 * (MenuHandler.gs's caseTopicChoices_), so a case is filed under Visa, Travel,
 * Contract Signing, Accommodation, or the generic Contact Support — not under
 * the generic one every time. queueForCategory_() therefore routes real cases
 * to real queues, and adminCanSeeCase_ genuinely narrows what each admin sees.
 *
 * The operational consequence, which is the reason this matters at setup time:
 * an admin whose QUEUE is 'None' now sees NOTHING for a topic-specific case.
 * Seed admins with the queue they actually work, or with 'All'. If no active
 * admin matches a case's queue and region, notifyAdminsOfNewCase_ logs
 * "filed but NOBODY was notified" and the case sits unseen.
 *
 * Two paths still file under the generic Contact Support category and so reach
 * the All queue: Urgent Case (no topic picker — a teacher in an emergency
 * should not be asked to categorise themselves) and "Something else".
 * Document submissions file under SUBMIT_DOCS, which is also unmapped and so
 * defaults to All.
 *
 * REPORTING HONESTLY: TelegramAPI.gs never throws, so a `try/catch` around
 * sendMessage() catches nothing and a failed send used to be reported to the
 * admin as a success. Every command that tells a human something was
 * delivered now checks the returned `.ok` first.
 */

const ADMIN_TIER = {
  PROGRAM: 'Program',
  FINANCE: 'Finance',
  REGIONAL: 'Regional',
  NONE: 'None'
};

// Recruitment and Technical don't map to any CATEGORIES value today — they're
// reserved for case types the proposal describes but this bot doesn't yet
// model as an FAQ/menu category. An admin can still be assigned one; they'll
// simply see no cases under it until such a category exists.
const ADMIN_QUEUE = {
  VISA: 'Visa',
  CONTRACT: 'Contract',
  TRAVEL: 'Travel',
  ACCOMMODATION: 'Accommodation',
  RECRUITMENT: 'Recruitment',
  TECHNICAL: 'Technical',
  ALL: 'All',
  NONE: 'None'
};

const ADMIN_COMMAND_NAMES_ = [
  '/whoami', '/cases', '/urgent', '/case', '/reply', '/close', '/assign',
  '/note', '/search', '/reopen', '/export', '/announce', '/add_admin',
  '/set_role', '/generate_urgent_code', '/maintenance', '/admins', '/remove_admin',
  '/mycases'
];

// Single-use urgent code TTL — long enough for a Regional admin to reach a
// teacher by phone/in person before it goes stale.
const URGENT_CODE_TTL_SECONDS = 48 * 60 * 60;

// Broadcast pacing. Telegram throttles bulk sends at roughly 30 messages per
// second and starts returning 429s above that; Apps Script kills any
// execution at 6 minutes. Both limits used to be ignored — /announce was a
// tight synchronous loop, against proposal §8's explicit "send announcements
// gradually" mitigation.
const ANNOUNCE_SEND_DELAY_MS_ = 60;              // ≈16/sec, comfortably under the ceiling
const ANNOUNCE_MAX_RUNTIME_MS_ = 4.5 * 60 * 1000; // stop before Apps Script does

// Settings rows are read on every menu tap (maintenance gate). Cached
// briefly so that doesn't mean a sheet round-trip per interaction.
const SETTINGS_CACHE_TTL_SECONDS_ = 60;
const SETTINGS_CACHE_KEY_ = 'settings_map_v1';

// ---- ADMINS sheet access ----

function getAdminsSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.ADMINS);
  if (!sheet) throw new Error('ADMINS sheet not found — run SetupSheets.createAllSheets() first');
  return sheet;
}

function getAllAdminRows_() {
  const values = getAdminsSheet_().getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values.shift();
  return values.map((row, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/** Every ADMINS row, active or not. Use for management commands. */
function findAnyAdminRow_(chatId) {
  return getAllAdminRows_().find(r => String(r.TELEGRAM_ID) === String(chatId)) || null;
}

// ACTIVE is blank on every row that predates this column, so blank must mean
// active — otherwise deploying this task would lock out every existing admin.
function isActiveAdminRow_(row) {
  return !!row && String(row.ACTIVE === undefined || row.ACTIVE === null ? '' : row.ACTIVE)
    .trim().toUpperCase() !== 'FALSE';
}

/** The authorization lookup: a deactivated admin is not an admin. */
function findAdminRow_(chatId) {
  const row = findAnyAdminRow_(chatId);
  return isActiveAdminRow_(row) ? row : null;
}

function countActiveSystemAdmins_() {
  return getAllAdminRows_().filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r)).length;
}

/** Write one named column on one ADMINS row, by header name rather than index. */
function setAdminField_(rowNumber, columnName, value) {
  suppressAdminsSheetAlert_();
  const sheet = getAdminsSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf(columnName);
  if (col === -1) throw new Error('setAdminField_: ADMINS has no ' + columnName + ' column — re-run createAllSheets().');
  sheet.getRange(rowNumber, col + 1).setValue(value);
}

// A Sheets checkbox yields boolean true; a typed cell yields a string. An
// operator following the runbook types TRUE, but Yes/Y/1 are the natural
// alternatives and previously granted nothing, silently, with no error anywhere.
const TRUTHY_CELL_VALUES_ = ['TRUE', 'YES', 'Y', '1'];

function isSystemAdminRow_(row) {
  if (!row) return false;
  if (row.IS_SYSTEM_ADMIN === true) return true;
  return TRUTHY_CELL_VALUES_.indexOf(
    String(row.IS_SYSTEM_ADMIN).trim().toUpperCase()) !== -1;
}

/**
 * Ordered roles replacing the flat Tier, which was a category pretending to be
 * a rank: a Program admin could not issue an urgent code and a Regional admin
 * could not export, because the check was exact string equality with no
 * seniority. The only way to hold both was System Admin, so everyone became a
 * System Admin and the role model stopped meaning anything.
 */
const ADMIN_ROLE = {
  READONLY: 'ReadOnly',
  AGENT: 'Agent',
  MANAGER: 'Manager',
  SYSTEM: 'SystemAdmin'
};

const CAPABILITIES_ = {
  'case.view':    [ADMIN_ROLE.READONLY, ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'case.update':  [ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'case.assign':  [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'urgent.issue': [ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'announce':     [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'export':       [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'admin.manage': [ADMIN_ROLE.SYSTEM],
  'maintenance':  [ADMIN_ROLE.SYSTEM]
};

/**
 * Migration: ROLE is blank on every row that predates it, so fall back to the
 * old Tier/IS_SYSTEM_ADMIN pair. Both models therefore work simultaneously and
 * the ROLE column can be filled in at leisure rather than in a flag day.
 */
function roleForAdmin_(adminRow) {
  const explicit = String(adminRow.ROLE || '').trim();
  if (explicit) return explicit;
  if (isSystemAdminRow_(adminRow)) return ADMIN_ROLE.SYSTEM;
  const tier = String(adminRow.TIER || '').trim();
  if (tier === ADMIN_TIER.PROGRAM) return ADMIN_ROLE.MANAGER;
  if (tier === ADMIN_TIER.REGIONAL || tier === ADMIN_TIER.FINANCE) return ADMIN_ROLE.AGENT;
  return ADMIN_ROLE.READONLY;
}

function can_(adminRow, capability) {
  if (!adminRow || !isActiveAdminRow_(adminRow)) return false;
  const allowed = Object.prototype.hasOwnProperty.call(CAPABILITIES_, capability)
    ? CAPABILITIES_[capability] : [];
  return allowed.indexOf(roleForAdmin_(adminRow)) !== -1;
}

function isValidRole_(v) { return Object.values(ADMIN_ROLE).indexOf(v) !== -1; }

// The seven FAQ topics added after the original four have no queue of their own
// on purpose: a support team of a handful of people does not want eleven
// queues. They are mapped onto the closest existing queue, and anything
// genuinely unmapped still defaults to All so a case is never hidden from
// everyone. Revisit only if a topic grows its own dedicated staff.
function queueForCategory_(category) {
  const map = {};
  map[CATEGORIES.VISA] = ADMIN_QUEUE.VISA;
  map[CATEGORIES.TRAVEL] = ADMIN_QUEUE.TRAVEL;
  map[CATEGORIES.CONTRACT] = ADMIN_QUEUE.CONTRACT;
  map[CATEGORIES.ACCOMMODATION] = ADMIN_QUEUE.ACCOMMODATION;
  map['Salary and Payment'] = ADMIN_QUEUE.CONTRACT;
  map['Workload and Hours'] = ADMIN_QUEUE.CONTRACT;
  map['Leave and Holidays'] = ADMIN_QUEUE.CONTRACT;
  map['Placement and School'] = ADMIN_QUEUE.RECRUITMENT;
  map['Health and Insurance'] = ADMIN_QUEUE.ACCOMMODATION;
  map['Conduct and Development'] = ADMIN_QUEUE.RECRUITMENT;
  map['Living in Uzbekistan'] = ADMIN_QUEUE.ACCOMMODATION;
  return map[category] || ADMIN_QUEUE.ALL;
}

function adminCanActOnCategory_(adminRow, category) {
  if (isSystemAdminRow_(adminRow)) return true;
  const required = queueForCategory_(category);
  return String(adminRow.QUEUE) === required || String(adminRow.QUEUE) === ADMIN_QUEUE.ALL;
}

// Blank means "all regions" so that adding this column cannot narrow an existing
// admin's access as a side effect of deployment.
function adminCoversRegion_(adminRow, region) {
  const raw = String(adminRow.REGIONS === undefined || adminRow.REGIONS === null ? '' : adminRow.REGIONS).trim();
  if (!raw || raw.toUpperCase() === 'ALL') return true;
  if (!region) return true; // unknown teacher region — do not hide the case from anyone
  const wanted = String(region).trim().toLowerCase();
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).indexOf(wanted) !== -1;
}

/**
 * The teacher's region, from their USERS row. '' when the chat is a sentinel.
 *
 * MEMOIZED, and that is not an optimisation — it is a correctness requirement
 * for the execution limit. findUserRow_ reads the ENTIRE USERS sheet on every
 * call, and adminCanSeeCase_ below is used inside .filter() over case lists and
 * inside per-admin loops. Unmemoized, /cases with 50 open cases performs 50
 * whole-sheet reads, and Task 4.3's digest performs admins × cases of them —
 * which will hit the 6-minute ceiling long before the data does (CONCERNS B2).
 *
 * One map per execution is safe: an Apps Script execution handles a single
 * update, and a teacher's region cannot change inside one.
 */
let CASE_REGION_MEMO_ = null;

function caseRegionMap_() {
  if (CASE_REGION_MEMO_) return CASE_REGION_MEMO_;
  const map = {};
  try {
    const values = getUsersSheet_().getDataRange().getValues();
    if (values.length >= 2) {
      const headers = values.shift();
      const chatIdx = headers.indexOf('CHAT_ID');
      const regionIdx = headers.indexOf('REGION');
      if (chatIdx !== -1 && regionIdx !== -1) {
        values.forEach(r => { map[String(r[chatIdx])] = r[regionIdx] || ''; });
      }
    }
  } catch (err) {
    // An empty map means adminCoversRegion_ sees '' for every case, which it
    // treats as "unknown region — do not hide it from anyone". Failing open is
    // correct here: a sheet read error must not blank out every admin's queue.
    console.error('caseRegionMap_ failed, region scoping disabled this run: ' + err);
  }
  CASE_REGION_MEMO_ = map;
  return map;
}

function regionForCaseChatId_(chatId) {
  if (!chatId || String(chatId).indexOf('UNRESOLVED:') === 0) return '';
  const map = caseRegionMap_();
  return Object.prototype.hasOwnProperty.call(map, String(chatId)) ? map[String(chatId)] : '';
}

/**
 * The single visibility rule: queue AND region must both permit it. Replaces
 * bare adminCanActOnCategory_ at every case-facing call site so the two
 * dimensions can never be checked inconsistently.
 */
function adminCanSeeCase_(adminRow, caseRow) {
  if (isSystemAdminRow_(adminRow)) return true;
  if (!adminCanActOnCategory_(adminRow, caseRow.CATEGORY)) return false;
  return adminCoversRegion_(adminRow, regionForCaseChatId_(caseRow.CHAT_ID));
}

/**
 * One place that both tells the admin no and records that it happened.
 * Previously only routeAdminCommand_'s "not registered" branch logged; every
 * tier and queue rejection was silent, so an existing admin probing for
 * privileges left no trace at all. Failed authorization is precisely what an
 * audit trail is for.
 */
function denyAdminAction_(chatId, adminRow, cmd, message) {
  sendMessage(chatId, message);
  const shape = adminRow
    ? 'system=' + (isSystemAdminRow_(adminRow) ? 'Y' : 'N') +
      ' tier=' + (adminRow.TIER || 'None') + ' queue=' + (adminRow.QUEUE || 'None')
    : 'not-an-admin';
  logInteraction(chatId, 'ADMIN_DENIED', cmd + ' [' + shape + ']');
}

// A broadcast to every admin would be noise, so recipients are only those who
// could actually act on this case: its queue, All-queue, or System Admin. Until
// Phase 3 lands, every case maps to All — so in practice this reaches All-queue
// and System Admins, which is exactly who can work it today.
const NEW_CASE_NOTIFY_MAX_ADMINS_ = 20;

/**
 * Proposal §1.1: "Notify authorized staff of new or urgent cases." Never built —
 * a case, including an escalated one, was filed to the sheet and nobody was
 * told. This is the difference between a support system and a suggestion box.
 *
 * The case DETAIL is deliberately NOT included. Admins read it with /case; a
 * teacher's free text should not be copied into N separate Telegram histories.
 *
 * Never throws: a notification failure must not undo a case that was filed
 * successfully. Must NOT be called from inside a LockService critical section
 * (it calls logInteraction — see Logger.gs).
 */
// Signature changed in Task 3.2: was (reference, category, urgent). A category
// alone cannot answer "which region is this teacher in", so the whole row is
// needed — but the row is fetched HERE rather than by the caller. Every call
// site was passing findCaseByReference_(ref), i.e. doing a full CASES sheet read
// OUTSIDE this function's try/catch. A throw there (a renamed header, a transient
// read failure) aborted the caller mid-flow, and in MenuHandler's case-creation
// path that meant the case was filed, the admins were not told, AND the teacher
// never received their reference number — the confirmation is sent after this
// call. Taking a reference also keeps `reference` in scope inside the catch
// below, which it was not when it was a `const` declared inside the try.
function notifyAdminsOfNewCase_(reference, urgent) {
  try {
    const caseRow = findCaseByReference_(reference);
    if (!caseRow) {
      console.error('notifyAdminsOfNewCase_: no case found with reference ' + reference +
        ' — it was filed but NOBODY was notified.');
      return;
    }
    const category = caseRow.CATEGORY;

    const recipients = getAllAdminRows_()
      .filter(r => String(r.TELEGRAM_ID || '').trim())
      .filter(r => isActiveAdminRow_(r))
      .filter(r => adminCanSeeCase_(r, caseRow));

    if (!recipients.length) {
      console.error('notifyAdminsOfNewCase_: no admin is authorized for category "' + category +
        '" — case ' + reference + ' was filed but NOBODY was notified. Check the ADMINS sheet.');
      return;
    }

    const text = [
      (urgent ? '🚨 URGENT case ' : '🆕 New case ') + reference,
      'Category: ' + category,
      'Opened: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
      '',
      '/case ' + reference + ' — read it',
      '/assign ' + reference + ' <your_telegram_id> — take it'
    ].join('\n');

    let delivered = 0;
    recipients.slice(0, NEW_CASE_NOTIFY_MAX_ADMINS_).forEach(r => {
      const result = sendMessage(r.TELEGRAM_ID, text);
      if (result.ok) {
        delivered++;
      } else {
        console.error('notifyAdminsOfNewCase_: could not reach admin ' + r.TELEGRAM_ID +
          ' about ' + reference + ': ' + (result.description || 'unknown error'));
      }
    });

    // 'SYSTEM' rather than a chat id: this is a bot-initiated event, not a
    // teacher interaction, and putting a case reference in the CHAT_ID column
    // would make the log ambiguous. Same convention as Task 5.2.
    logInteraction('SYSTEM', urgent ? 'ADMINS_NOTIFIED_URGENT' : 'ADMINS_NOTIFIED_NEW',
      reference + ' — delivered ' + delivered + '/' + recipients.length);
  } catch (err) {
    console.error('notifyAdminsOfNewCase_ failed for ' + reference + ': ' + err);
  }
}

function isValidTier_(v) { return Object.values(ADMIN_TIER).indexOf(v) !== -1; }
function isValidQueue_(v) { return Object.values(ADMIN_QUEUE).indexOf(v) !== -1; }

// ---- Dispatcher ----

/**
 * Entry point called from Webhook.gs for any text starting with "/". Returns
 * false for anything not in ADMIN_COMMAND_NAMES_ so the caller falls through
 * to normal text handling (so a random "/foo" still gets the usual "I didn't
 * understand that" rather than an admin-specific message). Returns true for
 * everything else, including a clean rejection of a non-admin — this is what
 * makes "commands fail cleanly for non-admins" (Phase 3 exit check) hold for
 * every command uniformly instead of each handler re-checking.
 */
function routeAdminCommand_(chatId, text) {
  const firstSpace = text.indexOf(' ');
  const rawCmd = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const cmd = rawCmd.toLowerCase().split('@')[0]; // strip "@BotName" some clients append
  if (ADMIN_COMMAND_NAMES_.indexOf(cmd) === -1) return false;

  const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
  const adminRow = findAdminRow_(chatId);
  if (!adminRow) {
    sendMessage(chatId, 'You are not registered as an admin.');
    logInteraction(chatId, 'ADMIN_COMMAND_DENIED', cmd);
    return true;
  }

  switch (cmd) {
    case '/whoami': handleWhoAmI_(chatId, adminRow); break;
    case '/cases': handleListCases_(chatId, adminRow, rest); break;
    case '/urgent': handleUrgentList_(chatId, adminRow); break;
    case '/case': handleCaseDetail_(chatId, adminRow, rest); break;
    case '/reply': handleReply_(chatId, adminRow, rest); break;
    case '/close': handleClose_(chatId, adminRow, rest); break;
    case '/assign': handleAssign_(chatId, adminRow, rest); break;
    case '/note': handleNote_(chatId, adminRow, rest); break;
    case '/search': handleSearch_(chatId, adminRow, rest); break;
    case '/reopen': handleReopen_(chatId, adminRow, rest); break;
    case '/export': handleExport_(chatId, adminRow, rest); break;
    case '/announce': handleAnnounce_(chatId, adminRow, rest); break;
    case '/add_admin': handleAddAdmin_(chatId, adminRow, rest); break;
    case '/set_role': handleSetRole_(chatId, adminRow, rest); break;
    case '/generate_urgent_code': handleGenerateUrgentCode_(chatId, adminRow); break;
    case '/maintenance': handleMaintenance_(chatId, adminRow, rest); break;
    case '/admins': handleListAdmins_(chatId, adminRow); break;
    case '/remove_admin': handleRemoveAdmin_(chatId, adminRow, rest); break;
    case '/mycases': handleMyCases_(chatId, adminRow); break;
  }
  return true;
}

function adminCommandsHelpText_() {
  return 'Admin commands:\n' + ADMIN_COMMAND_NAMES_.join('  ') +
    '\n\n/cases — open cases only. /cases all — every case. /cases unassigned — nobody has taken them. /cases <status> — one status.' +
    '\n/mycases — cases assigned to you.';
}

// ---- Read-only commands ----

// Answers "what can I do?" from the capability table itself, so this can never
// describe a different model than the one the gates enforce (Task 5.3 3c).
function handleWhoAmI_(chatId, adminRow) {
  const can = [];
  can.push('View and work cases in queue: ' + (adminRow.QUEUE || 'None'));
  if (can_(adminRow, 'case.update')) can.push('Reply, close, note and reopen cases');
  if (can_(adminRow, 'case.assign')) can.push('/assign cases to other admins');
  if (can_(adminRow, 'urgent.issue')) can.push('/generate_urgent_code');
  if (can_(adminRow, 'announce')) can.push('/announce');
  if (can_(adminRow, 'export')) can.push('/export');
  if (can_(adminRow, 'admin.manage')) can.push('/add_admin, /set_role, /remove_admin, /admins');
  if (can_(adminRow, 'maintenance')) can.push('/maintenance');
  // The Tier fallback is made visible — otherwise nobody would ever know a row
  // still needs its ROLE migrated.
  const roleLine = 'Role: ' + roleForAdmin_(adminRow) +
    (String(adminRow.ROLE || '').trim() ? '' : ' (inherited from Tier)');
  sendMessage(chatId, [
    'Telegram ID: ' + adminRow.TELEGRAM_ID,
    (adminRow.NAME ? 'Name: ' + adminRow.NAME : null),
    'System Admin: ' + (isSystemAdminRow_(adminRow) ? 'Yes' : 'No'),
    roleLine,
    'Tier: ' + (adminRow.TIER || 'None'),
    'Queue: ' + (adminRow.QUEUE || 'None'),
    '',
    'You can:',
    can.map(c => ' • ' + c).join('\n')
  ].filter(l => l !== null).join('\n'));
}

function formatCaseList_(rows) {
  return rows.map(r =>
    r.REFERENCE + ' — ' + r.STATUS + ' (' + r.CATEGORY + ')' + (r.OWNER ? ' — owner ' + r.OWNER : '')
  ).join('\n');
}

function normalizeStatusArg_(raw) {
  if (!raw) return undefined;
  const needle = raw.trim().toLowerCase();
  const match = Object.values(CASE_STATUS).find(s => s.toLowerCase() === needle);
  return match || null; // null = an explicit but invalid filter was given
}

/**
 * /cases            → OPEN cases only (proposal §6 defines this command as
 *                     "show open cases assigned to the administrator's
 *                     permitted queue"; it previously listed closed and
 *                     completed ones too, which buried the actionable work)
 * /cases all        → every case regardless of status
 * /cases <status>   → one specific status. Status may be multiple words
 *                     ("Under review"), so the remainder is NOT split on
 *                     whitespace — it's treated as one phrase.
 */
function handleListCases_(chatId, adminRow, rest) {
  const arg = (rest || '').trim();
  let rows;
  let heading;

  if (!arg) {
    rows = findCasesBy_({ openOnly: true });
    heading = 'Open cases';
  } else if (arg.toLowerCase() === 'all') {
    rows = findCasesBy_({});
    heading = 'All cases';
  } else if (arg.toLowerCase() === 'unassigned') {
    // The intake backlog: open cases nobody has picked up. This is the view a
    // supervisor needs first thing in the morning and there was no way to get it.
    rows = findCasesBy_({ openOnly: true }).filter(r => !String(r.OWNER || '').trim());
    heading = 'Unassigned open cases';
  } else {
    const statusFilter = normalizeStatusArg_(arg);
    if (statusFilter === null) {
      sendMessage(chatId, 'Unknown status. Valid: ' + Object.values(CASE_STATUS).join(', ') + '\nOr use "all" for every case.');
      return;
    }
    rows = findCasesBy_({ status: statusFilter });
    heading = 'Cases with status "' + statusFilter + '"';
  }

  const visible = rows.filter(r => adminCanSeeCase_(adminRow, r));
  if (!visible.length) { sendMessage(chatId, 'No cases found.'); return; }
  const shown = visible.slice(0, 20);
  let text = heading + ' (' + shown.length + (visible.length > shown.length ? ' of ' + visible.length : '') + '):\n' + formatCaseList_(shown);
  if (visible.length > shown.length) text += '\n\nUse /search to narrow this down.';
  sendMessage(chatId, text);
}

/**
 * Escalated cases, plus overdue ones — proposal §6 defines /urgent as
 * "urgent OR overdue". "Overdue" needs a policy number, so it's read from
 * SETTINGS (KEY = OVERDUE_DAYS), the same decide-it-in-the-sheet pattern
 * ArchiveManager.gs uses for RETENTION_DAYS. Until that row exists the
 * command behaves exactly as before and says so, rather than this file
 * inventing an SLA.
 */
function getOverdueDays_() {
  const raw = getSettingValue_('OVERDUE_DAYS');
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * The overdue list existed only as output from a command nobody was obliged to
 * run. This pushes it. Sent to each admin scoped to what they can actually see,
 * so it is a personal worklist rather than a wall of everyone's cases.
 * Called from Triggers.gs's runDailyDigest time-driven trigger.
 */
function sendOverdueDigest_() {
  const overdueDays = getOverdueDays_();
  if (!overdueDays) {
    console.error('sendOverdueDigest_: no OVERDUE_DAYS in SETTINGS — skipping.');
    return;
  }
  const cutoff = new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000);
  const stale = findCasesBy_({ openOnly: true })
    .filter(r => r.UPDATED_AT && new Date(r.UPDATED_AT) < cutoff);
  if (!stale.length) return;

  getAllAdminRows_().filter(r => isActiveAdminRow_(r)).forEach(admin => {
    const mine = stale.filter(c => adminCanSeeCase_(admin, c));
    if (!mine.length) return;
    const unassigned = mine.filter(c => !String(c.OWNER || '').trim()).length;
    sendMessage(admin.TELEGRAM_ID, [
      '⏰ ' + mine.length + ' case(s) have had no update for over ' + overdueDays + ' days' +
        (unassigned ? ' — ' + unassigned + ' of them unassigned' : '') + ':',
      formatCaseList_(mine.slice(0, 20)),
      '',
      '/mycases — just yours · /cases unassigned — the backlog'
    ].join('\n'));
  });
}

function handleUrgentList_(chatId, adminRow) {
  const escalated = findCasesBy_({ status: CASE_STATUS.ESCALATED });
  const overdueDays = getOverdueDays_();

  let rows = escalated;
  if (overdueDays) {
    const cutoff = new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000);
    const seen = {};
    escalated.forEach(r => { seen[r.REFERENCE] = true; });
    const overdue = findCasesBy_({ openOnly: true }).filter(r =>
      !seen[r.REFERENCE] && r.UPDATED_AT && new Date(r.UPDATED_AT) < cutoff
    );
    rows = escalated.concat(overdue);
  }

  const visible = rows.filter(r => adminCanSeeCase_(adminRow, r));
  if (!visible.length) {
    sendMessage(chatId, 'No escalated cases.' + (overdueDays ? '' : '\n\n(No OVERDUE_DAYS set in SETTINGS, so overdue cases are not included. Add that row to enable it.)'));
    return;
  }
  let text = (overdueDays ? 'Escalated and overdue (>' + overdueDays + 'd) cases' : 'Escalated cases') + ':\n' +
    formatCaseList_(visible.slice(0, 20));
  if (!overdueDays) text += '\n\n(No OVERDUE_DAYS set in SETTINGS, so overdue cases are not included.)';
  sendMessage(chatId, text);
}

function handleCaseDetail_(chatId, adminRow, rest) {
  const reference = rest.trim().split(/\s+/)[0];
  if (!reference) { sendMessage(chatId, 'Usage: /case <reference>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) { denyAdminAction_(chatId, adminRow, '/case', "You are not authorized for this case's queue."); return; }
  // DETAIL grows every time /note appends to it, so this message can exceed
  // Telegram's 4096-char limit. sendMessage() splits it rather than the
  // whole reply silently failing.
  sendMessage(chatId, [
    'Reference: ' + c.REFERENCE,
    'Category: ' + c.CATEGORY,
    'Chat ID: ' + c.CHAT_ID,
    'Status: ' + c.STATUS,
    'Owner: ' + (c.OWNER || '(unassigned)'),
    'Created: ' + c.CREATED_AT,
    'Updated: ' + c.UPDATED_AT,
    'Last changed by: ' + (c.LAST_ACTOR || '(not recorded)'),
    'Detail: ' + (c.DETAIL || '(none)'),
    'Public update: ' + (c.PUBLIC_UPDATE || '(none)')
  ].join('\n'));
}

function handleSearch_(chatId, adminRow, term) {
  term = (term || '').trim();
  if (!term) { sendMessage(chatId, 'Usage: /search <term>'); return; }
  const needle = term.toLowerCase();
  const rows = getAllCaseRows_().filter(r =>
    adminCanSeeCase_(adminRow, r) && (
      String(r.REFERENCE).toLowerCase().indexOf(needle) !== -1 ||
      String(r.DETAIL).toLowerCase().indexOf(needle) !== -1 ||
      String(r.PUBLIC_UPDATE).toLowerCase().indexOf(needle) !== -1
    )
  );
  sendMessage(chatId, rows.length ? formatCaseList_(rows.slice(0, 20)) : 'No matches.');
}

// ---- Case-mutating commands (queue-gated by the case's own category) ----

// Phase 5 introduced sentinel CHAT_ID values ("UNRESOLVED:...") for document
// submissions where no verified Telegram identity could be resolved — see
// Triggers.gs's fileDocumentSubmissionCase_. Those aren't real chat_ids;
// sendMessage() to one just fails, leaving the admin wrongly told "sent"
// unless we check first.
function hasNotifiableChatId_(c) {
  return !!c.CHAT_ID && String(c.CHAT_ID).indexOf('UNRESOLVED:') !== 0;
}

/**
 * updateCaseFields_ THROWS when it cannot take the script lock (CaseManager.gs).
 * Every admin mutation below used to call it bare, so that throw propagated up
 * to doPost — which swallows everything — and the admin's /reply, /close,
 * /assign, /note or /reopen produced no response whatsoever: no confirmation,
 * no error, nothing. The logInteraction and "done" message that follow each
 * call never ran either, so there was no record the command had been attempted.
 *
 * @returns {boolean} true if the write landed. On false the admin has already
 *   been told what happened and the caller must return without proceeding.
 */
function tryUpdateCaseFields_(chatId, reference, fields) {
  try {
    updateCaseFields_(reference, fields, { actor: chatId });
    return true;
  } catch (err) {
    console.error('tryUpdateCaseFields_ failed for ' + reference + ': ' + err);
    sendMessage(chatId, 'Could not update ' + reference + ' — the sheet was busy. ' +
      'Nothing has been changed; please try again in a moment.');
    return false;
  }
}

function handleReply_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'case.update')) { denyAdminAction_(chatId, adminRow, '/reply', 'Your role cannot update cases — Agent role or above is required.'); return; }
  const spaceIdx = rest.indexOf(' ');
  const reference = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const message = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (!reference || !message) { sendMessage(chatId, 'Usage: /reply <reference> <message>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) { denyAdminAction_(chatId, adminRow, '/reply', "You are not authorized for this case's queue."); return; }
  if (!tryUpdateCaseFields_(chatId, reference, { PUBLIC_UPDATE: message })) return;
  logInteraction(chatId, 'CASE_REPLY', reference);

  if (!hasNotifiableChatId_(c)) {
    sendMessage(chatId, 'Case updated, but this is an unresolved-submitter case with no known chat to notify — nothing was sent.');
    return;
  }
  const result = sendMessage(c.CHAT_ID, 'Update on your case ' + reference + ': ' + message);
  sendMessage(chatId, result.ok
    ? 'Reply sent and case updated.'
    : 'Case updated, but the message to the teacher FAILED to send (' + (result.description || 'unknown error') +
      '). They may have blocked the bot or never started a chat with it.');
}

function handleClose_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'case.update')) { denyAdminAction_(chatId, adminRow, '/close', 'Your role cannot update cases — Agent role or above is required.'); return; }
  const spaceIdx = rest.indexOf(' ');
  const reference = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const reason = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (!reference) { sendMessage(chatId, 'Usage: /close <reference> [reason]'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) { denyAdminAction_(chatId, adminRow, '/close', "You are not authorized for this case's queue."); return; }
  const fields = { STATUS: CASE_STATUS.CLOSED };
  if (reason) fields.PUBLIC_UPDATE = reason;
  if (!tryUpdateCaseFields_(chatId, reference, fields)) return;
  logInteraction(chatId, 'CASE_CLOSED', reference);

  if (!hasNotifiableChatId_(c)) {
    sendMessage(chatId, 'Case closed. (Unresolved-submitter case — no chat to notify.)');
    return;
  }
  const result = sendMessage(c.CHAT_ID, 'Your case ' + reference + ' has been closed.' + (reason ? ' ' + reason : ''));
  sendMessage(chatId, result.ok
    ? 'Case closed and teacher notified.'
    : 'Case closed, but notifying the teacher FAILED (' + (result.description || 'unknown error') + ').');
}

function handleAssign_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'case.assign')) { denyAdminAction_(chatId, adminRow, '/assign', 'Your role cannot assign cases — Manager role is required.'); return; }
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const reference = parts[0];
  const assigneeId = parts[1];
  if (!reference || !assigneeId) { sendMessage(chatId, 'Usage: /assign <reference> <telegram_id>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) {
    denyAdminAction_(chatId, adminRow, '/assign', "You are not authorized for this case's queue.");
    return;
  }

  // Previously any string was accepted, so cases were routinely assigned to
  // typos and to people who are not admins — the case then looked handled and
  // nobody was working it.
  const assignee = findAdminRow_(assigneeId);
  if (!assignee) {
    sendMessage(chatId, assigneeId + ' is not an active admin. Use /admins to see the list.');
    return;
  }
  if (!adminCanSeeCase_(assignee, c)) {
    sendMessage(chatId, 'Refusing: ' + assigneeId + ' cannot see this case (queue=' +
      (assignee.QUEUE || 'None') + '). Assign it to someone in the right queue, or widen theirs with /set_role.');
    return;
  }

  if (!tryUpdateCaseFields_(chatId, reference, { OWNER: assigneeId })) return;
  logInteraction(chatId, 'CASE_ASSIGNED', reference + ' -> ' + assigneeId);
  sendMessage(chatId, 'Case ' + reference + ' assigned to ' + assigneeId +
    (assignee.NAME ? ' (' + assignee.NAME + ')' : '') + '.');

  const notice = sendMessage(assigneeId, '📋 Case ' + reference + ' has been assigned to you by ' +
    (adminRow.NAME || adminRow.TELEGRAM_ID) + '.\n\n/case ' + reference + ' — read it');
  if (!notice.ok) {
    sendMessage(chatId, 'Assigned, but ' + assigneeId + ' could not be notified (' +
      (notice.description || 'unknown error') + '). Tell them another way.');
  }
}

// findCasesBy_ has supported an owner filter since Phase 3 and no command ever
// used it, so an admin had no way to see their own workload.
function handleMyCases_(chatId, adminRow) {
  const rows = findCasesBy_({ owner: chatId, openOnly: true })
    .filter(r => adminCanSeeCase_(adminRow, r));
  if (!rows.length) { sendMessage(chatId, 'Nothing is assigned to you right now.'); return; }
  sendMessage(chatId, 'Assigned to you (' + rows.length + ' open):\n' + formatCaseList_(rows.slice(0, 20)));
}

// DETAIL is internal-only (never surfaced to the teacher, per the CASES
// sheet contract) so notes append there, timestamped and attributed, rather
// than to PUBLIC_UPDATE.
function handleNote_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'case.update')) { denyAdminAction_(chatId, adminRow, '/note', 'Your role cannot update cases — Agent role or above is required.'); return; }
  const spaceIdx = rest.indexOf(' ');
  const reference = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const note = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (!reference || !note) { sendMessage(chatId, 'Usage: /note <reference> <note>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) { denyAdminAction_(chatId, adminRow, '/note', "You are not authorized for this case's queue."); return; }
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const combined = (c.DETAIL ? c.DETAIL + '\n' : '') + '[' + stamp + ' note by ' + chatId + '] ' + note;
  if (!tryUpdateCaseFields_(chatId, reference, { DETAIL: combined })) return;
  logInteraction(chatId, 'CASE_NOTE', reference);
  sendMessage(chatId, 'Note added (internal only, not shown to teacher).');
}

function handleReopen_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'case.update')) { denyAdminAction_(chatId, adminRow, '/reopen', 'Your role cannot update cases — Agent role or above is required.'); return; }
  const reference = rest.trim().split(/\s+/)[0];
  if (!reference) { sendMessage(chatId, 'Usage: /reopen <reference>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) { denyAdminAction_(chatId, adminRow, '/reopen', "You are not authorized for this case's queue."); return; }
  if (!tryUpdateCaseFields_(chatId, reference, { STATUS: CASE_STATUS.UNDER_REVIEW })) return;
  logInteraction(chatId, 'CASE_REOPENED', reference);

  if (!hasNotifiableChatId_(c)) {
    sendMessage(chatId, 'Case reopened. (Unresolved-submitter case — no chat to notify.)');
    return;
  }
  const result = sendMessage(c.CHAT_ID, 'Your case ' + reference + ' has been reopened and is under review again.');
  sendMessage(chatId, result.ok
    ? 'Case reopened and teacher notified.'
    : 'Case reopened, but notifying the teacher FAILED (' + (result.description || 'unknown error') + ').');
}

// ---- Tier-gated commands ----

function csvEscape_(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// DETAIL is deliberately excluded from the export columns — an individual
// admin can read it per-case via /case, but a bulk CSV leaving the bot as a
// downloadable file is a bigger exposure surface for whatever sensitive free
// text a teacher wrote, so it doesn't leave in bulk.
function handleExport_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'export')) {
    denyAdminAction_(chatId, adminRow, '/export', 'Only Manager-role admins can export.');
    return;
  }
  const reason = (rest || '').trim();
  if (reason.length < 10) {
    sendMessage(chatId, 'Usage: /export <reason>\n\nExample: /export monthly report for the Recruitment Council\n\n' +
      'A bulk export of case data leaves the platform, so the reason is recorded and other System Admins are notified.');
    return;
  }
  const rows = getAllCaseRows_().filter(r => adminCanSeeCase_(adminRow, r));
  if (rows.length === 0) { sendMessage(chatId, 'No cases to export.'); return; }

  const headers = ['REFERENCE', 'CATEGORY', 'CHAT_ID', 'STATUS', 'OWNER', 'CREATED_AT', 'UPDATED_AT', 'PUBLIC_UPDATE'];
  const csvLines = [headers.join(',')].concat(rows.map(r => headers.map(h => csvEscape_(r[h])).join(',')));
  const blob = Utilities.newBlob(csvLines.join('\n'), 'text/csv', 'cases_export_' + Date.now() + '.csv');
  const result = sendDocument(chatId, blob, rows.length + ' cases exported.');
  if (!result.ok) {
    sendMessage(chatId, 'Export FAILED to send (' + (result.description || 'unknown error') + ').');
    return;
  }
  logInteraction(chatId, 'CASES_EXPORTED', rows.length + ' rows — reason: ' + reason.slice(0, 200));

  const notice = '📤 ' + (adminRow.NAME || adminRow.TELEGRAM_ID) + ' exported ' + rows.length +
    ' case records.\nReason given: ' + reason;
  getAllAdminRows_()
    .filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r) && String(r.TELEGRAM_ID) !== String(chatId))
    .forEach(r => sendMessage(r.TELEGRAM_ID, notice));
}

function getAnnouncementsSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.ANNOUNCEMENTS);
  if (!sheet) throw new Error('ANNOUNCEMENTS sheet not found — run SetupSheets.createAllSheets() first');
  return sheet;
}

function appendAnnouncementRow_(id, content, audience, status, createdBy) {
  getAnnouncementsSheet_().appendRow([id, content, audience, status, createdBy, new Date()]);
}

// Read-then-write by row index — the same shape as CaseManager's
// updateCaseFields_, and locked for the same reason. Unlocked, two overlapping
// /announce runs could interleave their read and their write and stamp the
// status onto the wrong announcement row.
function updateAnnouncementStatus_(id, status) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.error('updateAnnouncementStatus_: could not acquire the script lock for ' + id +
      ' — its row is left marked SENDING. The delivery itself already finished.');
    return;
  }
  try {
    const sheet = getAnnouncementsSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        sheet.getRange(i + 1, 4).setValue(status); // column 4 = STATUS
        return;
      }
    }
    console.error('updateAnnouncementStatus_: no ANNOUNCEMENTS row matched ' + id + '.');
  } catch (err) {
    console.error('updateAnnouncementStatus_ failed for ' + id + ': ' + err);
  } finally {
    lock.releaseLock();
  }
}

// Only verified USERS rows are ever targeted — an unverified chat_id was
// never bound to an identity, so there is nothing legitimate to address it
// by (region, name), consistent with the verification guardrail elsewhere.
function getAnnouncementTargets_(audience) {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.USERS);
  if (!sheet) throw new Error('USERS sheet not found — run SetupSheets.createAllSheets() first');
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values.shift();
  const chatIdx = headers.indexOf('CHAT_ID');
  const stateIdx = headers.indexOf('VERIFICATION_STATE');
  const regionIdx = headers.indexOf('REGION');
  const isAll = audience.toUpperCase() === 'ALL';
  return values
    .filter(row => row[stateIdx] === VERIFICATION_STATE.VERIFIED)
    .filter(row => isAll || String(row[regionIdx]).trim().toLowerCase() === audience.trim().toLowerCase())
    .map(row => row[chatIdx])
    .filter(id => id !== '' && id !== null && id !== undefined);
}

/**
 * Broadcast, paced and honestly reported.
 *
 * The previous version wrapped sendMessage() in try/catch and counted a
 * success for every iteration the catch didn't fire on — but sendMessage()
 * never throws, so the catch was unreachable and `sent` always equalled the
 * target count. Every announcement was recorded as SENT and every admin was
 * told "N/N", whether or not a single message arrived. Delivery is now
 * determined by the returned `.ok`, and blocked/deleted recipients are named
 * back to the admin so the roster can be cleaned up.
 */
// Drafts live in Script Properties rather than a chat-state cache entry because
// they must survive the admin closing Telegram, and they are per-admin so two
// people preparing announcements cannot confirm each other's.
const ANNOUNCE_DRAFT_TTL_MS_ = 60 * 60 * 1000;

function announceDraftKey_(chatId) { return 'ANNOUNCE_DRAFT_' + chatId; }

function handleAnnounce_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'announce')) {
    denyAdminAction_(chatId, adminRow, '/announce', 'Only Manager-role admins can send announcements.');
    return;
  }
  const arg = (rest || '').trim();

  // Bare "confirm"/"cancel" only. A region genuinely named "Confirm" is absurd,
  // but "/announce cancel <message>" is a plausible typo-slip and must not be
  // swallowed as a control word — requiring no remainder keeps the two
  // vocabularies from overlapping at all.
  if (arg.toLowerCase() === 'confirm') { confirmAnnouncement_(chatId, adminRow); return; }
  if (arg.toLowerCase() === 'cancel') {
    PropertiesService.getScriptProperties().deleteProperty(announceDraftKey_(chatId));
    sendMessage(chatId, 'Draft announcement discarded.');
    return;
  }

  const spaceIdx = arg.indexOf(' ');
  const audience = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx).trim();
  const content = spaceIdx === -1 ? '' : arg.slice(spaceIdx + 1).trim();
  if (!audience || !content) {
    sendMessage(chatId, 'Usage: /announce <ALL|region-name> <message>\nThen /announce confirm to send, or /announce cancel.');
    return;
  }

  const targets = getAnnouncementTargets_(audience);
  if (targets.length === 0) { sendMessage(chatId, 'No verified users match audience "' + audience + '".'); return; }

  PropertiesService.getScriptProperties().setProperty(announceDraftKey_(chatId), JSON.stringify({
    audience: audience, content: content, count: targets.length, createdAt: Date.now()
  }));
  // Logged at DRAFT time, not only at send time: an announcement that was
  // prepared and then abandoned is exactly the thing an audit trail should show,
  // and previously only completed sends left any trace.
  logInteraction(chatId, 'ANNOUNCEMENT_DRAFTED', audience + ' — ' + targets.length + ' recipients');

  sendMessage(chatId, [
    '📋 DRAFT — nothing has been sent yet.',
    '',
    'Audience: ' + audience + ' (' + targets.length + ' verified teachers)',
    '',
    '--- message preview ---',
    '📢 ' + content,
    '--- end of preview ---',
    '',
    'Check the wording, then send /announce confirm — or /announce cancel to discard.',
    'The draft expires in one hour.'
  ].join('\n'));
}

function confirmAnnouncement_(chatId, adminRow) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(announceDraftKey_(chatId));
  if (!raw) { sendMessage(chatId, 'No draft to send. Start with /announce <ALL|region> <message>.'); return; }

  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (err) {
    props.deleteProperty(announceDraftKey_(chatId));
    sendMessage(chatId, 'That draft was unreadable and has been discarded. Please start again.');
    return;
  }
  props.deleteProperty(announceDraftKey_(chatId));
  if (Date.now() - draft.createdAt > ANNOUNCE_DRAFT_TTL_MS_) {
    sendMessage(chatId, 'That draft has expired. Please start again.');
    return;
  }

  deliverAnnouncement_(chatId, draft.audience, draft.content);
}

/**
 * The actual send loop — paced and honestly reported (see the delivery notes
 * on ANNOUNCE_SEND_DELAY_MS_ above). Reached only via /announce confirm.
 */
function deliverAnnouncement_(chatId, audience, content) {
  const targets = getAnnouncementTargets_(audience);
  if (targets.length === 0) { sendMessage(chatId, 'No verified users match audience "' + audience + '" any more.'); return; }
  const id = 'ANN-' + Date.now();
  appendAnnouncementRow_(id, content, audience, 'SENDING', chatId);
  sendMessage(chatId, 'Sending to ' + targets.length + ' users… I will report back when finished.');

  const startedAt = Date.now();
  let sent = 0, failed = 0, notAttempted = 0;
  const failedIds = [];

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > ANNOUNCE_MAX_RUNTIME_MS_) {
      notAttempted = targets.length - i;
      console.error('deliverAnnouncement_: stopping at ' + i + '/' + targets.length + ' to stay inside the Apps Script execution limit.');
      break;
    }
    const result = sendMessage(targets[i], '📢 ' + content);
    if (result.ok) { sent++; } else { failed++; if (failedIds.length < 20) failedIds.push(String(targets[i])); }
    if (i < targets.length - 1) Utilities.sleep(ANNOUNCE_SEND_DELAY_MS_);
  }

  const status = (failed === 0 && notAttempted === 0) ? 'SENT' : (sent === 0 ? 'FAILED' : 'PARTIAL');
  updateAnnouncementStatus_(id, status);
  logInteraction(chatId, 'ANNOUNCEMENT_' + status, id + ' sent=' + sent + ' failed=' + failed + ' skipped=' + notAttempted);

  let report = 'Announcement ' + id + ': ' + status + '.\nDelivered: ' + sent + '/' + targets.length;
  if (failed) report += '\nFailed: ' + failed + (failedIds.length ? ' (' + failedIds.join(', ') + (failed > failedIds.length ? ', …' : '') + ')' : '');
  if (notAttempted) report += '\nNot attempted (ran out of execution time): ' + notAttempted + '. Re-run for the remainder.';
  sendMessage(chatId, report);
}

// ---- System-Admin-only commands ----

// Same pattern and same reason as CaseManager.gs's onEditSuppressKey_: an
// installable onEdit trigger cannot tell a hand edit from a setValue(), and
// Task 5.2's alert is worthless if the bot's own commands set it off.
const ADMINS_EDIT_SUPPRESS_KEY_ = 'suppress_onedit_admins';
const ADMINS_EDIT_SUPPRESS_TTL_SECONDS_ = 60;

function suppressAdminsSheetAlert_() {
  try {
    CacheService.getScriptCache().put(ADMINS_EDIT_SUPPRESS_KEY_, '1', ADMINS_EDIT_SUPPRESS_TTL_SECONDS_);
  } catch (err) {
    console.error('suppressAdminsSheetAlert_ failed (an extra alert may fire): ' + err);
  }
}

// Header-based rather than positional: the sheet now has nine columns and a
// getRange(row, 1, 1, 4) write would silently stop covering the new ones.
function upsertAdminRow_(targetId, isSystem, tier, queue, addedBy, name, role) {
  suppressAdminsSheetAlert_();
  const sheet = getAdminsSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const existing = findAnyAdminRow_(targetId);
  const values = {
    TELEGRAM_ID: targetId,
    IS_SYSTEM_ADMIN: isSystem,
    TIER: tier,
    QUEUE: queue,
    NAME: name || '',
    ACTIVE: 'TRUE',
    ADDED_BY: String(addedBy || ''),
    ADDED_AT: new Date(),
    ROLE: role || ''
  };
  const rowNumber = existing ? existing._rowNumber : sheet.getLastRow() + 1;
  // One write, not one per column: eight setValue calls are eight onEdit events,
  // eight revisions in the sheet's history, and eight chances to interleave with
  // another admin's write. Headers drive the order, so an added column is picked
  // up automatically and an unknown one is left untouched.
  const row = headers.map(h => (h in values) ? values[h] : (existing ? existing[h] : ''));
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
}

function setAdminTierQueue_(rowNumber, tier, queue) {
  suppressAdminsSheetAlert_();
  getAdminsSheet_().getRange(rowNumber, 3, 1, 2).setValues([[tier, queue]]);
}

// /add_admin ADDS. It used to upsert — and because isSystem defaults to false
// when the 4th argument is omitted, re-running it against an existing System
// Admin silently stripped that flag. Aimed at yourself it was self-demotion;
// aimed at the last System Admin it locked everyone out of the bot, with the
// only recovery being a hand edit of the ADMINS sheet. An existing target is
// now refused outright and pointed at /set_role.
function handleAddAdmin_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'admin.manage')) {
    denyAdminAction_(chatId, adminRow, '/add_admin', 'Only a System Admin can run /add_admin.');
    return;
  }
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const targetId = parts[0];
  const tier = parts[1] || ADMIN_TIER.NONE;
  const queue = parts[2] || ADMIN_QUEUE.NONE;
  const isSystem = String(parts[3] || 'false').toLowerCase() === 'true';

  if (!targetId) {
    sendMessage(chatId, 'Usage: /add_admin <telegram_id> [tier] [queue] [true|false] [role] [name]');
    return;
  }
  if (!/^\d+$/.test(String(targetId))) {
    sendMessage(chatId, 'A Telegram ID is all digits. Ask the person to message @userinfobot to find theirs.');
    return;
  }
  if (!isValidTier_(tier) || !isValidQueue_(queue)) {
    sendMessage(chatId, 'Invalid tier/queue. Tiers: ' + Object.values(ADMIN_TIER).join(', ') +
      '. Queues: ' + Object.values(ADMIN_QUEUE).join(', '));
    return;
  }
  if (findAnyAdminRow_(targetId)) {
    sendMessage(chatId, targetId + ' is already an admin.\n\n' +
      'Use /set_role ' + targetId + ' <tier> <queue> to change their tier or queue.\n' +
      'Changing System Admin on an existing row is a deliberate edit in the ADMINS tab — ' +
      'no command does it, so it can never happen by accident.');
    return;
  }

  // The 5th argument is a role only when it is a valid one — otherwise it is
  // the first word of the person's name, so nothing is silently swallowed.
  const role = parts[4] && isValidRole_(parts[4]) ? parts[4] : '';
  const name = parts.slice(role ? 5 : 4).join(' ');
  upsertAdminRow_(targetId, isSystem, tier, queue, chatId, name, role);
  logInteraction(chatId, 'ADMIN_ADDED', targetId + ' tier=' + tier + ' queue=' + queue + ' system=' + isSystem);
  sendMessage(chatId, 'Admin ' + targetId + ' added — tier=' + tier + ', queue=' + queue +
    ', System Admin=' + (isSystem ? 'YES' : 'no') + '.');
}

// Only touches Tier/Queue (per PLAN.md: "System Admin is the only role that
// can change another admin's Tier/Queue") — never IS_SYSTEM_ADMIN, so this
// command can't be used to promote a new System Admin; that stays a sheet
// edit or an explicit /add_admin ... true call.
function handleSetRole_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'admin.manage')) { denyAdminAction_(chatId, adminRow, '/set_role', 'Only a System Admin can run /set_role.'); return; }
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const targetId = parts[0];
  const tier = parts[1];
  const queue = parts[2];
  // Tier and queue are retained rather than dropped — roleForAdmin_ falls back
  // to them for any row whose ROLE is blank, so both models must stay writable
  // until every row has been migrated.
  const role = parts[3];
  if (!targetId || !tier || !queue) { sendMessage(chatId, 'Usage: /set_role <telegram_id> <tier> <queue> [role]'); return; }
  if (!isValidTier_(tier) || !isValidQueue_(queue)) {
    sendMessage(chatId, 'Invalid tier/queue. Tiers: ' + Object.values(ADMIN_TIER).join(', ') + '. Queues: ' + Object.values(ADMIN_QUEUE).join(', '));
    return;
  }
  if (role && !isValidRole_(role)) {
    sendMessage(chatId, 'Invalid role. Roles: ' + Object.values(ADMIN_ROLE).join(', '));
    return;
  }
  // findAnyAdminRow_, not findAdminRow_: a deactivated admin must still be
  // addressable by management commands, or /remove_admin becomes irreversible
  // from inside the bot. Authorization of the CALLER is unaffected — that is
  // routeAdminCommand_'s findAdminRow_ lookup, which correctly excludes them.
  const existing = findAnyAdminRow_(targetId);
  if (!existing) { sendMessage(chatId, 'No admin found with Telegram ID ' + targetId + '. Use /add_admin first.'); return; }
  setAdminTierQueue_(existing._rowNumber, tier, queue);
  if (role) setAdminField_(existing._rowNumber, 'ROLE', role);
  if (!isActiveAdminRow_(existing)) {
    setAdminField_(existing._rowNumber, 'ACTIVE', 'TRUE');
    logInteraction(chatId, 'ADMIN_REACTIVATED', String(targetId));
  }
  logInteraction(chatId, 'ADMIN_ROLE_CHANGED',
    targetId + ' -> tier=' + tier + ' queue=' + queue + (role ? ' role=' + role : ''));
  sendMessage(chatId, 'Updated ' + targetId + ': tier=' + tier + ', queue=' + queue + (role ? ', role=' + role : '') + '.');
  const notice = sendMessage(targetId, 'Your MoPSE Support Bot permissions changed: tier=' + tier + ', queue=' + queue + '.');
  if (!notice.ok) console.error('handleSetRole_: could not notify ' + targetId + ' of their role change.');
}

function handleListAdmins_(chatId, adminRow) {
  if (!can_(adminRow, 'admin.manage')) {
    denyAdminAction_(chatId, adminRow, '/admins', 'Only a System Admin can list admins.');
    return;
  }
  const rows = getAllAdminRows_();
  if (!rows.length) { sendMessage(chatId, 'No admins on file.'); return; }
  const lines = rows.map(r => {
    const flags = [];
    if (isSystemAdminRow_(r)) flags.push('SYSTEM');
    if (!isActiveAdminRow_(r)) flags.push('DEACTIVATED');
    return r.TELEGRAM_ID + (r.NAME ? ' — ' + r.NAME : '') +
      ' — tier=' + (r.TIER || 'None') + ' queue=' + (r.QUEUE || 'None') +
      (flags.length ? ' [' + flags.join(', ') + ']' : '') +
      (r.ADDED_BY ? '\n    added by ' + r.ADDED_BY + (r.ADDED_AT ? ' on ' + r.ADDED_AT : '') : '');
  });
  sendMessage(chatId, 'Admins (' + rows.length + '):\n' + lines.join('\n') +
    '\n\nActive System Admins: ' + countActiveSystemAdmins_());
}

// Deactivates, never deletes. Deleting the row destroys the identity mapping
// that makes every historical MESSAGES row readable — "who was 483920184?"
// becomes unanswerable the moment the row is gone.
function handleRemoveAdmin_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'admin.manage')) {
    denyAdminAction_(chatId, adminRow, '/remove_admin', 'Only a System Admin can run /remove_admin.');
    return;
  }
  const targetId = rest.trim().split(/\s+/)[0];
  if (!targetId) { sendMessage(chatId, 'Usage: /remove_admin <telegram_id>'); return; }
  if (String(targetId) === String(chatId)) {
    sendMessage(chatId, 'You cannot deactivate your own access. Ask another System Admin to do it.');
    return;
  }
  const target = findAnyAdminRow_(targetId);
  if (!target) { sendMessage(chatId, 'No admin found with Telegram ID ' + targetId + '.'); return; }
  if (!isActiveAdminRow_(target)) { sendMessage(chatId, targetId + ' is already deactivated.'); return; }
  if (isSystemAdminRow_(target) && countActiveSystemAdmins_() <= 1) {
    sendMessage(chatId, 'Refusing: ' + targetId + ' is the last active System Admin. ' +
      'Add another System Admin first, or nobody will be able to administer the bot.');
    return;
  }
  setAdminField_(target._rowNumber, 'ACTIVE', 'FALSE');
  logInteraction(chatId, 'ADMIN_DEACTIVATED', String(targetId));
  sendMessage(chatId, 'Admin ' + targetId + ' deactivated. Their history is preserved — ' +
    'use /set_role ' + targetId + ' <tier> <queue> to restore them.');
  const notice = sendMessage(targetId, 'Your MoPSE Support Bot admin access has been deactivated.');
  if (!notice.ok) console.error('handleRemoveAdmin_: could not notify ' + targetId);
}

// ---- Urgent codes ----
//
// Stored in Script Properties, NOT CacheService. Cache entries can be evicted
// well before their stated TTL, which would have silently invalidated a code
// the bot promised was good for 48 hours — with the teacher on the phone to a
// Regional admin trying to use it. Script Properties are durable, so expiry
// is enforced explicitly against a stored timestamp instead.

function urgentCodeKey_(code) {
  return 'URGENT_CODE_' + String(code || '').trim().toUpperCase();
}

function handleGenerateUrgentCode_(chatId, adminRow) {
  if (!can_(adminRow, 'urgent.issue')) {
    denyAdminAction_(chatId, adminRow, '/generate_urgent_code', 'Your role cannot issue urgent codes — Agent role or above is required.');
    return;
  }
  const code = Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
  PropertiesService.getScriptProperties().setProperty(urgentCodeKey_(code), JSON.stringify({
    issuedBy: String(chatId),
    expiresAt: Date.now() + URGENT_CODE_TTL_SECONDS * 1000
  }));
  logInteraction(chatId, 'URGENT_CODE_GENERATED', code);
  sendMessage(chatId, 'Urgent code: ' + code + '. Give this to the teacher by phone or in person — it is single-use and expires in 48 hours.');
}

/**
 * Consumed by MenuHandler.gs's Urgent Case flow (the menu button this
 * command backs — PLAN.md Phase 3: "Re-add Urgent Case now that
 * /generate_urgent_code exists"). Single-use: deleted the moment it's
 * checked, valid or not, so a leaked or guessed code can't be replayed.
 */
function consumeUrgentCode_(code) {
  const key = urgentCodeKey_(code);
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(key);
  if (!raw) return false;
  props.deleteProperty(key);
  try {
    const record = JSON.parse(raw);
    return !!record.expiresAt && Date.now() <= record.expiresAt;
  } catch (err) {
    console.error('consumeUrgentCode_: unreadable record for ' + key + ': ' + err);
    return false;
  }
}

/** Housekeeping for codes that were issued but never used — otherwise they
 * accumulate in Script Properties forever. Called from Triggers.gs's
 * time-driven archive run. */
function sweepExpiredUrgentCodes_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(key => {
    if (key.indexOf('URGENT_CODE_') !== 0) return;
    try {
      const record = JSON.parse(all[key]);
      if (!record.expiresAt || now > record.expiresAt) props.deleteProperty(key);
    } catch (err) {
      props.deleteProperty(key); // unparseable: it can never be honoured anyway
    }
  });
}

// ---- Settings + maintenance mode (Phase 6) ----

const SETTINGS_KEY_MAINTENANCE_MODE_ = 'MAINTENANCE_MODE';

function getSettingsSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.SETTINGS);
  if (!sheet) throw new Error('SETTINGS sheet not found — run SetupSheets.createAllSheets() first');
  return sheet;
}

function readSettingsMap_() {
  const values = getSettingsSheet_().getDataRange().getValues();
  if (values.length < 2) return {};
  const headers = values.shift();
  const keyCol = headers.indexOf('KEY');
  const valCol = headers.indexOf('VALUE');
  const map = {};
  values.forEach(r => {
    const k = String(r[keyCol] || '').trim();
    // First row wins, matching the previous find()-based behaviour if a
    // duplicate KEY ever slips in by hand.
    if (k && !(k in map)) map[k] = r[valCol];
  });
  return map;
}

/**
 * Read one SETTINGS value. Cached briefly because startCaseFeature_ calls
 * isMaintenanceMode_() on every case-feature tap, and that previously meant
 * reading the whole SETTINGS sheet each time.
 */
function getSettingValue_(key) {
  let map = null;
  try {
    const cached = CacheService.getScriptCache().get(SETTINGS_CACHE_KEY_);
    if (cached) map = JSON.parse(cached);
  } catch (err) {
    console.error('getSettingValue_ cache read failed: ' + err);
  }
  if (!map) {
    map = readSettingsMap_();
    try {
      CacheService.getScriptCache().put(SETTINGS_CACHE_KEY_, JSON.stringify(map), SETTINGS_CACHE_TTL_SECONDS_);
    } catch (err) {
      console.error('getSettingValue_ cache write failed (harmless): ' + err);
    }
  }
  return key in map ? map[key] : null;
}

function invalidateSettingsCache_() {
  try {
    CacheService.getScriptCache().remove(SETTINGS_CACHE_KEY_);
  } catch (err) {
    console.error('invalidateSettingsCache_ failed: ' + err);
  }
}

// Read-then-write (scan for an existing KEY row, update it or append a new
// one) — lock-protected per PLAN.md's Concurrency rule, same reasoning as
// CaseManager.gs's updateCaseFields_: without it, two near-simultaneous
// writes (a double-tap, or two System Admins) could both miss each other's
// row and each append a duplicate KEY row, after which reads would only ever
// see the first one (Oracle review, Phase 6).
function setSettingValue_(key, value, notes) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('setSettingValue_: could not acquire lock for ' + key);
  }
  try {
    const sheet = getSettingsSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const keyCol = headers.indexOf('KEY');
    for (let i = 1; i < values.length; i++) {
      if (values[i][keyCol] === key) {
        sheet.getRange(i + 1, headers.indexOf('VALUE') + 1).setValue(value);
        if (notes !== undefined) sheet.getRange(i + 1, headers.indexOf('NOTES') + 1).setValue(notes);
        return;
      }
    }
    sheet.appendRow([key, value, notes || '']);
  } finally {
    lock.releaseLock();
    invalidateSettingsCache_();
  }
}

// Read by MenuHandler.gs's startCaseFeature_ to gate Contact Support/Urgent
// Case/Submit Documents. Defaults to OFF (no SETTINGS row yet = not paused).
function isMaintenanceMode_() {
  return String(getSettingValue_(SETTINGS_KEY_MAINTENANCE_MODE_)).toUpperCase() === 'TRUE';
}

// System-Admin-gated, same as /add_admin and /set_role — pausing submissions
// system-wide is an operational control, not a per-queue action, so it is its
// own 'maintenance' capability rather than piggybacking on /announce's or
// /export's.
function handleMaintenance_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'maintenance')) { denyAdminAction_(chatId, adminRow, '/maintenance', 'Only a System Admin can run /maintenance.'); return; }
  const arg = rest.trim().toLowerCase();
  if (arg === 'on') {
    setSettingValue_(SETTINGS_KEY_MAINTENANCE_MODE_, 'TRUE', 'Set via /maintenance by ' + chatId);
    logInteraction(chatId, 'MAINTENANCE_ENABLED', '');
    sendMessage(chatId, 'Maintenance mode is ON.\n\n' +
      'Paused: new Contact Support, Urgent Case and Submit Documents submissions.\n' +
      'Still live: FAQ browsing and Check My Case.\n\n' +
      'Teachers already part-way through describing a case can still finish it — ' +
      'in-flight submissions are not blocked, so a spent urgent code is not wasted. ' +
      'Expect a small number of cases to keep arriving for a few hours.');
  } else if (arg === 'off') {
    setSettingValue_(SETTINGS_KEY_MAINTENANCE_MODE_, 'FALSE', 'Set via /maintenance by ' + chatId);
    logInteraction(chatId, 'MAINTENANCE_DISABLED', '');
    sendMessage(chatId, 'Maintenance mode is OFF.');
  } else {
    sendMessage(chatId, 'Usage: /maintenance on|off. Currently ' + (isMaintenanceMode_() ? 'ON' : 'OFF') + '.');
  }
}
