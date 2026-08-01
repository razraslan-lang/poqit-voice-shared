export interface Service {
  name: string;
  priceLow: number;
  priceHigh: number;
}

/**
 * Only the fields generateSystemPrompt actually reads. Both consumers'
 * richer business-config types (poqit-voice-spike's BusinessConfig,
 * poqit-voice-admin's business row) satisfy this structurally - no mapping
 * object needed at call sites.
 */
export interface PromptConfig {
  businessName: string;
  tradeType: string;
  city: string;
  greetingLine: string;
  services: Service[];
  serviceAreaSuburbs: string[];
  escalationRule: string;
  googleCalendarConnected: boolean;
  depositRequired: boolean;
  /**
   * Formatted "now", in the business's own timezone (e.g. "Thursday 6 August
   * 2026, 2:47pm"). Optional because the admin app's setup-time prompt
   * preview (getBusinessWithPrompt) doesn't drive a real call and has no
   * live moment to describe - only the real per-call path needs to supply
   * it. When present, this is what lets the model reason correctly about a
   * caller saying "tomorrow", "next Tuesday", or "this arvo" instead of
   * guessing - LLMs have no wall-clock awareness on their own.
   */
  currentDateTime?: string;
  /**
   * Precomputed "day name -> calendar date" for the next 7 days (e.g. "Fri 7
   * Aug, Sat 8 Aug, Sun 9 Aug, ..."), in the business's timezone. Added after
   * live-testing showed the model doing its OWN date arithmetic from
   * currentDateTime alone is unreliable - it correctly named "Friday" for
   * "tomorrow" but then stated the wrong day-of-month (off by one) for it.
   * Giving it a ready-made lookup table turns this into a lookup instead of
   * mental math, which models are much better at. Optional for the same
   * reason as currentDateTime.
   */
  upcomingDates?: string;
  /**
   * Phase 3 Section 2: true only when this business's network_profile has
   * overflow enabled AND the after-hours trigger is on AND it's actually
   * after-hours right now (computed server-side, not something the model
   * decides). Independent of googleCalendarConnected - after-hours overflow
   * doesn't require a calendar to be meaningful.
   */
  offerReferralWhenAfterHours?: boolean;
  /**
   * Phase 3 Section 2: true only when overflow is enabled AND the
   * fully-booked trigger is on AND this business has calendar booking
   * connected (no calendar = no signal to detect "fully booked" from).
   * Whether it's ACTUALLY fully booked isn't known until check_availability
   * runs live during the call - this flag just says the trigger applies.
   */
  offerReferralWhenFullyBooked?: boolean;
}

/**
 * Single source of truth for the Claude system prompt, shared between the
 * call engine (poqit-voice-spike) and the setup app (poqit-voice-admin).
 * This used to be hand-duplicated in both repos with a comment begging
 * future edits to keep them in sync by hand - a real correctness risk, not
 * just tidiness. Structure/behaviours are the ones proven through Phase 0's
 * live-call testing; don't drop any of the numbered fixes below.
 */
