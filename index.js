// Host half of the Website Deep Recon bundle.
// It contributes two things and nothing else: a tool suite over one workspace
// ledger, and the `site-recon` skill that teaches the loop those tools serve.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools } from './lib/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const inject = ['tools'];

const SKILL = {
  name: 'site-recon',
  description:
    'Website deep reconnaissance: turn a question into covered source roles and interrogated claims, then write a report whose every assertion carries a verbatim quote. Use for product, market, documentation, competitor, or due-diligence research on the open web.',
  whenToUse:
    'The user asks you to research something on the website or the open web and wants an analysable answer rather than a link list — especially when they ask for evidence, breadth, depth, or a reusable method.',
};

function readSkill() {
  const file = path.join(here, 'skill', 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  // Strip optional YAML frontmatter: the registry carries those fields separately.
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

export function apply(ctx, config = {}) {
  const tools = createTools(ctx, config || {});
  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition));
  }

  const skills = ctx.get?.('skills');
  if (skills?.register) {
    ctx.effect(() => {
      let content;
      try {
        content = readSkill();
      } catch (error) {
        ctx.logger?.warn?.(`site-recon: cannot read skill/SKILL.md (${error.message})`);
        return () => {};
      }
      try {
        return skills.register({ ...SKILL, content, source: 'dsh-site-recon' });
      } catch (error) {
        // A duplicate name in this layer must not take the tools down with it.
        ctx.logger?.warn?.(`site-recon: skill not registered (${error.message})`);
        return () => {};
      }
    });
  }
}
