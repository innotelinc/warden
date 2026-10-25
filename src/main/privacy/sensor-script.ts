/**
 * Camera and microphone treatment, built as a script for the page's main world.
 *
 * It wraps `getUserMedia` before any page script runs: the raw device track
 * never leaves this closure, and the page receives a canvas-captured video
 * track plus an audio track that has been through a Web Audio graph. It is all
 * local — no frame or sample leaves the machine — and a blocked sensor fails
 * the request the same way a denied permission does.
 */
import type { CameraMode, VoiceMode } from '@shared/sensors'
import { cameraPlan, voicePlan } from '@shared/sensors'

export interface SensorConfig {
  cameraMode: CameraMode
  cameraStrength: number
  voiceMode: VoiceMode
  cameraBlocked: boolean
  microphoneBlocked: boolean
}

export function sensorScript(config: SensorConfig): string {
  const camera = cameraPlan(config.cameraMode, config.cameraStrength)
  const voice = voicePlan(config.voiceMode)
  const payload = JSON.stringify({
    ...config,
    plan: camera,
    voice: voice
  })
  return `(() => {
  const cfg = ${payload};
  if (window.__wardenSensorShim) return;
  // navigator.mediaDevices is not there yet at document-start on every origin,
  // so installation is retried rather than abandoned: a page that asks for the
  // camera on its first tick must still get the treated track.
  const install = () => {
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') return false;
  const original = media.getUserMedia.bind(media);
  const live = [];

  const denied = (what) =>
    Promise.reject(new DOMException('WARDEN blocked ' + what + ' for this page', 'NotAllowedError'));

  function processVideo(track) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const scratch = document.createElement('canvas');
    const sctx = scratch.getContext('2d');
    let running = true;

    const frame = () => {
      if (!running) return;
      if (!video.videoWidth) return requestAnimationFrame(frame);
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        scratch.width = Math.max(1, Math.round(w / 8));
        scratch.height = Math.max(1, Math.round(h / 8));
      }

      if (cfg.plan.mode === 'pixelate') {
        sctx.drawImage(video, 0, 0, scratch.width, scratch.height);
        const blocks = Math.max(4, Math.round(scratch.width / cfg.plan.block));
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, 0, 0, blocks, Math.round(blocks * (h / w)), 0, 0, w, h);
      } else if (cfg.plan.mode === 'silhouette') {
        sctx.drawImage(video, 0, 0, scratch.width, scratch.height);
        const data = sctx.getImageData(0, 0, scratch.width, scratch.height);
        for (let i = 0; i < data.data.length; i += 4) {
          const luma = data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114;
          const on = luma > 74;
          data.data[i] = on ? 79 : 9;
          data.data[i + 1] = on ? 227 : 13;
          data.data[i + 2] = on ? 193 : 18;
          data.data[i + 3] = 255;
        }
        sctx.putImageData(data, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, 0, 0, scratch.width, scratch.height, 0, 0, w, h);
      } else if (cfg.plan.mode === 'portrait') {
        ctx.filter = 'blur(' + cfg.plan.blur + 'px)';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(w / 2, h * 0.46, w * 0.29, h * 0.42, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
      } else {
        ctx.filter = 'blur(' + cfg.plan.blur + 'px)';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const stream = canvas.captureStream(30);
    const out = stream.getVideoTracks()[0];
    live.push({ raw: track, out, stop: () => { running = false; track.stop(); } });
    return out;
  }

  function processAudio(track) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const context = new AudioCtor();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    let node = source;
    if (cfg.voice.lowpass) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cfg.voice.lowpass;
      node.connect(filter);
      node = filter;
    }
    if (cfg.voice.highpass) {
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = cfg.voice.highpass;
      node.connect(filter);
      node = filter;
    }
    if (cfg.voice.ringHz) {
      const ring = context.createGain();
      ring.gain.value = 1 - cfg.voice.ringDepth;
      const osc = context.createOscillator();
      osc.frequency.value = cfg.voice.ringHz;
      const depth = context.createGain();
      depth.gain.value = cfg.voice.ringDepth;
      osc.connect(depth);
      depth.connect(ring.gain);
      osc.start();
      node.connect(ring);
      node = ring;
    }
    node.connect(destination);
    const out = destination.stream.getAudioTracks()[0];
    live.push({ raw: track, out, stop: () => { track.stop(); void context.close(); } });
    return out;
  }

  media.getUserMedia = async function (constraints) {
    const wanted = constraints || {};
    if (cfg.cameraBlocked && wanted.video) return denied('camera');
    if (cfg.microphoneBlocked && wanted.audio) return denied('microphone');
    const stream = await original(constraints);
    const output = new MediaStream();
    for (const track of stream.getVideoTracks()) {
      output.addTrack(cfg.plan.mode === 'off' ? track : processVideo(track));
    }
    for (const track of stream.getAudioTracks()) {
      output.addTrack(cfg.voiceMode === 'off' ? track : processAudio(track));
    }
    window.__wardenSensors = {
      camera: cfg.plan.mode,
      voice: cfg.voiceMode,
      cameraBlocked: cfg.cameraBlocked,
      microphoneBlocked: cfg.microphoneBlocked,
      applied: (window.__wardenSensors ? window.__wardenSensors.applied : 0) + 1
    };
    window.addEventListener('pagehide', () => {
      for (const entry of live) {
        try { entry.stop(); } catch (e) {}
      }
    }, { once: true });
    return output;
  };
  Object.defineProperty(window, '__wardenSensorShim', { value: true });
  return true;
  };
  if (install()) return;
  let tries = 0;
  const wait = () => {
    if (install()) return;
    if (tries++ < 400) setTimeout(wait, 5);
  };
  setTimeout(wait, 0);
})()`
}
