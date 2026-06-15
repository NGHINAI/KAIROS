// composioSelfHeal.ts — wrap the Composio execute path with INLINE OAuth self-heal.
// composioClient.executeTool returns { successful:false, error } (it doesn't throw) when
// the toolkit isn't connected. Previously that NOT_CONNECTED just surfaced to the model;
// now we auto-connect the toolkit (browser OAuth + poll via SelfHealConnect) and retry
// ONCE, returning only the final result. Works for BOTH brains (the in-house loop AND
// opencode-via-/mcp both call __kairosComposioExecute). Daemon-side: the brain never
// sees redirect URLs/tokens — only the healed result (doc 01 §7).

/** Does a Composio result signal a missing connection? Conservative — only the
 *  not-connected family, not other tool errors (which should surface as-is). */
export function isNotConnectedResult(res: any): boolean {
  if (!res || typeof res !== "object") return false
  const failed = res.successful === false || res.success === false || res.ok === false || res.error != null
  if (!failed) return false
  const blob = JSON.stringify(res.error ?? res.message ?? res).toLowerCase()
  return /not[_ ]?connected|no connected account|no active connection|connect(ed)?[^.]{0,30}(account|first|the)|please connect|connection.*required/.test(blob)
}

/** Composio tool names are "<TOOLKIT>_<ACTION>" (e.g. GMAIL_SEND_EMAIL → gmail). */
export function toolkitFromToolName(name: string): string {
  return (String(name || "").split("_")[0] ?? "").toLowerCase()
}

interface SelfHealLike {
  connectAndRetry: (toolkit: string, retry: () => Promise<any>) => Promise<{ status: string; toolResult?: any }>
}

/** Wrap an execute(name,args) fn with inline self-heal. getSelfHeal is read lazily
 *  (the SelfHealConnect instance is constructed AFTER composioExecute in boot order). */
export function wrapComposioSelfHeal(opts: {
  execute: (name: string, args: any) => Promise<any>
  getSelfHeal: () => SelfHealLike | undefined
  log?: (m: string) => void
}): (name: string, args: any) => Promise<any> {
  return async (name: string, args: any) => {
    const run = () => opts.execute(name, args)
    const res = await run()
    if (!isNotConnectedResult(res)) return res
    const heal = opts.getSelfHeal()
    if (!heal?.connectAndRetry) return res
    const toolkit = toolkitFromToolName(name)
    try {
      const r = await heal.connectAndRetry(toolkit, run)
      if (r?.status === "connected") return r.toolResult
      opts.log?.(`self-heal ${toolkit} → ${r?.status ?? "unknown"}`)
      return res   // heal timed out / failed — return the original NOT_CONNECTED so the model can tell the user
    } catch (e) {
      opts.log?.(`self-heal error: ${String((e as Error)?.message ?? e)}`)
      return res
    }
  }
}
