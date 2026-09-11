/**
 * The completion sound.
 *
 * Synthesised with WebAudio rather than shipped as an asset: two short notes
 * cost nothing to generate, add no bytes to the installer, and cannot be the
 * wrong sample rate. Off by default — unsolicited noise from a background app
 * is rude.
 */

let ctx: AudioContext | null = null;

/** A rising perfect fifth: A5 then E6. Short, quiet, and not alarming. */
export async function playChime(): Promise<void> {
  try {
    ctx ??= new AudioContext();
    // Browsers suspend a context created before any user gesture; resuming is
    // a no-op when it is already running.
    if (ctx.state === "suspended") await ctx.resume();

    const start = ctx.currentTime;
    for (const [index, frequency] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;

      const at = start + index * 0.11;
      // An exponential ramp to near-silence rather than a hard stop, which
      // would click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);

      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  } catch {
    // No audio device, or a policy that blocks it. A missing chime is never
    // worth an error message.
  }
}
