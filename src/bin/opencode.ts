// The entry of @pixling/opencode-proxy: the plugin and nothing else, since a host may treat
// every function a plugin module exports as a plugin. The emote extension stays out of
// the way until the emote settings turn it on.
import { opencodeProxy } from '../adapters/opencode/index.ts';
import { EmoteExpression } from '../extensions/emote/index.ts';

export default opencodeProxy(EmoteExpression);
