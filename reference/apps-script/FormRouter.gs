/**
 * FormRouter.gs — Phase 4: formalizes the doc-type -> Google Form URL
 * mapping MenuHandler.gs has used since Phase 1 (a private DOC_TYPES_ array
 * reading Config.gs's FORM_URLS directly). MenuHandler.gs's Submit Documents
 * flow now calls into this file instead, so there is one place that owns
 * the doc-type -> URL mapping (DEPENDENCY_TREE.md finding #5) rather than
 * two files duplicating it. Config.gs's FORM_URLS is now this file's
 * private data, not a contract other files reach into.
 */

const DOC_TYPE_DEFS_ = [
  { key: 'VISA', label: 'Visa documents' },
  { key: 'CONTRACT', label: 'Signed contract' },
  { key: 'PASSPORT', label: 'Passport copy' },
  { key: 'TICKET', label: 'Travel ticket' },
  { key: 'REIMBURSEMENT', label: 'Reimbursement request' },
  { key: 'CERTIFICATE', label: 'Certificate' },
  { key: 'CORRECTION', label: 'Correction request' }
];

// Config.gs ships seven placeholder URLs until real Google Forms exist (see
// RUNBOOK.md §6.3). They are truthy, so without this check the bot handed a
// teacher a dead forms.gle link after making them verify their identity to
// get it. A doc type is "real" only once its URL stops being a placeholder.
const FORM_URL_PLACEHOLDER_MARKER_ = 'PLACEHOLDER_';

function isRealFormUrl_(url) {
  return !!url && String(url).indexOf(FORM_URL_PLACEHOLDER_MARKER_) === -1;
}

/** Doc types with a real form behind them. Empty until MoPSE creates the forms. */
function realDocTypeList_() {
  return DOC_TYPE_DEFS_.filter(d =>
    Object.prototype.hasOwnProperty.call(FORM_URLS, d.key) && isRealFormUrl_(FORM_URLS[d.key]));
}

/** True when at least one doc type is submittable — gates the whole feature. */
function documentSubmissionEnabled_() {
  return realDocTypeList_().length > 0;
}

function docTypeList_() {
  return realDocTypeList_();
}

/**
 * Design decision, settled now because this file owns the doc-type
 * vocabulary Phase 5's onFormSubmit will need (carried over from
 * DEPENDENCY_TREE.md's earlier "Triggers.gs's exact case-matching key for
 * onFormSubmit is undecided" flag): Apps Script's onFormSubmit event only
 * hands the trigger the form response values themselves — there is no
 * Telegram identity attached to a Form submission. The chosen mechanism is
 * a pre-filled field: once a real Google Form exists for a doc type, its
 * "Telegram Chat ID" short-answer field's entry ID goes into
 * FORM_CHAT_ID_ENTRY_IDS_ below, and formUrlForDocType_ starts appending
 * `&entry.<id>=<chatId>` to the link automatically — no other code changes
 * needed when that day comes, and Phase 5's onFormSubmit can then read that
 * field straight off the form response to resolve the submitting chat_id.
 * NOTE: Google Forms has no hidden-field support — the prefilled value is a
 * normal, visible, EDITABLE question. A teacher can see and change it before
 * submitting (or a forwarded link could get filled in by someone else
 * entirely), so onFormSubmit must not treat a resolved chat_id as trustworthy
 * without a fallback for a missing/edited/mismatched value (see PLAN.md
 * Phase 5). Left empty for every key today because FORM_URLS itself is still
 * placeholders (see PLAN.md "Open items") — there's no real form to get an
 * entry ID from yet.
 */
const FORM_CHAT_ID_ENTRY_IDS_ = {
  // VISA: 'entry.123456789'  — filled in once the real Visa doc form exists
};

/**
 * `key` arrives straight off a 'DOC:<key>' callback, which anyone can hand-craft.
 * A bare FORM_URLS[key] lookup resolves inherited Object.prototype members, so
 * 'DOC:constructor' returned a truthy function instead of undefined and the
 * `base.indexOf` below threw — swallowed by doPost, leaving the tap doing
 * nothing at all. hasOwnProperty confines both lookups to real entries.
 */
function formUrlForDocType_(chatId, key) {
  if (!Object.prototype.hasOwnProperty.call(FORM_URLS, key)) return null;
  const base = FORM_URLS[key];
  if (!isRealFormUrl_(base)) return null;
  const entryId = Object.prototype.hasOwnProperty.call(FORM_CHAT_ID_ENTRY_IDS_, key)
    ? FORM_CHAT_ID_ENTRY_IDS_[key]
    : null;
  if (!entryId) return base;
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + entryId + '=' + encodeURIComponent(chatId);
}

/**
 * Sent once Phase 5's onFormSubmit trigger detects a matching form response.
 * Not called by anything yet — PLAN.md lists this as an explicit Phase 4
 * deliverable ("Confirmation message stub — sent once a form-submit trigger
 * fires (wired in Phase 5)"), and FormRouter.gs is the file that owns the
 * doc-type vocabulary this message speaks in.
 */
function sendFormSubmissionConfirmation_(chatId, docKey) {
  const def = DOC_TYPE_DEFS_.find(d => d.key === docKey);
  const label = def ? def.label.toLowerCase() : 'document';
  sendMessage(chatId, 'Thanks — we received your ' + label + ' submission. We will follow up here if anything further is needed.');
}
