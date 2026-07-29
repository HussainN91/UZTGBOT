/**
 * The group gate — D15, and the exemption that is R8.
 *
 * A pure test, because the rule is a pure function. That is the whole reason it
 * is one: the alternative is asserting against a grammY instance holding a real
 * token, which would test the wiring and not the decision, and the decision is
 * where getting it wrong takes every alarm in the system down with it.
 */
import { describe, expect, it } from 'vitest';
import { verdictForChat } from './chat-gate.js';

const OPS = '-1001234567890';

describe('which chats the bot will work in', () => {
  it('handles a private chat', () => {
    expect(verdictForChat('private', '995101', OPS)).toBe('handle');
  });

  it('leaves a group', () => {
    // BOT-SPEC §1: not a group-chat bot. Restored here — it existed in
    // Webhook.gs:57-69 and did not exist anywhere in src/.
    expect(verdictForChat('group', '-400400', OPS)).toBe('leave');
  });

  it('leaves a supergroup and a channel too', () => {
    // A group that is upgraded to a supergroup changes type and changes id. Both
    // must be covered, or the gate is switched off by an administrator tapping a
    // setting nobody told them about.
    expect(verdictForChat('supergroup', '-1009999999999', OPS)).toBe('leave');
    expect(verdictForChat('channel', '-1008888888888', OPS)).toBe('leave');
  });

  it('never leaves the operations chat', () => {
    // R8. The ops chat is a group and CONCERNS A7 instructs IT to add the bot to
    // it. A naive "leave every group" makes the bot leave the channel every
    // alarm in this system depends on — including the alarm that would report
    // it.
    expect(verdictForChat('supergroup', OPS, OPS)).toBe('ignore');
  });

  it('still refuses to hold a conversation in the operations chat', () => {
    // Exempt from leaving is not the same as exempt from the gate. A message
    // typed in that group carries a negative chat id, which fails
    // conversation_states' digits check inside a transaction that rolls back
    // silently — so the bot must read it and do nothing, not treat it as a
    // teacher.
    expect(verdictForChat('supergroup', OPS, OPS)).not.toBe('handle');
  });

  it('does not exempt a group that merely looks like the operations chat', () => {
    // Compared as strings on purpose. A -100… supergroup id is past the range
    // where number identity is comfortable, and two ids differing in their last
    // digit must never compare equal.
    expect(verdictForChat('supergroup', '-1001234567891', OPS)).toBe('leave');
  });

  it('exempts nothing when no operations chat is configured', () => {
    // OPS_ALERT_CHAT_ID is optional outside production. Treating "unset" as
    // "exempt everything" would switch the gate off entirely in exactly the
    // environment where nobody is watching.
    expect(verdictForChat('group', '-400400', undefined)).toBe('leave');
    expect(verdictForChat('private', '995101', undefined)).toBe('handle');
  });
});
