/**
 * `read_playbook` (spec 2026-11-01 P2): one desk playbook's body — its steps, checks and answer shape — by name. The
 * system prompt lists every playbook in one line each; this opens the one that matches the question, so the full
 * steps cost tokens only on the turns that use them.
 *
 * Not a search: the input is the closed list of names (`z.enum`), so the model cannot ask for a file by path, and
 * the body is the repo's own text, never the trader's. Placed last in AGENT_TOOLS: adding it re-writes the cached
 * prefix once, and every tool before it keeps its place.
 */

import { z } from 'zod'
import { PLAYBOOK_NAMES, playbookOf } from '../playbooks.ts'
import { envelope, ToolRefusal, type AgentTool } from './ctx.ts'

const playbookInput = z.object({ name: z.enum(PLAYBOOK_NAMES).describe('A playbook name from the system prompt\'s list') }).strict()

const titleOf = (name: string): string => playbookOf(name)?.title ?? name

export const readPlaybook: AgentTool<z.infer<typeof playbookInput>> = {
  name: 'read_playbook',
  description: 'One desk playbook, by name from the system prompt\'s list: the steps, checks and answer shape for that kind of question, written from the desk\'s own trade record.',
  input: playbookInput,
  label: (i) => `reading the ${titleOf(i.name)} playbook`,
  async run(ctx, i) {
    const p = playbookOf(i.name)
    if (p === null) throw new ToolRefusal(`no playbook ${i.name}: the names are ${PLAYBOOK_NAMES.join(', ')}`)
    return { result: { ...envelope(ctx), name: p.name, title: p.title, body: p.body }, summary: p.title }
  },
}
