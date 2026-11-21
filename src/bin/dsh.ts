// The entry of @pixling/dsh-proxy: the plugin's name, inject and apply, and nothing else.
// The emote extension stays out of the way until the emote settings turn it on.
import { dshProxy } from '../adapters/dsh/index.ts';
import { EmoteExpression } from '../extensions/emote/index.ts';

export const { name, inject, apply } = dshProxy(EmoteExpression);
