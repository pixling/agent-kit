// The entry of @pixling/pi-proxy: the plugin and nothing else, since a host may treat
// every function a plugin module exports as a plugin. The emote extension stays out of
// the way until the emote settings turn it on.
import { piProxy } from '../adapters/pi/index.ts';
import { EmoteExpression } from '../extensions/emote/index.ts';

export default piProxy(EmoteExpression);
