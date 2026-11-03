/**
 * The sentences an operator reads before real money can move.
 *
 * ONE MODULE, BECAUSE THESE ARE THE WORDS AND NOT DECORATION AROUND THEM.
 *
 * The Strategies page arms a strategy, the Books page starts a book, and both
 * ask the same question: what becomes possible if you confirm, and for how
 * long. Each page had written its own answer, and the Books copy carried a
 * comment admitting it followed "the same rule" as the other by hand — which is
 * a promise nothing enforces. A confirmation prompt that has quietly drifted is
 * worse than no prompt: the operator learns to skim a dialog whose wording no
 * longer describes what the button does.
 *
 * Every statement here names the tag or the scope, states the rail as LIVE, and
 * says what keeps happening afterwards. That last clause is the one that gets
 * dropped when these are rewritten from memory, and it is the one that matters
 * — these switches do not fire once, they stay armed.
 */

/**
 * States exactly what becomes possible, in one sentence, with the tag in it.
 * "Confirm this action" is something you click through; this is not.
 */
export function liveStatement(tag: string): string {
  return `Orders from ${tag} will route to the LIVE broker account and move real money. ` +
    'They keep routing until you switch this row off again.'
}

/**
 * What changing the DAY GUARD on a live row means.
 *
 * Deliberately not `liveStatement`: nothing is being armed here, so a sentence
 * about orders beginning to route would be describing something that is not
 * happening — and a prompt whose words do not match the button is how an
 * operator learns to skim the one that does. What IS happening is that the
 * outermost control on a strategy already moving real money is being changed,
 * and that is the sentence.
 */
export function dayGuardStatement(tag: string): string {
  return `${tag} is trading on the LIVE broker account right now. You are changing the daily ` +
    'target and stop-loss that switch it off — clearing or widening them leaves it running ' +
    'with no daily limit at all until you set one again.'
}

export const BULK_LIVE_STATEMENT =
  'EVERY strategy added to LIVE will be switched on at once. Each one that signals ' +
  'will route to the live broker account and move real money, and they keep routing ' +
  'until you switch them off again.'

/**
 * What starting THIS book in live means, stated plainly with the tag in it.
 *
 * A book is not a strategy row: confirming it hands a supervisor the authority
 * to decide on its own from the next poll, so the sentence says that rather
 * than talking about orders someone is about to place.
 */
export function liveStartStatement(tag: string): string {
  return `${tag} will begin making its own decisions against the LIVE broker account and can ` +
    'route real orders from its next poll. It keeps running until you stop it again.'
}
