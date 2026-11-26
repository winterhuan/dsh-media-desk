/** Deliver graceful shutdown inside the fixture; Windows kill() always terminates forcibly. */
export function apply(ctx) {
  ctx.effect(() => {
    const stop = message => { if (message === 'media-desk-fixture-stop') process.emit('SIGTERM') }
    process.on('message', stop)
    process.channel?.unref()
    return () => process.off('message', stop)
  })
}
