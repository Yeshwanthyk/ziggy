/** A fake Pi runtime for driving the real chat handle: pass the session members a test exercises. */
import type { HandleRuntime, HandleSession } from "ziggy/session/handle";

const unused = (member: string) => () =>
  Promise.reject(new Error(`${member} is not part of this fake Pi runtime`));

export const fakePiRuntime = (
  session: Partial<HandleSession> & Pick<HandleSession, "sessionManager">,
): HandleRuntime => ({
  session: {
    // A getter, so a test can flip `isIdle` on its own object mid-test.
    get isIdle() {
      return session.isIdle ?? true;
    },
    sessionManager: session.sessionManager,
    model: session.model,
    thinkingLevel: session.thinkingLevel ?? "off",
    subscribe: session.subscribe ?? (() => () => undefined),
    bindExtensions: session.bindExtensions ?? (() => Promise.resolve()),
    waitForIdle: session.waitForIdle ?? (() => Promise.resolve()),
    navigateTree: session.navigateTree ?? unused("navigateTree"),
    reload: session.reload ?? unused("reload"),
    prompt: session.prompt ?? unused("prompt"),
    abort: session.abort ?? (() => Promise.resolve()),
    steer: session.steer ?? unused("steer"),
    followUp: session.followUp ?? unused("followUp"),
    sendCustomMessage: session.sendCustomMessage ?? unused("sendCustomMessage"),
    setModel: session.setModel ?? unused("setModel"),
    setThinkingLevel: session.setThinkingLevel ?? (() => undefined),
  },
  services: { modelRuntime: { getModel: () => undefined } },
  switchSession: unused("switchSession"),
  newSession: unused("newSession"),
  fork: unused("fork"),
  setRebindSession: () => undefined,
  dispose: () => Promise.resolve(),
});