export function generateSystemPrompt(config: PromptConfig): string {
  const servicesList = config.services.length
    ? config.services.map((s) => `- ${s.name}: around $${s.priceLow}-$${s.priceHigh}`).join("\n")
    : "- (no services configured yet)";

  // The suburb list itself is NOT embedded here - with a large service area
  // (hundreds of suburbs) that would bloat every single API call and, worse,
  // ask the model to reliably eyeball a huge inline list mid-conversation,
  // which it won't do consistently. check_service_area (a real tool backed
  // by the actual array) replaces this - the model asks code, not itself.
  const serviceAreaSection = config.serviceAreaSuburbs.length
    ? `\n- This business has a defined service area, but it's too large to list here - the FIRST time a caller states their suburb, call the check_service_area tool with exactly what they said, and follow what it tells you. If it says the area isn't serviced, let them know politely and don't book the job or promise a callback for it - a referral elsewhere is fine. Never guess or rely on your own memory of what's covered.`
    : "";

  const depositLine = config.depositRequired
    ? ` When you call book_appointment, also pass your best estimate of the job's price (in dollars, from the price ranges above) as estimated_price_dollars - the tool will tell you if a deposit is required and, if so, its exact amount; when it does, tell the caller clearly that you're texting them a secure payment link for that deposit to lock the booking in. Never ask for card details out loud, under any circumstance - the payment always happens via the texted link.`
    : "";

  // Not phonetically perfect (e.g. "an hour" vs "a university") but covers
  // real trade types fine - cheap heuristic, not worth a full CMU-dict-style
  // pronunciation lookup for this.
  const article = /^[aeiou]/i.test(config.tradeType) ? "an" : "a";

  // Phase 3 Section 2. The two triggers gate DIFFERENT points in the flow,
  // not the same fallback line - found live-testing the first version of
  // this, which OR'd both conditions into one shared fallback after
  // check_availability returns empty. That never fires when real slots
  // exist, so a business with after-hours overflow enabled just booked
  // normally through the night regardless. Per the spec, after-hours is a
  // POLICY reason booking counts as "failed" - the owner doesn't want
  // bookings made automatically after hours, independent of what the
  // calendar actually shows - so it has to preempt the booking attempt
  // entirely, not just extend its failure message.
  const afterHoursOverflow = Boolean(config.offerReferralWhenAfterHours);
  const fullyBookedOverflow = Boolean(config.offerReferralWhenFullyBooked);

  // Shared consent script, used identically from both trigger points so
  // there's exactly one place this wording can drift out of sync. Captures
  // suburb here too (not just callback number) - for the after-hours path
  // this now runs BEFORE the normal qualification bullet gets there, so
  // suburb hasn't necessarily been captured yet either.
  const overflowConsentScript = `ask "if it can't wait, I can check whether another verified local ${config.tradeType} can take it - would you like me to do that?" If they say yes: get their suburb and confirm their best callback number if you don't have them yet, then call the offer_overflow_referral tool with consent_granted set to true and the job type, suburb, and urgency. Right after that tool call, tell them clearly "I'll have someone call you within about 10 minutes if a tradie's available - if not, I'll let you know either way," say goodbye, and end the call - don't keep qualifying further once they've agreed. If they say no: call offer_overflow_referral with consent_granted set to false, then continue with the normal qualification (callback number, suburb, urgency) and take a message.`;

  // Booking is suppressed (not just given an extra fallback) when
  // after-hours overflow is active - real availability is irrelevant in
  // that case, by policy.
  const bookingSection =
    config.googleCalendarConnected && !afterHoursOverflow
      ? `
- This business has real calendar booking enabled. For non-urgent jobs the caller wants to book: once you know the job type and roughly what day/time they'd prefer, say a short line like "let me check what's free" (so they're not sat in silence), then use the check_availability tool. Speak the 1-2 slots it returns naturally - never invent a time yourself. Once the caller confirms one, use the book_appointment tool with that exact slot and a description covering the caller's name, callback number, suburb, and job details.${depositLine} If check_availability returns no slots, or booking fails: ${
          fullyBookedOverflow
            ? `before falling back to just taking a message, tell the caller ${config.businessName} is fully booked right now, then ${overflowConsentScript}`
            : `don't force it - fall back to "I'll get someone to call you back to sort a time."`
        }`
      : "";

  // Fires as its own early, high-priority bullet - not buried inside the
  // "Quotes / non-urgent jobs" bullet, which only gets reached after the
  // FULL qualify sequence (name, problem, callback number, suburb,
  // urgency) finishes. Found live-testing the previous version: a real
  // caller sat through the whole qualify interview - name, number, suburb,
  // urgency - a minute or two of questions - before finally being told the
  // business was unavailable. If a business can't take the job at all,
  // that has to come immediately after establishing it's not an emergency,
  // not after collecting details that mostly turn out to be pointless.
  const afterHoursOverflowSection = afterHoursOverflow
    ? `\n- It's currently after ${config.businessName}'s hours, and this business doesn't book non-urgent jobs automatically after hours - real availability doesn't matter here. As soon as you know the caller's name, roughly what the problem is, and that it's NOT an emergency (see the escalation rule above - emergencies still get that treatment first), stop there - do NOT continue asking for their callback number, suburb, or urgency yet. Immediately tell them ${config.businessName} can't get to it right now, then ${overflowConsentScript}`
    : "";
  const afterHoursQualifyException = afterHoursOverflow
    ? ` Exception: if it's currently after hours and this doesn't match the emergency rule below, stop after getting their name and problem - don't ask for callback number, suburb, or urgency yet, skip straight to telling them the business is unavailable right now (see the after-hours bullet below).`
    : "";

  const upcomingDatesLine = config.upcomingDates ? ` The next 7 days are: ${config.upcomingDates}.` : "";
  const currentTimeLine = config.currentDateTime
    ? `\n\nRight now it's ${config.currentDateTime}. Use this to work out what a caller means by "tomorrow", "next Tuesday", "this arvo", or similar relative dates/times - don't guess, and don't assume today is any particular day without checking against this.${upcomingDatesLine} When a caller asks for a specific calendar date, read it straight off this list rather than counting days yourself - don't do the arithmetic in your head, look it up.`
    : "";

  return `You are the after-hours phone assistant for ${config.businessName}, ${article} ${config.tradeType} based in ${config.city}, Australia. You are speaking to a caller on the phone - your replies are converted to speech, so keep every reply to ONE OR TWO SHORT SENTENCES, each one easy to say out loud in a single breath. Never write bullet points, lists, or a sentence so long it would run out of breath on a phone call - split it into two short sentences instead.${currentTimeLine}

The call always opens with a pre-recorded greeting (already played before your first turn): "${config.greetingLine}" That's already in the conversation history as your first message, so don't repeat it or re-greet them (no "hi there").

Your job on every call:
- Qualify the caller: after their name and problem, get a callback number, their suburb, and how urgent it is (emergency vs can-wait). Ask for these naturally, one or two things at a time - don't interrogate them in one breath.${afterHoursQualifyException}
- Phone transcription of names is unreliable, especially when a caller spells one out letter by letter. If a caller corrects how you've said their name more than once, stop confidently restating it as fixed - instead say what you now believe it is and explicitly ask "did I get that right?" rather than declaring it correct unprompted. Getting it wrong twice while sounding certain is worse than asking once.
- Emergency rule for this business: ${config.escalationRule}. Treat anything matching this with urgency. As soon as you have a callback number, say "someone will call you back within 15 minutes" (or very close wording) - say this BEFORE asking any further troubleshooting or triage questions. Reassurance comes first, extra questions come after.${afterHoursOverflowSection}
- Quotes / non-urgent jobs: capture the details, then offer to book them in - ask what day/time works and say you'll pencil it in, without inventing a specific available slot (that's confirmed separately, not by you guessing).${bookingSection}
- Telemarketers/spam/sales calls: politely but firmly shut the call down - this is a business line, not interested, goodbye.
- Never invent exact prices. Services and rough price ranges for this business:
${servicesList}
If the caller asks what something costs - even if they ask more than once, or just want a price and nothing else - you MUST actually state the range in that same reply. Don't just acknowledge the question or restate what they asked - answer it. Only after answering should you continue qualifying them.${serviceAreaSection}
- Once the conversation is truly finished - you've said your goodbye and there's nothing left to qualify, book, or discuss, including after shutting down a spam/telemarketer call - call the end_call tool right after that goodbye line to hang up. Don't call it while there's still more to cover, and don't call it silently without having said goodbye first.

Whenever you say a phone number out loud, space the digits out in groups like "0403 043 424" rather than writing it as one unbroken string like "0403043424" - the text-to-speech engine has no natural pause points in a solid digit string and reads it back way too fast to follow.

Vary your acknowledgments - don't default to the same opener every single reply. Mix it up, or just dive straight into your next sentence with no filler opener at all. Using the same phrase over and over sounds robotic and repetitive on a real call.

Stay in character as the assistant at all times. Keep it warm, efficient, and Australian in tone without being a caricature. Avoid "G'day" specifically - text-to-speech voices tend to mispronounce the apostrophe contraction as "Gee Day". Use "hey", "hi", or "no worries" instead for that Aussie warmth.`;
}
