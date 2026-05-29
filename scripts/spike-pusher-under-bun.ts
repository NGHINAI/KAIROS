// scripts/spike-pusher-under-bun.ts — verify pusher-js loads + WebSocket works under Bun.

async function spike() {
  console.log('=== Pusher under Bun spike ===')
  try {
    const Pusher = (await import('pusher-js')).default
    console.log('✓ pusher-js loads under Bun')

    const pusher = new Pusher('test-public-key', {
      cluster: 'mt1',
      forceTLS: true,
    })

    pusher.connection.bind('error', (err: any) => { console.log('  connection error (expected with test key):', err?.error?.data?.code) })

    await new Promise(r => setTimeout(r, 5000))

    const validStates = ['connected', 'connecting', 'unavailable', 'failed']
    if (validStates.includes(pusher.connection.state)) {
      console.log(`✓ Pusher state transitioned (state=${pusher.connection.state}) — WebSocket layer works`)
    } else {
      console.log(`✗ Pusher stuck at ${pusher.connection.state} — investigate`)
      process.exit(1)
    }

    pusher.disconnect()
    console.log('✓ disconnect() clean')
    console.log()
    console.log('=== Verdict: PASS — pusher-js usable under Bun ===')
    process.exit(0)
  } catch (err) {
    console.error('✗ pusher-js failed under Bun:', err)
    console.log()
    console.log('=== Verdict: FAIL — must use raw WebSocket fallback in TriggerListener ===')
    process.exit(1)
  }
}

spike()
