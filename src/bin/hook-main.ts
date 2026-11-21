// pixling-proxy's hook program. Started by hook.ts. A hook starts a process for every
// event, so the emote extension is loaded only once its settings turn it on; one that
// fails to load leaves the plain proxy, since a hook never fails out loud.
import { emoteConfig } from '../extensions/emote/config.ts';
import { startHook } from './hooks.ts';

const emote = emoteConfig() ? await import('../extensions/emote/index.ts').catch(() => null) : null;
startHook(emote?.EmoteExpression);
