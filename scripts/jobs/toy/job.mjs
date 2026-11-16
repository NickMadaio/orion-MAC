/*
 Toy job: proves script step, bounded model slot, owner approval stop, and a
 final script that only runs for exactly the approved content. Nothing outward:
 the last step writes one file under the run's own artifacts folder.
*/
export default {
  name: 'toy',
  description: 'Stamp the time, have the local model write a greeting, ask the owner, write it to a scratch file.',
  model: 'qwen3.5:27b',
  inputs: { name: { maxLength: 40, default: 'Nick' } },
  steps: [
    { id: 'stamp', kind: 'script', command: 'date', args: () => ['-u', '+%FT%TZ'] },
    {
      id: 'greet', kind: 'slot',
      schema: { type: 'object', required: ['greeting'], additionalProperties: false,
        properties: { greeting: { type: 'string', minLength: 1, maxLength: 80 } } },
      prompt: ctx => `Write one short friendly greeting for the person named in ${ctx.quote(ctx.input.name)}, ` +
        `mentioning the time in ${ctx.quote(ctx.outputs.stamp.stdout)}. Reply as {"greeting": "..."}.`,
    },
    {
      id: 'approve', kind: 'approval', summary: 'Toy job: write this greeting to a scratch file',
      fields: ctx => ({ greeting: ctx.outputs.greet.greeting }),
    },
    {
      id: 'write', kind: 'script', command: 'toy-write', requireApproved: 'approve', outward: true,
      args: approved => [approved.greeting], // only what the owner approved
    },
  ],
};
