/** A request the safety policy refuses. The message is written for the caller and reaches it unchanged. */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

const TAIL =
  "This server's configuration blocks it, not Home Assistant. Nothing was sent to change anything. " +
  "The policy is described in the README, under Safety policy.";

/** Builds the refusal text: which rule applied, what was refused, and that nothing was sent. */
export function refusal(rule: string, what: string): PolicyRefusal {
  return new PolicyRefusal(`Refused by this server's safety policy (${rule}): ${what} ${TAIL}`);
}

/** A check that could not run (Home Assistant or the WebSocket failed). Nothing was sent to change anything. */
export function checkFailed(cause: string): PolicyRefusal {
  return new PolicyRefusal(
    "Refused by this server's safety policy: the check of what this request would run could not be completed, " +
      `so it was not sent. Cause: ${cause} Nothing was sent to change anything and nothing was retried. ` +
      "The policy is described in the README, under Safety policy.",
  );
}
