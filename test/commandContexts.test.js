import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionContextType } from 'discord.js';

import story from '../commands/story.js';
import mystory from '../commands/mystory.js';
import storyadmin from '../commands/storyadmin.js';

// deploy-commands.js registers globally in production, and a global command with no `contexts`
// set is offered in DMs with the bot as well as in servers. Every command dead-ends on the
// guild guard there, so the payload must stay guild-only. This asserts the serialized body —
// what actually gets PUT to Discord — rather than the builder call.
describe('slash command contexts', () => {
  for (const command of [story, mystory, storyadmin]) {
    test(`/${command.data.name} is offered in servers only`, () => {
      const body = command.data.toJSON();
      assert.deepEqual(body.contexts, [InteractionContextType.Guild]);
    });
  }
});
