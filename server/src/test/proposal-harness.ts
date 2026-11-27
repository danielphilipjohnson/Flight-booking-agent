import assert from "node:assert/strict";
import { matchProposal, PROPOSAL_TTL_MS, type PendingProposal } from "../tools/proposal.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const now = new Date("2026-11-21T12:00:00.000Z");
const proposal: PendingProposal = {
  id: "prop-1",
  tool: "hold_seat",
  args: { flight_id: "f1", seat_no: "12A" },
  created_at: new Date(now.getTime() - 60_000),
};

console.log("\n# matchProposal (issue #8: confirm by id, args must match the server-side proposal)");
ok(matchProposal(proposal, { tool: "hold_seat", confirmationId: "prop-1", args: proposal.args }, now).ok, "happy path: matching id + tool + args");
ok(matchProposal(proposal, { tool: "hold_seat", args: proposal.args }, now).ok, "args-only still works when they match the stored proposal");
const wrongId = matchProposal(proposal, { tool: "hold_seat", confirmationId: "prop-2", args: proposal.args }, now);
ok(!wrongId.ok && wrongId.error!.includes("does not match"), "wrong confirmation id rejected");
const wrongTool = matchProposal(proposal, { tool: "cancel_booking", confirmationId: "prop-1", args: proposal.args }, now);
ok(!wrongTool.ok && wrongTool.error!.includes("mismatch"), "tool mismatch between URL and proposal rejected");
const wrongArgs = matchProposal(proposal, { tool: "hold_seat", confirmationId: "prop-1", args: { flight_id: "f1", seat_no: "1A" } }, now);
ok(!wrongArgs.ok && wrongArgs.error!.includes("args do not match"), "tampered args rejected even with a valid id");
const expired = matchProposal(
  { ...proposal, created_at: new Date(now.getTime() - PROPOSAL_TTL_MS - 1000) },
  { tool: "hold_seat", confirmationId: "prop-1", args: proposal.args },
  now,
);
ok(!expired.ok && expired.expired === true, "proposals expire after the TTL (10 min)");
const none = matchProposal(undefined, { tool: "hold_seat", confirmationId: "prop-1" }, now);
ok(!none.ok && none.error!.includes("no pending proposal"), "no stored proposal -> rejected (client cannot drive writes directly)");

console.log(`\n${passed} assertions passed`);
