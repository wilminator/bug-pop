// Scan a friend's room QR code with the camera, inside the game (Mike, 2026-11-22).
//
// Why in the game: on an iPhone, a QR code scanned with the Camera app opens Safari, not the Bug Pop
// app on the Home Screen, and the two keep separate sign-ins. Scanning here keeps the player in the
// app. Each frame is read on the device by jsQR (Apache-2.0), loaded only when scanning starts;
// nothing from the camera leaves the device.

/** A room code from what a QR code says: our join link (?room=ABCD) or just the 4 letters. */
export function roomFromQr(text: string): string | null {
  const t = text.trim();
  if (/^[A-Z]{4}$/i.test(t)) return t.toUpperCase();
  try {
    const code = new URL(t).searchParams.get('room')?.toUpperCase() ?? '';
    return /^[A-Z]{4}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Show the camera in `video` and read frames until a room QR code turns up (its code) or `stop()`
 * is called (null). Throws if there is no camera or the player says no to it.
 */
export function scanRoom(video: HTMLVideoElement): { found: Promise<string | null>; stop: () => void } {
  let stopped = false, stream: MediaStream | null = null, timer = 0;
  let finish: (code: string | null) => void = () => undefined;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    stream?.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    finish(null);
  };
  const found = new Promise<string | null>((resolve, reject) => {
    finish = resolve;
    void (async () => {
      try {
        const [{ default: jsQR }, media] = await Promise.all([
          import('jsqr'),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
        ]);
        stream = media;
        if (stopped) { stop(); return; }
        video.srcObject = media;
        video.setAttribute('playsinline', ''); // iPhone: play in place, not full screen
        await video.play();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const look = () => {
          if (stopped) return;
          const w = video.videoWidth, h = video.videoHeight;
          if (w && h) {
            // A smaller copy reads just as well and keeps older phones quick.
            const scale = Math.min(1, 640 / Math.max(w, h));
            canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            const code = qr && roomFromQr(qr.data);
            if (code) { finish(code); stop(); return; }
          }
          timer = window.setTimeout(look, 150);
        };
        look();
      } catch (e) {
        stop();
        reject(e);
      }
    })();
  });
  return { found, stop };
}
