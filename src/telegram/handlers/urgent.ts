/**
 * What the bot says when a teacher asks for a case to be treated as a priority.
 *
 * **The word "urgent" here means high priority, not emergency.** That is a
 * correction rather than a nuance, and it is the reason every message in this
 * file was rewritten on 1 August 2026. The previous set told teachers to
 * "describe the emergency", promised nothing about who was coming, and ended
 * every path with a telephone number to ring if things got worse — the voice of
 * a crisis line. The feature is a queue-jumping request: a teacher whose visa
 * appointment is on Tuesday needs their case looked at before the fifty filed
 * ahead of it, and asking them to frame that as an emergency is asking the wrong
 * question. Nothing here names emergency services, because nothing here is one.
 *
 * The rules that survived the rewrite, because they were about something else:
 *
 *   **Nothing promises a person is coming.** The bot files a case and asks a
 *   coordinator to look; it cannot make anybody answer, and a teacher told help
 *   is on its way will wait instead of chasing.
 *
 *   **Every path names the support contact.** It is the route that works when
 *   the bot is the problem.
 *
 * The one-time code messages are gone entirely, along with the code. There is
 * nothing left to reject, lock out, or accept.
 */
import { backToMenuKeyboard } from '../keyboards.js';
import type { Reply } from '../reply.js';

/**
 * Ask for the problem. Nothing stands in front of this.
 *
 * It says plainly that a person decides, and it says so *before* they write
 * rather than afterwards. A teacher who believes tapping this button is itself
 * the escalation writes two lines; one who knows a coordinator will read it and
 * judge writes the thing that lets them judge.
 */
export function urgentDetailPromptReply(): Reply {
  return {
    text:
      '⏫ Ask for priority\n\n' +
      'Describe the problem in one message — what has happened, what you need, and ' +
      'why it cannot wait its turn. Include a date if something is fixed, like an ' +
      'appointment or a flight.\n\n' +
      'A regional coordinator reads it and decides whether it moves ahead of the ' +
      'other open cases.',
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * Filed, and waiting on somebody's judgement.
 *
 * Three things, in this order: it exists, here is the number, a person decides.
 * The last is not softening — a teacher who is told "marked urgent" and then
 * finds their case sitting at normal priority has been misled by us, and the
 * request is refused far more often than it is granted by design.
 */
export function urgentRequestedReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '✅ Your case has been opened, and your request for priority has been passed on.\n\n' +
      `Reference: ${reference}\n\n` +
      'A regional coordinator will look at it and decide whether it moves ahead of ' +
      'the other open cases. Until they do, it is being worked in the ordinary way — ' +
      'it has not been forgotten and you do not need to send it again.\n\n' +
      'Keep this reference. Use Check My Case to see progress.\n\n' +
      `If you cannot reach anybody and it cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * They already had an open case, so this was added to it.
 *
 * Said plainly, and the reference is the *existing* one. A teacher told "opened"
 * twice believes there are two cases and chases both; a teacher told nothing
 * believes their message vanished. The Apps Script version did the second.
 */
export function urgentAppendedReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '✅ Added to the case you already have, and your request for priority has been ' +
      'passed on.\n\n' +
      `Reference: ${reference}\n\n` +
      'You already had an open case, so rather than opening a second one, what you ' +
      'have just written has been added to it. A regional coordinator will decide ' +
      'whether it moves ahead of the other open cases.\n\n' +
      `If you cannot reach anybody and it cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * It is already a priority case, and nobody is asked a second time.
 *
 * Their words are still added — new information about a live problem is worth
 * having — but re-notifying a coordinator who has already decided is how the
 * confirm button becomes something people stop reading.
 */
export function urgentAlreadyReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '✅ This case is already being treated as a priority.\n\n' +
      `Reference: ${reference}\n\n` +
      'What you have just written has been added to it. Nobody needs to be asked ' +
      'again — it is already ahead of the ordinary queue.\n\n' +
      `If you cannot reach anybody and it cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * They asked before, and nobody has decided yet.
 *
 * The honest sentence, and the one the bot has never been able to say. It costs
 * nothing and it stops a teacher tapping the button four more times believing
 * the first three went nowhere.
 */
export function urgentStillPendingReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '✅ Added to your case. Your earlier request for priority is still with a ' +
      'regional coordinator.\n\n' +
      `Reference: ${reference}\n\n` +
      'Nobody has decided yet. Asking again does not move it along, and what you ' +
      'have just written has been added to the case either way.\n\n' +
      `If you cannot reach anybody and it cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/** The coordinator agreed. Sent when they tap, which may be hours later. */
export function urgentGrantedReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '⏫ Your case has been marked urgent.\n\n' +
      `Reference: ${reference}\n\n` +
      'A regional coordinator agreed it should come ahead of the other open cases. ' +
      'It is now with the support team as a priority.\n\n' +
      `If anything changes, use Check My Case, or contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/** Asking for priority opens a case, so maintenance mode stops it. */
export function urgentUnavailableReply(supportContact: string): Reply {
  return {
    text:
      'New cases are paused while the support team deals with something.\n\n' +
      'The FAQ and Check My Case still work. ' +
      `If this cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}
