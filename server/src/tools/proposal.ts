export interface PendingProposal {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  created_at: Date;
}

export const PROPOSAL_TTL_MS = 10 * 60_000;

export type ProposalMatch =
  | { ok: true }
  | { ok: false; error: string; expired?: boolean };

export function matchProposal(
  proposal: PendingProposal | null | undefined,
  opts: { tool: string; confirmationId?: string; args?: unknown },
  now = new Date(),
): ProposalMatch {
  if (!proposal) {
    return { ok: false, error: "no pending proposal for this session — the agent must propose the write first" };
  }
  const age = now.getTime() - new Date(proposal.created_at).getTime();
  if (age > PROPOSAL_TTL_MS) {
    return { ok: false, error: "proposal expired (10 min) — ask the agent again", expired: true };
  }
  if (opts.tool !== proposal.tool) {
    return { ok: false, error: `tool mismatch: endpoint ${opts.tool} but pending proposal is ${proposal.tool}` };
  }
  if (opts.confirmationId !== undefined && opts.confirmationId !== proposal.id) {
    return { ok: false, error: "confirmation id does not match the pending proposal" };
  }
  if (opts.args !== undefined && JSON.stringify(opts.args) !== JSON.stringify(proposal.args)) {
    return { ok: false, error: "args do not match the pending proposal" };
  }
  return { ok: true };
}
